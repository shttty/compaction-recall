"""Offline synthetic fixtures only: no benchmark data, real providers, or historical Git objects."""
import contextlib
import copy
import importlib.util
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("evaluate", ROOT / "benchmark/evaluate.py")
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)

# Deliberately synthetic external helper, not the official benchmark implementation.
# Bootstrap must never execute, even though its selected AST definitions are used.
HELPER = '''
raise RuntimeError("synthetic top-level .env/provider bootstrap must never run")
DEV8 = ("synthetic-q",)
ASK = "Synthetic question: {} / {}"
_BASE = "Synthetic judge: "
_STEPS = ""
_TAIL = "{} / {} / {}"
JUDGE = {"multi-session": _BASE + _STEPS + _TAIL}
ABSTAIN = _BASE + _TAIL
CHARS_PER_TOKEN = 4.0

def parse_date(value):
    return datetime.strptime(value, "%Y/%m/%d %H:%M").replace(tzinfo=timezone.utc)

def iso(value):
    return value.isoformat()

def build_session(q, path, pi=False):
    rows = [{"type": "session", "version": 3, "id": "synthetic-session", "cwd": str(RUNS)}]
    parent = None
    for when, turns in sorted(zip(q["haystack_dates"], q["haystack_sessions"]), key=lambda pair: parse_date(pair[0])):
        if turns[0]["role"] != "user":
            turns = [{"role": "user", "content": "Synthetic date header"}] + turns
        for turn in turns:
            ident = str(len(rows))
            rows.append({"type": "message", "id": ident, "parentId": parent,
                         "message": {"role": turn["role"], "model": MODEL,
                                     "content": [{"type": "text", "text": turn["content"]}]}})
            parent = ident
    path.write_text("\\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\\n", encoding="utf-8")

def chunk_cuts(rows, parts):
    return [len(rows) * index // parts for index in range(1, parts)]

def jsonl_lines(path):
    return [line for line in path.read_text(encoding="utf-8").split("\\n") if line]

def append_entries(path, chunk):
    with path.open("a", encoding="utf-8") as stream:
        stream.write("\\n".join(chunk) + "\\n")
'''


class EvaluationRunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-evaluation-")
        self.home = Path(self.temp.name)
        self.addCleanup(self.cleanup)
        self.helper = self.home / "synthetic-helper.py"
        self.helper.write_text(HELPER, encoding="utf-8")
        self.question = {"question_id": "synthetic-q", "question_type": "multi-session", "question": "Synthetic question?",
                         "question_date": "2024/01/02 00:00", "haystack_dates": ["2024/01/01 00:00"],
                         "haystack_sessions": [[{"role": "user", "content": f"Synthetic turn {i}: 日本語\u2028保留\u2029", "has_answer": i in (0, 2)} for i in range(8)]],
                         "answer": "Synthetic answer"}
        self.data = self.home / "synthetic-data.json"
        self.data.write_text(json.dumps([self.question]), encoding="utf-8")
        profile = self.home / "synthetic-profile"
        profile.mkdir()
        for name in ("models.json", "auth.json"):
            (profile / name).write_text("{}", encoding="utf-8")
        self.repo = self.home / "synthetic-repository"
        self.repo.mkdir()
        (self.repo / "src").mkdir()
        (self.repo / "package.json").write_text(json.dumps({"name": "synthetic-fixture-not-a-benchmark", "pi": {"extensions": ["./src/index.ts"]}}))
        (self.repo / "src/index.ts").write_text('export { default } from "./recall-extension.ts";\n')
        (self.repo / "src/recall-extension.ts").write_text('export default function syntheticFixture() {}\n')
        self.git("init", "--quiet")
        self.git("add", ".")
        self.git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "Synthetic offline fixture, not benchmark")
        self.commit = self.git("rev-parse", "HEAD").strip()
        self.config = {"sdk_path": str(ROOT / "node_modules/@earendil-works/pi-coding-agent"),
                       "helper_path": str(self.helper), "data_path": str(self.data), "output_dir": str(self.home / "output"),
                       "candidate_repo": str(self.repo), "system_prompt": "Synthetic fixture only",
                       "protocol": {"segments": 4, "reserve_tokens": 100, "overhead_tokens": 10}}
        for phase in ("compression", "answer", "judge"):
            self.config[phase] = {"provider": "synthetic-alpha", "model": "synthetic-one", "effort": "low", "profile": str(profile)}
        self.config_path = self.home / "config.json"
        self.save_config()
        self.calls = []
        self.real_subprocess_run = subprocess.run
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(e.subprocess, "run", side_effect=self.process))
        self.stack.enter_context(patch.object(e.rpc, "run_rpc", side_effect=self.rpc))
        self.stack.enter_context(patch.object(e, "compact", self.compact))
        # Stream-reader seam only; fixture has one tiny record, never real M data.
        self.stack.enter_context(patch.object(e, "records", side_effect=lambda path: iter(json.loads(Path(path).read_text()))))

    def cleanup(self):
        for path in self.home.rglob("*"):
            if not path.is_symlink():
                path.chmod(0o700 if path.is_dir() else 0o600)
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True, text=True).stdout

    def save_config(self):
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")

    def process(self, command, **kwargs):
        if "--describe" in command:
            config = json.loads(Path(command[command.index("--config") + 1]).read_text())
            phase = command[command.index("--phase") + 1]
            result = {key: config[phase][key] for key in ("provider", "model", "effort")}
            result.update(contextWindow=20000, maxTokens=1000, sdk_version="synthetic")
            return subprocess.CompletedProcess(command, 0, json.dumps(result), "")
        return self.real_subprocess_run(command, **kwargs)

    def compact(self, session, env, cwd):
        self.calls.append(("compression", copy.deepcopy(e.CONFIG["compression"])))
        return {"success": True, "timing": {"processWallMs": 1}}

    def rpc(self, command, env, cwd, *, prompt, timeout):
        config = json.loads(Path(command[command.index("--config") + 1]).read_text())
        phase = command[command.index("--phase") + 1]
        session = Path(command[command.index("--session") + 1])
        arm = command[command.index("--arm") + 1] if "--arm" in command else "judge"
        self.calls.append((phase, config[phase], arm, prompt, command, env))
        text = "yes" if phase == "judge" else "Synthetic answer 日本語\u2028保留\u2029"
        row = {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": text}], "stopReason": "stop"}}
        with session.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        return {"outcome": "completed", "timing": {"modelTurns": 1}, "rc": 0, "stderr": ""}

    def prepare(self):
        e.main(["--config", str(self.config_path), "prepare", "--set", "dev8"])

    def run_fixture(self):
        e.main(["run", "--config", str(self.config_path), "--set", "dev8", "--run", "synthetic-run", "--plugin-ref", self.commit])

    def test_main_real_run_real_answer_rpc_boundary_and_zero_call_resume(self):
        for provider, model, effort in (("synthetic-alpha", "synthetic-one", "low"), ("synthetic-beta", "synthetic-two", "high")):
            with self.subTest(provider=provider):
                self.config["output_dir"] = str(self.home / provider)
                for phase in ("compression", "answer", "judge"):
                    self.config[phase].update(provider=provider, model=model, effort=effort)
                self.save_config(); self.prepare(); self.calls.clear(); self.run_fixture()
                answers = [call for call in self.calls if call[0] == "answer"]
                self.assertEqual([call[2] for call in answers], ["native", "grep", "production"])
                self.assertEqual([call[0] for call in self.calls].count("compression"), 3)
                self.assertEqual([call[0] for call in self.calls].count("judge"), 3)
                for call in answers:
                    self.assertEqual((call[1]["provider"], call[1]["model"], call[1]["effort"]), (provider, model, effort))
                    self.assertIn("Synthetic question?", call[3])
                ledger = e.jsonl_records(Path(self.config["output_dir"]) / "runs/synthetic-run/results.jsonl")
                self.assertEqual([row["judge"]["correct"] for row in ledger], [True, True, True])
                self.assertTrue(all("日本語\u2028保留\u2029" in row["answer"] for row in ledger))
                self.calls.clear(); self.run_fixture(); self.assertEqual(self.calls, [])

    def test_changed_config_and_input_contents_refuse_resume(self):
        self.prepare(); self.run_fixture(); self.calls.clear()
        original = copy.deepcopy(self.config)
        mutations = [("system_prompt", "different synthetic prompt"), ("protocol", {"segments": 5, "reserve_tokens": 100, "overhead_tokens": 10})]
        for phase in ("compression", "answer", "judge"):
            for key in ("provider", "model", "effort"):
                changed = copy.deepcopy(original[phase]); changed[key] += "-changed"
                mutations.append((phase, changed))
        for key in ("reserve_tokens", "overhead_tokens"):
            changed = copy.deepcopy(original["protocol"]); changed[key] += 1
            mutations.append(("protocol", changed))
        for key in ("helper_path", "data_path"):
            copied = self.home / ("copied-" + Path(original[key]).name)
            shutil.copyfile(original[key], copied)
            mutations.append((key, str(copied)))
        copied_repo = self.home / "copied-synthetic-repository"
        shutil.copytree(self.repo, copied_repo)
        mutations.append(("candidate_repo", str(copied_repo)))
        copied_profile = self.home / "copied-synthetic-profile"
        shutil.copytree(original["answer"]["profile"], copied_profile)
        for phase in ("compression", "answer", "judge"):
            changed = copy.deepcopy(original[phase]); changed["profile"] = str(copied_profile)
            mutations.append((phase, changed))
        copied_sdk = self.home / "synthetic-sdk-package-identity-only"
        copied_sdk.mkdir()
        shutil.copyfile(Path(original["sdk_path"]) / "package.json", copied_sdk / "package.json")
        mutations.append(("sdk_path", str(copied_sdk)))
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                self.config = copy.deepcopy(original); self.config[key] = value; self.save_config()
                with self.assertRaisesRegex(RuntimeError, "changed|manifest"):
                    self.run_fixture()
                self.assertEqual(self.calls, [])
        self.config = original; self.save_config()
        for path in (self.helper, self.data, Path(original["answer"]["profile"]) / "models.json", Path(original["judge"]["profile"]) / "auth.json"):
            payload = path.read_bytes()
            with self.subTest(path=path):
                path.write_bytes(payload + b"\n")
                with self.assertRaisesRegex(RuntimeError, "changed"):
                    self.run_fixture()
                path.write_bytes(payload)
                self.assertEqual(self.calls, [])
        previous_path = self.config_path
        self.config_path = self.home / "copied-config.json"; self.save_config()
        with self.assertRaisesRegex(RuntimeError, "changed"):
            self.run_fixture()
        self.config_path = previous_path
        self.assertEqual(self.calls, [])

    def test_missing_invalid_config_and_resources_fail_before_provider_calls(self):
        with self.assertRaises(SystemExit):
            e.main(["prepare"])
        original = copy.deepcopy(self.config)
        for key in original:
            self.config = copy.deepcopy(original); self.config.pop(key); self.save_config()
            with self.subTest(missing=key), self.assertRaises(ValueError):
                self.prepare()
        self.config = original; self.config["unknown"] = True; self.save_config()
        with self.assertRaises(ValueError):
            self.prepare()
        self.config = original; self.config.pop("unknown"); self.save_config()
        for path in (self.helper, self.data, Path(self.config["answer"]["profile"]) / "models.json", Path(self.config["answer"]["profile"]) / "auth.json"):
            payload = path.read_bytes(); path.unlink()
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.prepare()
            path.write_bytes(payload)
        self.assertEqual(self.calls, [])
        self.config["sdk_path"] = str(self.home / "missing-sdk"); self.save_config()
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.calls, [])

    def test_helper_top_level_unicode_chunk_labels_and_snapshot_protection(self):
        self.prepare()
        self.assertFalse(hasattr(e.b, "chat"))
        session = self.home / "unicode.jsonl"
        e.write_session(session, self.question)
        self.assertEqual(len(e.b.jsonl_lines(session)), 9)
        self.assertIn("日本語\u2028保留\u2029", session.read_text())
        self.assertEqual(e.labeled_evidence_segments(self.question), [1, 2])
        self.assertNotIn("has_answer", json.dumps(e.serializable_question(self.question)))
        self.run_fixture(); self.calls.clear()
        snapshot = next((Path(self.config["output_dir"]) / "snapshots").glob("*/synthetic-q.jsonl"))
        snapshot.write_text(snapshot.read_text() + "{}\n")
        with self.assertRaisesRegex(RuntimeError, "validated snapshot"):
            self.run_fixture()
        self.assertEqual(self.calls, [])

    def test_compression_source_change_rejects_saved_snapshot(self):
        self.prepare(); self.run_fixture(); self.calls.clear()
        def changed_compact(session, env, cwd):
            raise AssertionError("Protected compression source must not execute on resume")
        with patch.object(e, "compact", changed_compact), self.assertRaisesRegex(RuntimeError, "validated snapshot"):
            self.run_fixture()
        self.assertEqual(self.calls, [])

    def test_compression_actual_rpc_uses_explicit_phase(self):
        self.prepare()
        captured = []
        class SyntheticProcess:
            # Offline scripted child transport, not an application provider.
            def __init__(self, command, **kwargs):
                captured.append(command)
                self.stdin = io.StringIO()
                self.stdout = io.StringIO('{"id":"ready","type":"response","success":true}\n{"id":"compact","type":"response","success":true}\n')
                self.stderr = io.StringIO()
                self.returncode = 0
            def wait(self, timeout=None):
                return 0
        # Load a fresh module so compact is the production function, not the pipeline seam.
        fresh = importlib.util.module_from_spec(spec); spec.loader.exec_module(fresh)
        with patch.object(fresh, "CONFIG_PATH", e.CONFIG_PATH), patch.object(fresh, "CONFIG", e.CONFIG), \
             patch.object(fresh, "preflight", return_value=123), patch.object(fresh.subprocess, "Popen", SyntheticProcess):
            result = fresh.compact(self.home / "synthetic-session.jsonl", {}, self.home)
        self.assertTrue(result["success"])
        self.assertEqual(captured[0][captured[0].index("--phase") + 1], "compression")
        self.assertEqual(captured[0][captured[0].index("--config") + 1], str(e.CONFIG_PATH))

    def test_ambiguous_answer_and_judge_attempts_are_not_replayed(self):
        self.prepare(); self.run_fixture()
        base = Path(self.config["output_dir"]) / "runs/synthetic-run"
        ledger_path = base / "results.jsonl"
        rows = e.jsonl_records(ledger_path)
        ledger_path.write_text("".join(json.dumps(row) + "\n" for row in rows if row["arm"] != "native"))
        arm = base / "native/synthetic-q"
        (arm / "judge.json").unlink()
        for state_name in ("judge-inflight", "answer-inflight"):
            state = json.loads((arm / "status.json").read_text()); state["state"] = state_name
            e.write_json(arm / "status.json", state)
            if state_name == "answer-inflight":
                (arm / "answer.json").unlink()
            self.calls.clear()
            with self.assertRaisesRegex(RuntimeError, "ambiguous"):
                self.run_fixture()
            self.assertEqual(self.calls, [])

    def test_pin_actual_manifest_entry_and_tamper_rejection(self):
        self.prepare()
        pinned, manifest = e.pin_plugin(self.commit)
        self.assertEqual(manifest["entry"], "src/index.ts")
        self.assertEqual((pinned / "src/index.ts").read_bytes(), (self.repo / "src/index.ts").read_bytes())
        with self.assertRaises(ValueError):
            e.pin_plugin("HEAD")
        target = pinned / "src/recall-extension.ts"
        target.chmod(0o600); target.write_text("tampered synthetic fixture")
        with self.assertRaisesRegex(RuntimeError, "changed"):
            e.pin_plugin(self.commit)

    def test_historical_root_layout_uses_manifest_not_whitelist(self):
        self.prepare()
        package = {"name": "synthetic-root-layout-not-benchmark", "pi": {"extensions": ["./index.ts"]}}
        (self.repo / "package.json").write_text(json.dumps(package))
        shutil.copyfile(self.repo / "src/index.ts", self.repo / "index.ts")
        shutil.copyfile(self.repo / "src/recall-extension.ts", self.repo / "recall-extension.ts")
        self.git("add", ".")
        self.git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "Synthetic root-layout fixture")
        commit = self.git("rev-parse", "HEAD").strip()
        pinned, manifest = e.pin_plugin(commit)
        self.assertEqual(manifest["entry"], "index.ts")
        self.assertEqual(set(manifest["runtime_closure"]), {"index.ts", "recall-extension.ts"})
        self.assertTrue((pinned / "recall-extension.ts").is_file())

    def test_ambiguous_compaction_checkpoint_refuses_replay(self):
        self.prepare()
        digest = e.object_sha(self.question)
        key, _ = e.fingerprint(self.question, digest)
        folder = e.EVAL_HOME / "snapshots" / key
        folder.mkdir(parents=True)
        e.write_json(folder / "progress.json", {"fingerprint": key, "state": "inflight"})
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            e.prepare_snapshot(self.question, digest, e.EVAL_HOME / "snapshots", e.EVAL_HOME)
        self.assertEqual(self.calls, [])

    def test_helper_unsupported_shapes_and_output_overlap_fail_closed(self):
        self.helper.write_text(HELPER.replace("CHARS_PER_TOKEN = 4.0", "CHARS_PER_TOKEN = open('never-read')"))
        with self.assertRaisesRegex(ValueError, "Unsupported helper"):
            self.prepare()
        self.helper.write_text(HELPER)
        self.config["output_dir"] = self.config["answer"]["profile"]; self.save_config()
        with self.assertRaisesRegex(ValueError, "overlap"):
            self.prepare()
        self.assertEqual(self.calls, [])

    def test_environment_and_verdict_fail_closed(self):
        source = {"PATH": "/bin", "HOME": "/synthetic-home", "HERDR_ENV": "1", "OPENAI_API_KEY": "synthetic-secret", "PI_CODING_AGENT_DIR": "/synthetic-profile"}
        self.assertEqual(e.child_env(source), {"PATH": "/bin"})
        self.assertIn("HOME", source)
        self.assertIs(e.parse_verdict(" yes. "), True)
        self.assertIs(e.parse_verdict("NO"), False)
        self.assertIsNone(e.parse_verdict("No, but yes"))
        self.assertIsNone(e.parse_verdict(""))

    def test_help_has_no_external_dependencies(self):
        with patch.object(e, "configure", side_effect=AssertionError("help loaded configuration")):
            for arguments in (["--help"], ["run", "--help"], ["pin", "--help"], ["prepare", "--help"]):
                with self.subTest(arguments=arguments), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as caught:
                    e.main(arguments)
                self.assertEqual(caught.exception.code, 0)

    def test_answer_arguments_start_all_real_sdk_arms_without_model_requests(self):
        # Synthetic external profile; only get_state is sent at the RPC boundary.
        profile = Path(self.config["answer"]["profile"])
        for phase in ("compression", "answer", "judge"):
            self.config[phase].update(provider="synthetic-offline", model="fixture-model", effort="off")
        (profile / "models.json").write_text(json.dumps({"providers": {"synthetic-offline": {
            "api": "openai-completions", "baseUrl": "https://benchmark.invalid/v1",
            "models": [{"id": "fixture-model", "name": "Offline fixture", "reasoning": False,
                        "input": ["text"], "contextWindow": 16384, "maxTokens": 2048,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}))
        (profile / "auth.json").write_text(json.dumps({"synthetic-offline": {"type": "api_key", "key": "synthetic-only"}}))
        self.save_config(); self.prepare()
        pinned, _ = e.pin_plugin(self.commit)
        wrapper, _ = e.pin_wrapper()
        snapshot = e.EVAL_HOME / "synthetic-empty-session.jsonl"
        snapshot.write_text("")
        guard = self.home / "network-guard.mjs"
        guard.write_text("import net from 'node:net';import tls from 'node:tls';"
                         "const blocked=()=>{process.stderr.write('network forbidden');process.exit(97)};"
                         "net.Socket.prototype.connect=blocked;tls.connect=blocked;globalThis.fetch=blocked;")
        real_spec = importlib.util.spec_from_file_location("real_rpc_fixture", ROOT / "benchmark/pi-rpc-observer.py")
        real_rpc = importlib.util.module_from_spec(real_spec); real_spec.loader.exec_module(real_rpc)
        observed = []

        def startup(command, env, cwd, **kwargs):
            result = real_rpc.run_rpc(command[:1] + ["--import", str(guard)] + command[1:],
                                      env, cwd, settle_only=True, timeout=20)
            observed.append(result)
            return result

        before = {name: e.file_sha(profile / name) for name in ("models.json", "auth.json")}
        with patch.object(e.rpc, "run_rpc", side_effect=startup):
            for arm in ("native", "grep", "production"):
                e.answer(self.question, snapshot, e.EVAL_HOME / "sdk-startup", arm, pinned, wrapper)
                self.assertEqual(observed[-1]["outcome"], "offline-ready", observed[-1])
        self.assertEqual({name: e.file_sha(profile / name) for name in before}, before)


if __name__ == "__main__":
    unittest.main()
