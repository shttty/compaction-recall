#!/usr/bin/env python3
"""Isolated OMP 18.4.11 boundary; stdin/stdout retain Pi RPC framing.

lme-native preserves native compaction defaults except enabled=false and
methodOrder=[snapcompact]; the parent owns four segments and three compactions.
coding-retired retains the historical zero-retention/sentinel policy.
Only generated blob artifacts persist in output_dir/omp-blobs; auth/config homes
remain ephemeral and session JSONL is never rewritten to rebind frame references.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

VERSION = "18.4.11"
SQLITE = "sqlite-8f154a333197c75bc1418ca44fc49e70ce5ebc00"
SQLITE_ROUND2 = "sqlite-b049c39df5613bab29afecfda95e67e6e2300b3c"
HERE = Path(__file__).resolve().parent
BLOB_REFERENCE = re.compile(r"blob:sha256:([a-f0-9]{64})")


def contained_target(filename, output):
    target = Path(filename).absolute()
    resolved = target.resolve()
    if not resolved.is_relative_to(output) or resolved == output:
        raise ValueError("Session/timing target must be inside configured output_dir")
    if not target.parent.is_dir():
        raise ValueError("Session/timing target parent must exist")
    return target


def session_blob_hashes(session):
    """Return native CAS hashes from persisted data fields without changing JSONL."""
    hashes = set()
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "data" and isinstance(item, str) and item.startswith("blob:sha256:"):
                    match = BLOB_REFERENCE.fullmatch(item)
                    if not match:
                        raise ValueError("Malformed OMP blob reference")
                    hashes.add(match[1])
                else:
                    visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    with Path(session).open(encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                visit(json.loads(line))
    return sorted(hashes)


def validate_session_blobs(session, blob_directory):
    """Fail closed on missing/corrupt external frames; never search another store."""
    root = Path(blob_directory).resolve(strict=True)
    hashes = session_blob_hashes(session)
    for digest in hashes:
        payload = root / digest
        if payload.is_symlink() or not payload.is_file():
            raise ValueError(f"Missing regular OMP blob {digest} in output blob store")
        with payload.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                raise ValueError(f"OMP blob SHA-256 mismatch for {digest}")
    return hashes


def prepare_launch(config_path, phase_name, session, plugin_entry=None, timing_file=None, append_system_prompt=None, replay_policy="coding-retired"):
    if replay_policy not in ("lme-native", "coding-retired"):
        raise ValueError("Unknown replay policy")
    config_path = Path(config_path).resolve(strict=True)
    config = json.loads(config_path.read_text())
    base = config_path.parent
    output = (base / config["output_dir"]).resolve(strict=True)
    if (output / "live-paused.json").exists():
        raise ValueError("Live model execution is paused by output_dir/live-paused.json")
    phase = config[phase_name]
    for key in ("provider", "model", "effort", "profile"):
        if not isinstance(phase.get(key), str) or not phase[key].strip():
            raise ValueError(f"Missing {phase_name}.{key}")
    profile = (base / phase["profile"]).resolve(strict=True)
    if output.is_relative_to(profile) or profile.is_relative_to(output):
        raise ValueError("Original profile and output_dir must be disjoint")
    session = contained_target(session, output)
    if not session.is_file():
        raise ValueError("OMP requires an existing explicit session")
    if phase_name == "compression" and (plugin_entry or timing_file or append_system_prompt):
        raise ValueError("Compression cannot load recall tools, recall timing, or appended answer requirements")
    if not isinstance(config.get("system_prompt"), str):
        raise ValueError("system_prompt must be a string")
    system_prompt = config["system_prompt"]
    if append_system_prompt:
        append_path = contained_target(append_system_prompt, output)
        system_prompt += "\n\n" + append_path.read_text()
    reserve = None
    if replay_policy == "coding-retired":
        reserve = config["protocol"]["reserve_tokens"]
        if isinstance(reserve, bool) or not isinstance(reserve, int) or reserve < 0:
            raise ValueError("protocol.reserve_tokens must be a nonnegative integer")
    resources = {name: profile / name for name in ("models.json", "auth.json")}
    if not all(path.is_file() for path in resources.values()):
        raise ValueError("Original models.json and auth.json resources are required")
    entry = Path(plugin_entry).resolve(strict=True) if plugin_entry else None
    sdk = (base / config["sdk_path"]).resolve(strict=True)
    archive = entry.parent.parent if entry else None
    if entry and (archive.name not in (SQLITE, SQLITE_ROUND2) or entry != archive / "benchmark/retrieval-sqlite-adapter.ts"):
        raise ValueError("OMP recall requires the exact pinned SQLite archive entry")
    tool_evidence = None
    if config.get("tool_evidence") is not None:
        requested = config["tool_evidence"]
        if not entry or phase_name != "answer":
            raise ValueError("Tool evidence requires an answer-phase recall plugin")
        if not isinstance(requested, dict) or set(requested) - {"evidencePath", "expectedPath", "stopAfterSerialization"}:
            raise ValueError("Invalid tool_evidence options")
        evidence_path = requested.get("evidencePath")
        if not isinstance(evidence_path, str) or not evidence_path:
            raise ValueError("tool_evidence.evidencePath must be a path")
        tool_evidence = {"evidencePath": str(contained_target(base / evidence_path, output))}
        if requested.get("expectedPath") is not None:
            expected_path = requested["expectedPath"]
            if not isinstance(expected_path, str) or not expected_path:
                raise ValueError("tool_evidence.expectedPath must be a path")
            expected = contained_target(base / expected_path, output)
            if not expected.is_file() or expected.resolve() == Path(tool_evidence["evidencePath"]).resolve():
                raise ValueError("Expected tool evidence must exist and differ from the output evidence")
            tool_evidence["expectedPath"] = str(expected)
        stop = requested.get("stopAfterSerialization", False)
        if not isinstance(stop, bool):
            raise ValueError("tool_evidence.stopAfterSerialization must be a boolean")
        tool_evidence["stopAfterSerialization"] = stop
    binding = None
    if entry:
        binding = archive / "node_modules/@node-rs/jieba-linux-x64-gnu/jieba.linux-x64-gnu.node"
        if not binding.is_file():
            raise ValueError("Pinned Jieba native binding is unavailable")
    timing = contained_target(timing_file, output) if timing_file else None
    blob_directory = output / "omp-blobs"
    if blob_directory.is_symlink():
        raise ValueError("Output blob store must not be a symlink")
    blob_directory.mkdir(mode=0o700, exist_ok=True)
    input_blobs = validate_session_blobs(session, blob_directory)
    home = Path(tempfile.mkdtemp(prefix=".omp-runtime-", dir=output))
    try:
        agent, cwd = home / "agent", home / "cwd"
        agent.mkdir(mode=0o700); cwd.mkdir(mode=0o700)
        # The host loads original resources itself. Never deserialize credentials or models.
        (agent / "models.yml").symlink_to(resources["models.json"])
        (agent / "auth.json").symlink_to(resources["auth.json"])
        # Installed OMP's explicit agent override resolves Lk() to agent/blobs.
        # Rebind just that noncredential store; runtime auth/config remain isolated.
        (agent / "blobs").symlink_to(blob_directory, target_is_directory=True)
        compaction = {"enabled": False, "methodOrder": ["snapcompact"]}
        if replay_policy == "coding-retired":
            compaction.update(keepRecentTokens=0, reserveTokens=reserve,
                              asyncEnabled=False, midTurnEnabled=False, idleEnabled=False,
                              autoContinue=False, supersedeReads=False, dropUseless=False)
        settings = {
            "compaction": compaction,
            "retry": {"enabled": False, "modelFallback": False, "fallbackChains": {}},
            "providers": {"cacheWarming": "off"},
            "contextPromotion": {"enabled": False},
            "advisor": {"enabled": False},
            "prewalk": {"enabled": False},
        }
        overlay = home / "config.yml"
        overlay.write_text(json.dumps(settings))
        env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ") if key in os.environ}
        env.update({"HOME": str(home), "USERPROFILE": str(home),
                    "PI_CODING_AGENT_DIR": str(agent), "XDG_CONFIG_HOME": str(home / "config"),
                    "XDG_CACHE_HOME": str(home / "cache"), "XDG_DATA_HOME": str(home / "data"),
                    "TMPDIR": str(home), "PI_OFFLINE": "1", "DO_NOT_TRACK": "1",
                    "CODING_E2E_GUARD_FILE": str(home / "guard.json"),
                    "CODING_E2E_REPLAY_POLICY": replay_policy,
                    "CODING_E2E_EXPECTED_CWD": str(cwd)})
        metadata = {"version": VERSION, "phase": phase_name, "replayPolicy": replay_policy, "settings": settings,
                    "credentialAccess": "host-only original resource symlinks",
                    "modelResourceFormat": "models.yml linked to original models.json",
                    "blobStore": {"directory": str(blob_directory), "layout": "sha256-flat",
                                  "verifiedInputHashes": input_blobs}}
        if entry:
            env.update({"CODING_E2E_PLUGIN_ENTRY": str(entry), "CODING_E2E_SDK_PATH": str(sdk),
                        "COMPACTION_RECALL_SQLITE_ARM": "porter-jieba",
                        "COMPACTION_RECALL_AUTO_GATE": "280",
                        "NAPI_RS_NATIVE_LIBRARY_PATH": str(binding)})
            metadata["nativeBinding"] = {"path": str(binding), "resolvedPath": str(binding.resolve()), "sha256": hashlib.sha256(binding.read_bytes()).hexdigest(), "jiebaVersion": "2.0.3"}
            metadata["pluginArchive"] = archive.name
            if tool_evidence:
                env["CODING_E2E_TOOL_EVIDENCE"] = json.dumps(tool_evidence)
                metadata["toolEvidence"] = tool_evidence
        if timing:
            env["COMPACTION_RECALL_TIMING_FILE"] = str(timing)
        command = ["omp", "--mode", "rpc", "--no-ui", "--no-tools", "--no-lsp",
                   "--no-extensions", "--no-skills", "--no-rules", "--no-title",
                   "--no-prewalk", "--model", f"{phase['provider']}/{phase['model']}",
                   "--thinking", phase["effort"], "--system-prompt", system_prompt,
                   "--cwd", str(cwd), "--config", str(overlay), "--resume", str(session),
                   "--session-dir", str(session.parent), "--extension", str(HERE / "omp-extension.mjs")]
        return {"command": command, "env": env, "home": home, "cwd": cwd,
                "session": session, "phase": phase, "metadata": metadata, "output": output,
                "blob_directory": blob_directory}
    except BaseException:
        shutil.rmtree(home)
        raise


def validate_state(event, launch):
    if not event.get("success"):
        raise ValueError("OMP RPC readiness failed")
    state = event.get("data", {})
    model = state.get("model", {})
    phase = launch["phase"]
    if model.get("provider") != phase["provider"] or model.get("id") != phase["model"] or state.get("thinkingLevel") != phase["effort"]:
        raise ValueError("OMP resolved a different configured provider/model/effort")
    for key in ("contextWindow", "maxTokens"):
        if isinstance(model.get(key), bool) or not isinstance(model.get(key), int) or model[key] <= 0:
            raise ValueError(f"OMP model has invalid {key}")
    if state.get("autoCompactionEnabled") is not False:
        raise ValueError("OMP automatic compaction was not disabled")
    if Path(state.get("sessionFile", "")).resolve() != launch["session"].resolve():
        raise ValueError("OMP did not resume the explicit benchmark session")
    guard = Path(launch["env"]["CODING_E2E_GUARD_FILE"])
    if not guard.is_file():
        raise ValueError("OMP boundary extension did not initialize")
    guard_data = json.loads(guard.read_text())
    expected = ["history_expand", "history_grep", "history_recall"] if "CODING_E2E_PLUGIN_ENTRY" in launch["env"] else []
    if guard_data.get("activeTools") != expected or guard_data.get("cwd") != str(launch["cwd"]):
        raise ValueError("OMP tool/cwd isolation check failed")
    effective = guard_data.get("effectiveSettings", {})
    requested = launch["metadata"]["settings"]
    expected_settings = {"compaction.methodOrder": ["snapcompact"], "compaction.enabled": False,
                         "retry.enabled": False, "retry.modelFallback": False}
    if launch["metadata"]["replayPolicy"] == "coding-retired":
        expected_settings.update({"compaction.keepRecentTokens": 0,
                                  "compaction.reserveTokens": requested["compaction"]["reserveTokens"]})
    if any(effective.get(key) != value for key, value in expected_settings.items()):
        raise ValueError("OMP effective compaction/retry settings differ from the requested benchmark settings")
    state["codingE2E"] = {**launch["metadata"], "effectiveSettings": effective}
    return event


def compact_evidence(event, session, guard_file=None, blob_directory=None):
    if guard_file:
        preparation = json.loads(Path(guard_file).read_text()).get("preparation")
        if preparation:
            event.setdefault("data", {})["codingE2EPreparation"] = preparation
    if not event.get("success"):
        return event
    entries = [json.loads(line) for line in session.read_text().split("\n") if line.strip()]
    compact = next((entry for entry in reversed(entries) if entry.get("type") == "compaction"), None)
    if not compact or compact.get("method") != "snapcompact":
        raise ValueError("OMP compaction did not persist the required snapcompact method")
    event.setdefault("data", {})["codingE2ECompaction"] = {
        key: compact.get(key) for key in ("id", "firstKeptEntryId", "tokensBefore", "tokensAfter", "method")
    }
    if blob_directory:
        event["data"]["codingE2EBlobs"] = {
            "directory": str(blob_directory), "verifiedHashes": validate_session_blobs(session, blob_directory)
        }
    return event


def run_boundary(launch):
    if (launch["output"] / "live-paused.json").exists():
        raise ValueError("Live model execution is paused by output_dir/live-paused.json")
    version = subprocess.run(["omp", "--help"], env=launch["env"], cwd=launch["cwd"], capture_output=True, text=True, timeout=30)
    if version.returncode or not version.stdout.startswith(f"omp v{VERSION}\n"):
        raise ValueError(f"Boundary requires installed OMP {VERSION}")
    if (launch["output"] / "live-paused.json").exists():
        raise ValueError("Live model execution is paused by output_dir/live-paused.json")
    child = subprocess.Popen(launch["command"], env=launch["env"], cwd=launch["cwd"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
                             text=True, bufsize=1)
    events = queue.Queue()
    def reader(stream, kind):
        for line in stream:
            events.put((kind, line))
        events.put((kind, None))
    threading.Thread(target=reader, args=(child.stdout, "out"), daemon=True).start()
    threading.Thread(target=reader, args=(sys.stdin, "in"), daemon=True).start()
    ready_id = "coding-e2e-internal-ready"
    child.stdin.write(json.dumps({"id": ready_id, "type": "get_state"}) + "\n"); child.stdin.flush()
    pending, validated, input_closed = [], False, False
    deadline = time.monotonic() + 60
    allowed = {"get_state", "get_messages", "get_session_stats", "get_last_assistant_text", "get_branch_messages", "abort"}
    allowed.add("compact" if launch["metadata"]["phase"] == "compression" else "prompt")
    try:
        while True:
            if not validated and time.monotonic() >= deadline:
                raise ValueError("OMP readiness timeout")
            try:
                kind, line = events.get(timeout=0.1)
            except queue.Empty:
                continue
            if kind == "in":
                if line is None:
                    input_closed = True
                    if validated:
                        child.stdin.close()
                else:
                    command = json.loads(line)
                    if command.get("type") not in allowed or command.get("id") == ready_id:
                        sys.stdout.write(json.dumps({"id": command.get("id"), "type": "response", "command": command.get("type"), "success": False, "error": "Unsupported benchmark RPC command"}) + "\n"); sys.stdout.flush()
                    elif validated:
                        child.stdin.write(line); child.stdin.flush()
                    else:
                        pending.append(line)
                continue
            if line is None:
                if not validated:
                    raise ValueError("OMP exited before validated readiness")
                break
            try:
                event = json.loads(line)
            except ValueError as error:
                raise ValueError("OMP emitted non-JSON stdout") from error
            if event.get("id") == ready_id and event.get("type") == "response":
                validate_state(event, launch)
                validated = True
                for item in pending:
                    child.stdin.write(item)
                child.stdin.flush(); pending.clear()
                if input_closed:
                    child.stdin.close()
                continue
            if event.get("type") == "response" and event.get("command") == "get_state":
                validate_state(event, launch)
            if event.get("type") == "response" and event.get("command") == "compact":
                compact_evidence(event, launch["session"], launch["env"]["CODING_E2E_GUARD_FILE"],
                                 launch["blob_directory"])
            sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n"); sys.stdout.flush()
        return child.wait(timeout=10)
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()
        if not child.stdin.closed:
            child.stdin.close()
        child.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--phase", choices=("compression", "answer"), required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--plugin-entry")
    parser.add_argument("--timing-file")
    parser.add_argument("--append-system-prompt", help="Generated answer requirements file inside output_dir (answer only)")
    parser.add_argument("--replay-policy", choices=("lme-native", "coding-retired"), default="coding-retired",
                        help="LME preserves native compaction defaults; retired coding enforces segment sentinels")
    args = parser.parse_args()
    launch = None
    try:
        launch = prepare_launch(args.config, args.phase, args.session, args.plugin_entry,
                                args.timing_file, args.append_system_prompt, args.replay_policy)
        return run_boundary(launch)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"omp-rpc: {error}", file=sys.stderr)
        return 1
    finally:
        if launch:
            shutil.rmtree(launch["home"])


if __name__ == "__main__":
    sys.exit(main())
