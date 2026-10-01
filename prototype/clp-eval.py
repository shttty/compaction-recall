"""Isolated CLP/Pi evaluation; credentials and extracted LongMemEval data stay outside Git."""
import argparse
import inspect
import hashlib
import heapq
import importlib.util
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import time
import queue
import threading
import io
import posixpath
import tarfile
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
BENCH = ROOT.parent / "lme-bench"
EVAL_HOME = pathlib.Path(os.environ.get("PI_RECALL_EVAL_HOME", "/home/rinne/.hermes/task-runs/recall-20261002/evaluation"))
CLI = ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
PI_FLAGS = ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve"]
SYSTEM = "You are a helpful assistant."
MODEL = "gpt-6-luna"
EFFORT = "high"
SEGMENTS = 4
STOP = set("what when where which have does did they their about from with that this then there were your could would tell remind previous chat conversation mentioned remember please much many name date time person someone something you user had has was were for the and are can did how why who whom whose is it to in on of or a an as at be by we our my me i he she them his her its not now old new latest first last".split())
CANDIDATE_REPO = ROOT.parent / "pi-context-recall"
ALLOWED_PLUGIN_REFS = ("f5715d1901b6bedf19811030f18f3733eefb7bc4", "7d1980b8b7512ec8568c3ddaaecdccb8e0ad4014")

spec = importlib.util.spec_from_file_location("bench", BENCH / "bench.py")
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
rpc_spec = importlib.util.spec_from_file_location("pi_rpc_observer", ROOT / "prototype/pi-rpc-observer.py")
rpc = importlib.util.module_from_spec(rpc_spec)
rpc_spec.loader.exec_module(rpc)


def child_env(source=None):
    return {k: v for k, v in (os.environ if source is None else source).items() if not k.startswith("HERDR_")}


def write_json(path, value, private=True):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    if private:
        temporary.chmod(0o600)
    os.replace(temporary, path)


def valid_manifest(path, fingerprint):
    try:
        return json.loads(pathlib.Path(path).read_text()).get("fingerprint") == fingerprint
    except (OSError, ValueError):
        return False


def file_sha(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


LOCAL_IMPORT = re.compile(r"(?:from\s+|import\s*)['\"](\.{1,2}/[^'\"]+)['\"]")


def git_blob(commit, path):
    return subprocess.run(["git", "-C", str(CANDIDATE_REPO), "show", f"{commit}:{path}"],
                          capture_output=True, check=True).stdout


def runtime_closure(commit):
    pending, files = ["index.ts"], {}
    while pending:
        path = pending.pop()
        if path in files:
            continue
        content = git_blob(commit, path)
        files[path] = content
        for specifier in LOCAL_IMPORT.findall(content.decode("utf-8")):
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), specifier))
            if resolved.startswith("../") or not resolved.endswith((".ts", ".js", ".mjs")):
                raise RuntimeError(f"Unsupported local runtime import in {path}: {specifier}")
            pending.append(resolved)
    package = json.loads(git_blob(commit, "package.json"))
    if "./index.ts" not in package.get("pi", {}).get("extensions", []):
        raise RuntimeError(f"Pinned package entry does not advertise index.ts: {commit}")
    files["package.json"] = git_blob(commit, "package.json")
    try:
        files["package-lock.json"] = git_blob(commit, "package-lock.json")
    except subprocess.CalledProcessError:
        pass
    return files


def pin_plugin(ref):
    if ref not in ALLOWED_PLUGIN_REFS:
        raise ValueError(f"Unsupported plugin ref: {ref}")
    resolved = subprocess.run(["git", "-C", str(CANDIDATE_REPO), "rev-parse", "--verify", f"{ref}^{{commit}}"],
                              capture_output=True, text=True, check=True).stdout.strip()
    if resolved != ref:
        raise RuntimeError(f"Plugin ref did not resolve to its requested full commit: {resolved}")
    source = runtime_closure(resolved)
    file_hashes = {path: hashlib.sha256(content).hexdigest() for path, content in sorted(source.items())}
    archive = subprocess.run(["git", "-C", str(CANDIDATE_REPO), "archive", "--format=tar", resolved, *sorted(source)],
                             capture_output=True, check=True).stdout
    archive_hash = hashlib.sha256(archive).hexdigest()
    sdk_version = json.loads((ROOT / "node_modules/@earendil-works/pi-coding-agent/package.json").read_text())["version"]
    typebox_version = json.loads((ROOT / "node_modules/typebox/package.json").read_text())["version"]
    closure_data = {"resolved_commit": resolved, "entry": "index.ts", "runtime_closure": sorted(path for path in source if path.endswith((".ts", ".js", ".mjs"))),
                    "files": file_hashes, "archive_sha256": archive_hash, "sdk": sdk_version,
                    "typebox": typebox_version}
    closure_hash = hashlib.sha256(json.dumps(closure_data, sort_keys=True).encode()).hexdigest()
    manifest = {**closure_data, "closure_sha256": closure_hash, "source_repo": str(CANDIDATE_REPO)}
    pins_root = EVAL_HOME / "plugins"
    pins_root.mkdir(parents=True, exist_ok=True, mode=0o700); pins_root.chmod(0o700)
    target = pins_root / resolved
    if target.exists():
        existing = json.loads((target / "manifest.json").read_text())
        if existing != manifest:
            raise RuntimeError(f"Existing immutable plugin archive does not match its Git object: {target}")
        for path, expected in file_hashes.items():
            actual = target / path
            if not actual.is_file() or actual.is_symlink() or file_sha(actual) != expected or actual.stat().st_mode & 0o222:
                raise RuntimeError(f"Pinned plugin file changed: {actual}")
        if target.stat().st_mode & 0o222:
            raise RuntimeError(f"Pinned plugin directory is writable: {target}")
        return target, manifest

    stage = pathlib.Path(tempfile.mkdtemp(prefix=f".{resolved}.", dir=pins_root))
    try:
        expected_names = set(source)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
            members = bundle.getmembers()
            if {member.name for member in members if member.isfile()} != expected_names or any(not member.isfile() for member in members):
                raise RuntimeError("Git archive members differ from the resolved runtime closure")
            for member in members:
                out = stage / member.name
                out.parent.mkdir(parents=True, exist_ok=True)
                payload = bundle.extractfile(member).read()
                if hashlib.sha256(payload).hexdigest() != file_hashes[member.name]:
                    raise RuntimeError(f"Git archive content mismatch: {member.name}")
                out.write_bytes(payload); out.chmod(0o444)
        write_json(stage / "manifest.json", manifest)
        (stage / "manifest.json").chmod(0o444)
        for directory in sorted((p for p in stage.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            directory.chmod(0o555)
        stage.chmod(0o555)
        os.replace(stage, target)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return target, manifest


def pin_wrapper():
    source = ROOT / "prototype/grep-only-adapter.mjs"
    payload = source.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    wrappers = EVAL_HOME / "wrappers"
    wrappers.mkdir(parents=True, exist_ok=True, mode=0o700); wrappers.chmod(0o700)
    target = wrappers / f"{digest}.mjs"
    if target.exists():
        if file_sha(target) != digest or target.stat().st_mode & 0o222:
            raise RuntimeError(f"Immutable evaluation wrapper changed: {target}")
    else:
        target.write_bytes(payload); target.chmod(0o444)
    return target, digest

def source_sha(path):
    return file_sha(path)


def records(path):
    try:
        import ijson
    except ImportError as exc:
        raise RuntimeError("Install ijson in the disposable evaluation venv; never load LongMemEval M as one JSON object") from exc
    with pathlib.Path(path).open("rb") as source:
        yield from ijson.items(source, "item")


def labeled_evidence_sessions(q):
    return [any(isinstance(turn, dict) and turn.get("has_answer") is True for turn in session)
            for session in q.get("haystack_sessions", [])]


def hardness(q):
    evidence_sessions = sum(labeled_evidence_sessions(q))
    evidence_turns = sum(1 for session in q.get("haystack_sessions", []) for turn in session
                         if isinstance(turn, dict) and turn.get("has_answer") is True)
    kind = q.get("question_type", "")
    kind_bonus = {"knowledge-update": 16, "temporal-reasoning": 12, "multi-session": 10,
                  "single-session-preference": 8}.get(kind, 0)
    question = q.get("question", "").lower()
    distractor_bonus = 6 if any(x in question for x in ("changed", "update", "previously", "before", "after", "used to", "instead")) else 0
    return min(evidence_sessions, 5) * 20 + min(evidence_turns, 8) * 3 + kind_bonus + distractor_bonus


def serializable_question(record):
    return {"question_id": record.get("question_id"), "question_type": record.get("question_type"),
            "question": record.get("question"), "question_date": record.get("question_date"),
            "haystack_dates": record.get("haystack_dates"),
            "haystack_sessions": [[{"role": turn.get("role"), "content": turn.get("content")} for turn in session]
                                 for session in record.get("haystack_sessions", [])]}


def labeled_evidence_segments(q, segments=SEGMENTS):
    """Map explicit has_answer turns through the exact chronological Pi message cuts."""
    if not any("has_answer" in turn for session in q["haystack_sessions"] for turn in session):
        return None
    scratch = EVAL_HOME / "selection" / f"{q['question_id']}.jsonl"
    scratch.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    b.build_session(q, scratch, pi=True)
    scratch.chmod(0o600)
    rows = b.jsonl_lines(scratch)
    cuts = [0] + b.chunk_cuts(rows[1:], segments) + [len(rows) - 1]
    ordered = sorted(((b.parse_date(date), turns) for date, turns in zip(q["haystack_dates"], q["haystack_sessions"])
                      if turns), key=lambda item: item[0])
    message_evidence = []
    for _, turns in ordered:
        if turns[0]["role"] != "user":
            message_evidence.append(False)
        message_evidence.extend(turn.get("has_answer") is True for turn in turns)
    if len(message_evidence) != len(rows) - 1:
        scratch.unlink(missing_ok=True)
        return None
    hits = [segment + 1 for segment in range(segments)
            if any(message_evidence[cuts[segment]:cuts[segment + 1]])]
    scratch.unlink(missing_ok=True)
    return hits


def choose_hard8(data_path):
    """Stream metadata, then inspect up to 160 shortlisted records against exact labelled segments."""
    shortlist = []
    for q in records(data_path):
        if q.get("question_id") in b.DEV8:
            continue
        score = hardness(q)
        if score < 34:
            continue
        item = (score, q["question_id"], q.get("question_type", ""))
        if len(shortlist) < 160:
            heapq.heappush(shortlist, item)
        elif item > shortlist[0]:
            heapq.heapreplace(shortlist, item)
    wanted = {qid for _, qid, _ in shortlist}
    selected, used_types = [], set()
    for q in records(data_path):
        if q.get("question_id") not in wanted:
            continue
        hits = labeled_evidence_segments(q)
        if hits is None or sum(segment < SEGMENTS for segment in hits) < 2 or SEGMENTS in hits:
            continue
        kind = q["question_type"]
        distractor_cues = [cue for cue in ("changed", "update", "previously", "before", "after", "used to", "instead")
                           if cue in q.get("question", "").lower()]
        selected.append({"question": serializable_question(q), "question_type": kind, "score": hardness(q),
                         "evidenceSegments": hits, "distractorCues": distractor_cues,
                         "rationale": f"Explicit LongMemEval has_answer turns map to separate evidence in segments {hits}; {kind}"})
        selected.sort(key=lambda x: (x["score"] + (8 if x["question"]["question_type"] not in used_types else 0),
                                     x["question"]["question_id"]), reverse=True)
        selected = selected[:8]
        used_types.update(x["question"]["question_type"] for x in selected)
    if len(selected) != 8:
        raise RuntimeError(f"Hard8 policy found only {len(selected)} annotated candidates satisfying the segment rule")
    return selected


def prepare(set_name, data_path=None):
    data_path = pathlib.Path(data_path or BENCH / "data/longmemeval_m.json")
    source_fingerprint = source_sha(data_path)
    EVAL_HOME.mkdir(parents=True, exist_ok=True)
    EVAL_HOME.chmod(0o700)
    selected_ids = set(b.DEV8)
    hard_candidates = choose_hard8(data_path) if set_name in ("hard8", "both") else []
    selected_ids.update(item["question"]["question_id"] for item in hard_candidates)
    found, gold, evidence, dev, hard = {}, {}, {}, {}, {item["question"]["question_id"]: item for item in hard_candidates}
    for q in records(data_path):
        qid = q.get("question_id")
        if qid in selected_ids:
            found[qid] = serializable_question(q)
            evidence[qid] = labeled_evidence_segments(q)
            gold[qid] = q.get("answer", "")
    missing = selected_ids - found.keys()
    if missing:
        raise RuntimeError(f"Selected questions missing from source: {sorted(missing)}")
    for qid in b.DEV8:
        dev[qid] = found[qid]
    for name, questions in (("dev8", dev), ("hard8", {qid: found[qid] for qid in hard})):
        if name == "dev8" and set_name not in ("dev8", "both"):
            continue
        if name == "hard8" and set_name not in ("hard8", "both"):
            continue
        d = EVAL_HOME / "data" / name
        d.mkdir(parents=True, exist_ok=True)
        write_json(d / "questions.json", questions)
        write_json(d / "gold.json", {qid: gold[qid] for qid in questions})
        if name == "dev8":
            rationale = {qid: {"question_type": questions[qid]["question_type"],
                               "rationale": "frozen original DEV8 ID; individual LongMemEval M history",
                               "annotatedEvidenceSegments": evidence[qid]} for qid in b.DEV8}
            policy = "bench.DEV8 exact IDs; labeled segment mapping where turn labels are explicit"
        else:
            rationale = {qid: {k: v for k, v in item.items() if k != "question"} for qid, item in hard.items()}
            policy = "hard8-turn-label-v2; bounded top-160 by explicit has_answer evidence/type score, deterministic type-diverse ranking and ID tie-break; require distinct annotated turns in at least two pre-final chunks; answer_session_ids without turn labels are coarse/unknown"
        write_json(d / "manifest.json", {"set": name, "source": str(data_path), "source_sha256": source_fingerprint,
                                          "selected": list(questions), "selection_policy": policy,
                                          "selection": rationale, "segments": SEGMENTS, "compactions": SEGMENTS - 1})
    print(json.dumps({"source_sha256": source_fingerprint, "prepared": list(selected_ids)}))


def fingerprint(q, q_digest):
    sources = [ROOT / "prototype/pi-stage-events.mjs", ROOT / "prototype/pi-context-estimate.mjs"]
    code = {str(p.relative_to(ROOT)): file_sha(p) for p in sources}
    helper_names = ("parse_date", "iso", "build_session", "chunk_cuts", "append_entries", "jsonl_lines")
    helper_code = "\n".join(inspect.getsource(getattr(b, name)) for name in helper_names)
    code["bench_compression_helpers"] = hashlib.sha256(helper_code.encode()).hexdigest()
    code["compression_driver"] = hashlib.sha256(inspect.getsource(compact).encode()).hexdigest()
    sdk = json.loads((ROOT / "node_modules/@earendil-works/pi-coding-agent/package.json").read_text())["version"]
    config = {"provider": "clp", "model": MODEL, "effort": EFFORT, "system": SYSTEM,
              "segments": SEGMENTS, "compactions": 3, "question_sha256": q_digest, "sdk": sdk, "code": code}
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest(), config


def write_session(path, q):
    b.build_session(q, path, pi=True)
    path.chmod(0o600)


def preflight(session):
    result = subprocess.run(["node", str(ROOT / "prototype/pi-context-estimate.mjs"), str(session)],
                            capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)
    estimate = data["estimatedTokens"] + 5000
    if estimate > 340000:
        raise ValueError(f"Conservative context estimate {estimate} exceeds 340000 safety ceiling")
    return estimate


def agent_env(folder):
    folder.mkdir(parents=True, exist_ok=True)
    folder.chmod(0o700)
    write_json(folder / "models.json", {"providers": {"clp": {"baseUrl": b.API, "api": "openai-responses", "apiKey": b.KEY,
        "models": [{"id": MODEL, "name": MODEL, "reasoning": True, "input": ["text", "image"], "contextWindow": 372000,
                    "maxTokens": 128000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}})
    write_json(folder / "settings.json", {"compaction": {"enabled": False}})
    env = child_env()
    env.update({"PI_CODING_AGENT_DIR": str(folder), "PI_TELEMETRY": "0"})
    return env


def safe_error(text):
    text = str(text)
    for secret in (b.KEY, b.API):
        if secret:
            text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~-]+", r"\1[REDACTED]", text)
    return text[-2000:]


def rpc_line(request):
    return json.dumps(request, separators=(",", ":")) + chr(10)

def compact(session, env, cwd):
    estimated = preflight(session)
    start = time.monotonic()
    cmd = ["node", str(CLI), *PI_FLAGS, "--model", f"clp/{MODEL}:{EFFORT}", "--thinking", EFFORT,
           "--system-prompt", SYSTEM, "--no-tools", "-e", str(ROOT / "prototype/pi-stage-events.mjs"),
           "--mode", "rpc", "--session", str(session)]
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, bufsize=1)
    events, errors = queue.Queue(), []
    def read_events():
        for line in proc.stdout:
            try:
                events.put(json.loads(line))
            except ValueError:
                continue
        events.put(None)
    def read_errors():
        for line in proc.stderr:
            errors.append(line)
            if len(errors) > 80:
                del errors[:40]
    readers = [threading.Thread(target=read_events, daemon=True), threading.Thread(target=read_errors, daemon=True)]
    for reader in readers:
        reader.start()
    timing, response = {}, None
    proc.stdin.write(rpc_line({"id": "ready", "type": "get_state"})); proc.stdin.flush()
    deadline = start + 900
    try:
        while time.monotonic() < deadline:
            try:
                event = events.get(timeout=min(0.5, max(0, deadline - time.monotonic())))
            except queue.Empty:
                continue
            if event is None:
                break
            if event.get("id") == "ready" and event.get("type") == "response":
                if not event.get("success"):
                    response = {"success": False, "error": "Pi RPC readiness failed"}
                    break
                timing["startupToRpcReadyMs"] = (time.monotonic() - start) * 1000
                timing["rpcStart"] = time.monotonic()
                proc.stdin.write(rpc_line({"id": "compact", "type": "compact"})); proc.stdin.flush()
            if event.get("id") == "compact" and event.get("type") == "response":
                timing["compactEnd"] = time.monotonic()
                response = event
                break
        if response is None:
            response = {"success": False, "error": "Compaction timeout" if time.monotonic() >= deadline else "No compaction response"}
    finally:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait()
        for reader in readers:
            reader.join(timeout=1)
        proc.stdout.close(); proc.stderr.close()
    return {"success": response.get("success", False), "error": safe_error(response.get("error", "")),
            "rc": proc.returncode, "estimatedTokens": estimated, "stderr": safe_error("".join(errors)),
            "timing": {"startupToRpcReadyMs": timing.get("startupToRpcReadyMs"),
                       "compactionRpcWallMs": (timing["compactEnd"] - timing["rpcStart"]) * 1000 if "compactEnd" in timing else None,
                       "processWallMs": (time.monotonic() - start) * 1000}}


def prepare_snapshot(q, q_digest, snapshot_root, cwd):
    snap_key, inputs = fingerprint(q, q_digest)
    folder = snapshot_root / snap_key
    session, build = folder / f"{q['question_id']}.jsonl", folder / "build.jsonl"
    manifest, progress_path = folder / "manifest.json", folder / "progress.json"
    if session.exists() and valid_manifest(manifest, snap_key):
        cached = json.loads(manifest.read_text())
        if cached.get("snapshot_sha256") == file_sha(session) and not cached.get("failed"):
            return session, cached, True

    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    source = folder / "source.tmp.jsonl"
    write_session(source, q)
    rows = b.jsonl_lines(source)
    source.unlink()
    head, messages = rows[:1], rows[1:]
    cuts = [0] + b.chunk_cuts(messages, SEGMENTS) + [len(messages)]
    if folder.exists():
        if manifest.exists() and json.loads(manifest.read_text()).get("failed"):
            raise RuntimeError("Snapshot compaction previously failed; refusing an implicit retry")
        if not progress_path.exists():
            # No RPC could have started without the durable inflight marker.
            shutil.rmtree(folder)
            folder.mkdir(mode=0o700)
        else:
            progress = json.loads(progress_path.read_text())
            if progress.get("fingerprint") != snap_key or progress.get("state") not in ("ready", "complete"):
                raise RuntimeError("Snapshot has ambiguous or mismatching progress; refusing to replay compaction calls")
            if not build.exists() or progress.get("build_sha256") != file_sha(build):
                raise RuntimeError("Snapshot checkpoint contents failed validation")
    else:
        folder.mkdir(parents=True, mode=0o700)
    progress = json.loads(progress_path.read_text()) if progress_path.exists() else None
    if progress is None:
        build.write_text("\n".join(head + messages[:cuts[1]]) + "\n")
        build.chmod(0o600)
        compactions, next_stage, state = [], 0, "ready"
        write_json(progress_path, {"fingerprint": snap_key, "question_id": q["question_id"], "state": state,
                                   "nextStage": next_stage, "compactions": compactions, "build_sha256": file_sha(build)})
    else:
        compactions, next_stage, state = progress["compactions"], progress["nextStage"], progress["state"]
    if state == "complete":
        build.replace(session)
    else:
        env = agent_env(folder / "agent")
        for index in range(next_stage, SEGMENTS - 1):
            write_json(progress_path, {"fingerprint": snap_key, "question_id": q["question_id"], "state": "inflight",
                                       "nextStage": index, "compactions": compactions, "build_sha256": file_sha(build)})
            result = compact(build, env, cwd)
            result["providerTokens"] = None
            compactions.append(result)
            if not result["success"]:
                write_json(progress_path, {"fingerprint": snap_key, "question_id": q["question_id"], "state": "failed",
                                           "nextStage": index + 1, "compactions": compactions, "build_sha256": file_sha(build)})
                write_json(manifest, {"fingerprint": snap_key, "inputs": inputs, "failed": True, "compactions": compactions,
                                      "compressionTokens": None})
                raise RuntimeError(f"compaction-{index + 1}: {result['error']}")
            if index + 1 < SEGMENTS - 1:
                b.append_entries(build, messages[cuts[index + 1]:cuts[index + 2]])
                state, next_stage = "ready", index + 1
            else:
                b.append_entries(build, messages[cuts[SEGMENTS - 1]:])
                state, next_stage = "complete", SEGMENTS - 1
            write_json(progress_path, {"fingerprint": snap_key, "question_id": q["question_id"], "state": state,
                                       "nextStage": next_stage, "compactions": compactions, "build_sha256": file_sha(build)})
        build.replace(session)
    snapshot_manifest = {"fingerprint": snap_key, "inputs": inputs, "failed": False, "compactions": compactions,
                        "compressionTokens": None, "snapshot_sha256": file_sha(session),
                        "compaction_seconds": sum(x["timing"]["processWallMs"] for x in compactions) / 1000}
    write_json(manifest, snapshot_manifest)
    return session, snapshot_manifest, False


def answer_outcome(outcome, text, terminal=None):
    if terminal == "error" or outcome not in ("completed", "offline-ready"):
        return "model-error"
    if not text.strip():
        return "empty-answer"
    return "answered"


def answer(q, snapshot, run_dir, arm, plugin_dir, wrapper_path):
    result_dir = run_dir / arm / q["question_id"]
    result_dir.mkdir(parents=True, exist_ok=True)
    result_dir.chmod(0o700)
    session = result_dir / "session.jsonl"
    shutil.copyfile(snapshot, session); session.chmod(0o600)
    env = agent_env(result_dir / "agent")
    tools = {"native": [], "grep": ["history_grep", "history_expand"],
             "production": ["history_recall", "history_grep", "history_expand"]}[arm]
    cmd = ["node", str(CLI), *PI_FLAGS, "--model", f"clp/{MODEL}:{EFFORT}", "--thinking", EFFORT,
           "--system-prompt", SYSTEM]
    if arm == "native":
        cmd += ["--no-tools"]
    elif arm == "grep":
        env["PI_RECALL_EXTENSION"] = str((plugin_dir / "recall-extension.ts").resolve())
        cmd += ["-e", str(wrapper_path), "--tools", ",".join(tools)]
    else:
        cmd += ["-e", str(plugin_dir / "index.ts"), "--tools", ",".join(tools)]
    cmd += ["--mode", "rpc", "--session", str(session)]
    snapshot_rows = len(b.jsonl_lines(snapshot))
    start = time.monotonic()
    try:
        observed = rpc.run_rpc(cmd, env, run_dir, prompt=b.ASK.format(q.get("question_date", ""), q["question"]), timeout=900)
        rows = [json.loads(row) for row in b.jsonl_lines(session)]
        new_rows = rows[snapshot_rows:]
        assistants = [row["message"] for row in new_rows if row.get("message", {}).get("role") == "assistant"]
        final = assistants[-1] if assistants else {}
        text = "".join(block.get("text", "") for block in final.get("content", []) if block.get("type") == "text")
        called = [row["message"].get("toolName") for row in new_rows if row.get("message", {}).get("role") == "toolResult"]
        usage = [message.get("usage") for message in assistants if isinstance(message.get("usage"), dict)]
        totals = {key: sum(item.get(key, 0) or 0 for item in usage) for key in ("input", "output", "cacheRead", "cacheWrite")}
        provider_error = safe_error(final.get("errorMessage", "")) if final.get("stopReason") == "error" else None
        outcome = answer_outcome(observed["outcome"], text, final.get("stopReason"))
        result = {"question_id": q["question_id"], "arm": arm, "outcome": outcome, "answer": text,
                  "terminalStopReason": final.get("stopReason"), "providerError": provider_error,
                  "tool_calls": called, "timing": observed["timing"], "answerWallMs": (time.monotonic() - start) * 1000,
                  "tokens": totals if usage else None, "modelCalls": observed["timing"].get("modelTurns"),
                  "rc": observed["rc"], "error": safe_error(observed.get("stderr", "")) if observed.get("rc") else None}
    except Exception as exc:
        result = {"question_id": q["question_id"], "arm": arm, "outcome": "model-error", "answer": "",
                  "tool_calls": [], "timing": {}, "answerWallMs": (time.monotonic() - start) * 1000,
                  "tokens": None, "modelCalls": None, "rc": -1, "error": safe_error(f"{type(exc).__name__}: {exc}")}
    write_json(result_dir / "result.json", result)
    return result


def parse_verdict(text):
    match = re.fullmatch(r"\s*(yes|no)[.!]?\s*", str(text), re.IGNORECASE)
    return None if match is None else match.group(1).lower() == "yes"


def grade(q, gold, result):
    tpl = b.ABSTAIN if q["question_id"].endswith("_abs") else b.JUDGE[q["question_type"]]
    prompt = tpl.format(q["question"], gold, result["answer"])
    start = time.monotonic()
    try:
        verdict = b.chat(prompt)
        parsed = parse_verdict(verdict)
        judge = {"verdict": verdict, "correct": parsed if result["outcome"] == "answered" else None,
                 "status": "graded" if result["outcome"] == "answered" else "answer-failure-not-scored",
                 "seconds": time.monotonic() - start, "model": b.JUDGE_MODEL, "effort": b.JUDGE_EFFORT}
        if parsed is None:
            judge["error"] = "Judge response was not a standalone yes/no verdict"
            judge["correct"] = None
            judge["status"] = "judge-error"
        return {**result, "judge": judge}
    except Exception as exc:
        return {**result, "judge": {"error": safe_error(f"{type(exc).__name__}: {exc}"), "correct": None,
                                     "status": "judge-error", "seconds": time.monotonic() - start,
                                     "model": b.JUDGE_MODEL, "effort": b.JUDGE_EFFORT}}


def run(set_name, run_name, plugin_ref, only=None):
    data_dir = EVAL_HOME / "data" / set_name
    questions = json.loads((data_dir / "questions.json").read_text())
    gold = json.loads((data_dir / "gold.json").read_text())
    selection = json.loads((data_dir / "manifest.json").read_text())
    if only:
        questions = {qid: q for qid, q in questions.items() if qid == only}
    if not questions:
        raise ValueError(f"No question selected for {set_name}: {only}")
    run_dir = EVAL_HOME / "runs" / run_name
    plugin_dir, plugin_manifest = pin_plugin(plugin_ref)
    wrapper_path, wrapper_hash = pin_wrapper()
    snapshot_root = EVAL_HOME / "snapshots"
    snapshot_root.mkdir(parents=True, exist_ok=True); snapshot_root.chmod(0o700)
    candidate_files = plugin_manifest["files"]
    run_manifest = {"run": run_name, "set": set_name, "questions": list(questions), "data_sha256": selection["source_sha256"],
                    "provider": "clp", "answer_model": MODEL, "answer_effort": EFFORT, "judge_model": b.JUDGE_MODEL,
                    "judge_effort": b.JUDGE_EFFORT,
                    "sdk": json.loads((ROOT / "node_modules/@earendil-works/pi-coding-agent/package.json").read_text())["version"],
                    "arms": ["native", "grep", "production"], "segments": SEGMENTS, "compactions": SEGMENTS - 1,
                    "system_prompt": SYSTEM, "selection_manifest_sha256": file_sha(data_dir / "manifest.json"),
                    "plugin_ref": plugin_ref, "plugin_commit": plugin_manifest["resolved_commit"],
                    "plugin_archive_sha256": plugin_manifest["archive_sha256"],
                    "plugin_closure_sha256": plugin_manifest["closure_sha256"], "plugin_path": str(plugin_dir),
                    "candidate_sha256": candidate_files, "eval_wrapper_sha256": wrapper_hash,
                    "eval_wrapper_path": str(wrapper_path), "runner_sha256": file_sha(__file__)}
    run_manifest["fingerprint"] = hashlib.sha256(json.dumps(run_manifest, sort_keys=True).encode()).hexdigest()
    manifest_path = run_dir / "manifest.json"
    if run_dir.exists():
        if not manifest_path.exists() or json.loads(manifest_path.read_text()) != run_manifest:
            raise RuntimeError(f"Existing run does not match this manifest: {run_dir}")
    else:
        run_dir.mkdir(parents=True); run_dir.chmod(0o700)
        write_json(manifest_path, run_manifest)
    work_cwd = run_dir / "cwd"; work_cwd.mkdir(mode=0o700, exist_ok=True)
    results_path = run_dir / "results.jsonl"
    for qid, q in questions.items():
        done = set()
        failed = False
        if results_path.exists():
            for line in results_path.read_text().splitlines():
                row = json.loads(line)
                if row.get("question_id") == qid:
                    done.add(row.get("arm"))
                    failed |= row.get("outcome") == "compression-error"
        if failed or {"native", "grep", "production"}.issubset(done):
            continue
        qdigest = hashlib.sha256(json.dumps(q, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        try:
            snapshot, snapshot_manifest, reused = prepare_snapshot(q, qdigest, snapshot_root, work_cwd)
        except Exception as exc:
            failure = {"question_id": qid, "outcome": "compression-error", "error": safe_error(f"{type(exc).__name__}: {exc}")}
            with results_path.open("a") as stream:
                stream.write(json.dumps(failure, ensure_ascii=False) + "\n"); stream.flush()
            continue
        for arm in ("native", "grep", "production"):
            if arm in done:
                continue
            result = answer(q, snapshot, run_dir, arm, plugin_dir, wrapper_path)
            result["snapshot"] = {"fingerprint": snapshot_manifest["fingerprint"], "sha256": snapshot_manifest["snapshot_sha256"],
                                  "reused": reused, "compressionSeconds": snapshot_manifest["compaction_seconds"]}
            result = grade(q, gold[qid], result)
            with results_path.open("a") as stream:
                stream.write(json.dumps(result, ensure_ascii=False) + "\n"); stream.flush()
            print(json.dumps({"question_id": qid, "arm": arm, "outcome": result["outcome"],
                              "correct": result.get("judge", {}).get("correct"), "tool_calls": len(result["tool_calls"])}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare"); p.add_argument("--set", choices=("dev8", "hard8", "both"), default="both"); p.add_argument("--data")
    pin = sub.add_parser("pin"); pin.add_argument("--plugin-ref", choices=ALLOWED_PLUGIN_REFS, required=True)
    r = sub.add_parser("run"); r.add_argument("--set", choices=("dev8", "hard8"), required=True); r.add_argument("--run", required=True); r.add_argument("--only")
    r.add_argument("--plugin-ref", choices=ALLOWED_PLUGIN_REFS, required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.set, args.data)
    elif args.command == "pin":
        path, manifest = pin_plugin(args.plugin_ref)
        wrapper_path, wrapper_hash = pin_wrapper()
        print(json.dumps({"plugin": str(path), "commit": manifest["resolved_commit"],
                          "archive_sha256": manifest["archive_sha256"], "closure_sha256": manifest["closure_sha256"],
                          "files": manifest["files"], "wrapper": str(wrapper_path), "wrapper_sha256": wrapper_hash}))
    else:
        run(args.set, args.run, args.plugin_ref, args.only)


if __name__ == "__main__":
    main()
