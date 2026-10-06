#!/usr/bin/env python3
"""Offline Chinese native-live report: reads only artifacts inside --run."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re


def _module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


common = _module("zh_report_common", "report.py")
contract = _module("zh_report_judge_v2", "judge-v2.py")
ARM = "pi-rawfts"
JUDGES = ("luna", "sol")
TOOLS = ("history_recall", "history_grep", "history_expand")
TOKENS = common.TOKEN_FIELDS
# Only explicit engine diagnostics count, never an arbitrary isError flag.
FTS_ERROR = re.compile(r"(?:fts5?\s*:\s*(?:syntax error|unterminated string)|FTS(?:5)?[^\n]*syntax error|no such column\s*:|(?:^|Error:\s*)unterminated string\s*$)", re.I)


def manifest_arm(manifest):
    arms = manifest.get('arms', [ARM])
    if arms not in ([ARM], ['pi-concepts'], ['pi-grep-fallback'], ['pi-restored-grep']):
        raise ValueError('Report accepts only pi-rawfts, pi-concepts, pi-grep-fallback or pi-restored-grep')
    arm = arms[0]
    if manifest.get('identity', {}).get('arm', arm) != arm:
        raise ValueError('Manifest arm identity mismatch')
    return arm


def check_source_hash(path, digest):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise ValueError('Reused source artifact hash mismatch: ' + str(path))


def reused_source(manifest):
    source = manifest.get('identity', {}).get('snapshotSource')
    if source is None:
        return None
    root = Path(source['run']).resolve()
    path = Path(source['manifestPath'])
    if path.resolve() != root / 'manifest.json':
        raise ValueError('Snapshot source manifest path mismatch')
    check_source_hash(path, source['manifestSha256'])
    for filename, digest in source['filesSha256'].items():
        check_source_hash(filename, digest)
    previous = json.loads(path.read_text())
    language = 'en' if manifest['identity']['dataset'] == 'LME16-English' else 'zh'
    if previous['fingerprint'] != source['fingerprint'] or (previous['identity'].get('dataset') != 'LME16-English' if language == 'en' else previous.get('arms') != [ARM]):
        raise ValueError('Snapshot source identity mismatch')
    expected = {'pi/' + qid for qid in manifest.get('selected', [])}
    if set(manifest.get('snapshots', {})) != expected or set(source['snapshots']) != expected:
        raise ValueError('Reused snapshot coverage differs')
    for key, entry in manifest['snapshots'].items():
        original = previous['snapshots'][key]
        frozen = source['snapshots'][key]
        if (entry.get('reused') is not True or entry.get('sourceRun') != str(root)
                or entry.get('sourceFingerprint') != source['fingerprint']
                or entry.get('build') != original.get('build') or entry.get('language') != language
                or any(entry.get(k) != original.get(k) or entry.get(k) != frozen.get(k) for k in ('path', 'sha256'))):
            raise ValueError('Reused snapshot binding mismatch')
        check_source_hash(entry['path'], entry['sha256'])
    return root


class Artifacts:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.issues = []

    def path(self, relative):
        path = self.root / relative
        if not path.resolve().is_relative_to(self.root):
            raise ValueError("Artifact path escapes run root: " + str(relative))
        return path

    def json(self, relative):
        path = self.path(relative)
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"),
                              object_pairs_hook=contract._unique_object,
                              parse_constant=contract._reject_constant)
        except (OSError, ValueError) as error:
            self.issues.append({"path": str(path), "error": str(error)})
            return None

    def session(self, value, question):
        if not isinstance(value, str):
            return None
        path = Path(value)
        if not path.is_absolute():
            path = self.root / path
        # Never follow arbitrary snapshot/config/source references from records.
        if (not path.resolve().is_relative_to(self.root) or path.name not in
                ("session.jsonl", "judge-session.jsonl")):
            self.issues.append({"path": value, "error": "Disallowed session reference"})
            return None
        if not path.is_file():
            return None
        messages = []
        try:
            for line in path.read_text(encoding="utf-8").split("\n"):
                if line.strip():
                    row = json.loads(line)
                    if isinstance(row, dict) and isinstance(row.get("message"), dict):
                        messages.append(row["message"])
        except (OSError, ValueError) as error:
            self.issues.append({"path": str(path), "error": str(error)})
            return None
        if question is None:
            return messages
        boundaries = [i for i, msg in enumerate(messages)
                      if msg.get("role") == "user" and text(msg.get("content")) == question]
        if not boundaries:
            self.issues.append({"path": str(path), "error": "Exact answer question boundary missing"})
            return None
        return messages[boundaries[-1] + 1:]

    def recall_traces(self, directory, record):
        session = record.get('session')
        folder = Path(session).parent if isinstance(session, str) else directory
        if folder.is_absolute():
            if not folder.resolve().is_relative_to(self.root):
                return None
            folder = folder.relative_to(self.root)
        path = self.path(folder / 'timing.jsonl')
        if not path.is_file():
            return None
        try:
            rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
            return [row for row in rows if isinstance(row, dict) and row.get('type') == 'history_recall_trace']
        except (OSError, ValueError) as error:
            self.issues.append({'path': str(path), 'error': str(error)})
            return None

    def tool_evidence(self, record):
        evidence = record.get('toolsEvidence')
        if not isinstance(evidence, dict):
            return None
        path = self.path(evidence['path'])
        check_source_hash(path, evidence.get('sha256'))
        return {**evidence, 'definitions': self.json(path.relative_to(self.root))}


def text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(block.get("text", "") for block in content
                       if isinstance(block, dict) and block.get("type") == "text")
    return ""


def measure(values):
    values = list(values)
    observed = [value for value in values if common.number(value)]
    return {**common.measure(values), "sum": sum(observed) if observed else None}


def sum_known(values):
    values = list(values)
    return sum(values) if values and all(common.number(v) for v in values) else None


def usage(value):
    value = value if isinstance(value, dict) else {}
    return {field: value.get(field) if common.number(value.get(field)) else None for field in TOKENS}


def session_metrics(messages):
    if messages is None:
        return {"modelCalls": None, "tokens": usage(None), "finalText": None}
    assistants = [m for m in messages if m.get("role") == "assistant"]
    return {"modelCalls": len(assistants),
            "tokens": {field: sum_known(usage(m.get("usage"))[field] for m in assistants) for field in TOKENS},
            "finalText": text(assistants[-1].get("content")) if assistants else None}


def tool_events(messages):
    if messages is None:
        return None
    events = []
    for message in messages:
        if message.get("role") == "assistant":
            for block in message.get("content", []):
                if block.get("type") == "toolCall":
                    events.append({"type": "call", "id": block.get("id"),
                                   "tool": block.get("name"), "arguments": block.get("arguments")})
        elif message.get("role") == "toolResult":
            events.append({"type": "result", "id": message.get("toolCallId"),
                           "tool": message.get("toolName")})
    return events


def context_evidence(artifacts, directory):
    rows = []
    folder = artifacts.path(directory)
    if folder.is_dir():
        for path in sorted(folder.rglob('context-*.json')):
            value = artifacts.json(path.relative_to(artifacts.root))
            if isinstance(value, dict):
                locators = value.get('nativeLocators')
                rows.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                             'source': value.get('source'), 'nativeLocators': locators,
                             'serializedLocatorCount': value.get('serializedLocatorCount'),
                             'nativeLocatorCount': len(locators) if isinstance(locators, list) else None})
    return {'observed': bool(rows), 'requests': rows,
            'availability': 'observed' if rows else 'unknown; no saved before_provider_request context evidence',
            'interpretation': 'Automatic context locators are separate from active history tool calls; absence of tool calls does not prove absence of recall.'}


def diagnostic(result, formats):
    content = text(result.get("content"))
    error = result.get("isError")
    details = result.get("details") if isinstance(result.get("details"), dict) else {}
    kind = "tool-error" if error is True else None
    if error is True and result.get("toolName") == "history_recall" and FTS_ERROR.search(content):
        kind = "fts-syntax-error"
    for label, key in (("fts-syntax-error", "ftsErrorPrefixes"),
                       ("explicit-guard-error", "explicitGuardPrefixes")):
        if error is True and any(prefix in content for prefix in formats.get(key, []) if isinstance(prefix, str)):
            kind = label
    if error is True and result.get('toolName') == 'history_recall':
        if 'TOKENIZATION_LOSS' in content or 'Tokenization loss:' in content:
            kind = 'tokenization-loss'
        elif 'EMPTY_ANALYSIS' in content or 'A surface form produced no searchable terms' in content:
            kind = 'empty-analysis'
    total = details.get("total")
    if not common.number(total):
        match = re.search(r"\btotal\s*[=:]\s*(\d+)\b", content)
        total = int(match.group(1)) if match else None
    warning = any(prefix in content for prefix in formats.get("zeroWarningPrefixes", []) if isinstance(prefix, str))
    if error is not True and (total == 0 or warning):
        kind = "total-zero-warning" if warning else "total-zero"
    elif error is not True and common.number(total) and total > 0:
        count = details.get("count", details.get("returned"))
        results = details.get("results")
        if count == 0 or results == [] or re.search(r"\b(?:returned|count)\s*[=:]\s*0\b", content):
            kind = "empty-offset-page-positive-total"
    return kind, total


def retrieval(record, messages, formats, traces=None):
    results = record.get("toolResults")
    events = tool_events(messages)
    calls = record.get("tool_calls")
    if events is not None:
        counts = {tool: sum(e["type"] == "call" and e["tool"] == tool for e in events) for tool in TOOLS}
    else:
        counts = {tool: calls.count(tool) if isinstance(calls, list) else None for tool in TOOLS}
    retained = []
    for result in results if isinstance(results, list) else []:
        if not isinstance(result, dict):
            continue
        args = result.get('arguments') if isinstance(result.get('arguments'), dict) else {}
        observed = [row for row in traces or [] if row.get('toolCallId') == result.get('toolCallId')
                    and row.get('parentToolCallId') is None] if result.get('toolName') == 'history_recall' else []
        trace = observed[0] if len(observed) == 1 else None
        retained.append({**result, 'rawConcepts': args.get('concepts'), 'rawMatch': args.get('match'),
                         'rawExclude': args.get('exclude'), 'trace': trace,
                         'input_identical': trace.get('input_identical') if trace else None,
                         'query_identical': trace.get('query_identical') if trace else None})
    evidence = {'counts': counts, 'events': events, 'calls': retained,
                'traces': traces, 'traceObserved': bool(traces)}
    if not isinstance(results, list):
        return {**evidence, 'diagnostics': None}
    observations = []
    for result in retained:
        kind, total = diagnostic(result, formats)
        details = result.get('details') if isinstance(result.get('details'), dict) else {}
        if kind is None and isinstance(details.get('fallback'), dict):
            kind = 'literal-fallback'
        if kind is None:
            continue
        args = result.get("arguments") if isinstance(result.get("arguments"), dict) else {}
        observation = {"kind": kind, "toolName": result.get("toolName"), "toolCallId": result.get("toolCallId"),
                       "isError": result.get("isError"), "rawQuery": args.get("query"), "rawPattern": args.get("pattern"),
                       "arguments": result.get("arguments"), "content": result.get("content"), "details": result.get("details"),
                       'rawConcepts': args.get('concepts'), 'rawMatch': args.get('match'), 'rawExclude': args.get('exclude'),
                       'trace': result.get('trace'), 'input_identical': result.get('input_identical'),
                       'query_identical': result.get('query_identical'),
                       "total": total, "nextAction": "unknown", "nextCall": None,
                       "modelQueryChanged": None, "modelPatternChanged": None,
                       'modelConceptsChanged': None, 'modelMatchChanged': None, 'modelExcludeChanged': None,
                       "harnessArgumentRewrite": None}
        if events is not None:
            positions = [i for i, e in enumerate(events) if e["type"] == "result" and
                         e["id"] == result.get("toolCallId") and e["tool"] == result.get("toolName")]
            if len(positions) == 1:
                index = positions[0]
                original = next((e for e in reversed(events[:index]) if e["type"] == "call" and
                                 e["id"] == result.get("toolCallId") and e["tool"] == result.get("toolName")), None)
                if original is not None:
                    observation["modelArguments"] = original["arguments"]
                    observation["recordedArgumentMismatch"] = original["arguments"] != result.get("arguments")
                    observation["harnessArgumentRewrite"] = result.get("harnessArgumentRewrite") if type(result.get("harnessArgumentRewrite")) is bool else None
                    original_args = original["arguments"] if isinstance(original["arguments"], dict) else {}
                    observation["modelRawQuery"] = original_args.get("query")
                    observation["modelRawPattern"] = original_args.get("pattern")
                    for key in ('concepts', 'match', 'exclude'):
                        observation['modelRaw' + key.title()] = original_args.get(key)
                else:
                    original_args = {}
                following = next((e for e in events[index + 1:] if e["type"] == "call" and e["tool"] in TOOLS), None)
                if following:
                    next_args = following["arguments"] if isinstance(following["arguments"], dict) else {}
                    observation["nextCall"] = following
                    observation["modelQueryChanged"] = (original_args["query"] != next_args["query"]
                                                         if "query" in original_args and "query" in next_args else None)
                    observation["modelPatternChanged"] = (original_args["pattern"] != next_args["pattern"]
                                                           if "pattern" in original_args and "pattern" in next_args else None)
                    for key in ('concepts', 'match', 'exclude'):
                        observation['model' + key.title() + 'Changed'] = (
                            (key in original_args, original_args.get(key)) != (key in next_args, next_args.get(key))
                            if original is not None and following['tool'] == original['tool']
                            and (key in original_args or key in next_args) else None)
                    observation["nextAction"] = ("switches-grep" if following["tool"] == "history_grep" and original and original["tool"] != "history_grep"
                                                 else "expands" if following["tool"] == "history_expand"
                                                 else "changes-query" if observation["modelQueryChanged"] is True
                                                 else 'changes-concept-parameters' if any(observation['model' + key.title() + 'Changed'] is True for key in ('concepts', 'match', 'exclude'))
                                                 else "changes-pattern" if observation["modelPatternChanged"] is True
                                                 else 'same-search' if following['tool'] == result.get('toolName') and 'concepts' in original_args and original_args == next_args
                                                 else "same-search" if following["tool"] == result.get("toolName") and (observation["modelQueryChanged"] is False or observation["modelPatternChanged"] is False)
                                                 else "same-tool-unknown-query" if following["tool"] == result.get("toolName")
                                                 else "switches-recall")
                elif record.get("outcome") == "answered":
                    observation["nextAction"] = "stops"
                else:
                    observation["nextAction"] = "no-later-search-observed"
        observations.append(observation)
    return {**evidence, 'diagnostics': observations}


def attempts(artifacts, directory, record, phase):
    summaries = record.get("attempts")
    persisted = {}
    folder = artifacts.path(directory / "attempts")
    if folder.is_dir():
        for sub in sorted(folder.iterdir()):
            if sub.is_dir() and re.fullmatch(r"\d+", sub.name):
                value = artifacts.json(directory / "attempts" / sub.name / ("answer.json" if phase == "answer" else "result.json"))
                if isinstance(value, dict):
                    persisted[int(sub.name)] = value
    if isinstance(summaries, list):
        rows = [{**summary, **persisted.get(summary.get("attempt", index), {})}
                for index, summary in enumerate(summaries, 1)]
        return rows, True, True
    return list(persisted.values()), bool(persisted), False


def answer_data(artifacts, directory, record, question, formats):
    record = record if isinstance(record, dict) else {}
    rows, attempts_observed, attempts_complete = attempts(artifacts, directory, record, "answer")
    prompt = question.get("question")
    messages = artifacts.session(record.get("session"), prompt) if isinstance(prompt, str) else None
    sm = session_metrics(messages)
    final = usage(record.get("tokens"))
    all_tokens = usage(record.get("totalAttemptTokens"))
    if "totalAttemptTokens" not in record and attempts_complete:
        all_tokens = {field: sum_known(usage(row.get("tokens"))[field] for row in rows) for field in TOKENS}
    failure_count = (sum(row["outcome"] == "model-error" for row in rows)
                     if attempts_observed and all(isinstance(row.get("outcome"), str) for row in rows) else None)
    timeouts = record.get("timeoutErrors") if isinstance(record.get("timeoutErrors"), dict) else {}
    observer = []
    folder = artifacts.path(directory / "attempts")
    if folder.is_dir():
        for sub in sorted(folder.iterdir()):
            if sub.is_dir() and re.fullmatch(r"\d+", sub.name):
                value = artifacts.json(directory / "attempts" / sub.name / "process-memory.json")
                if value is not None:
                    observer.append({"attempt": sub.name, "observation": value})
    single_observer = artifacts.json(directory / "process-memory.json")
    if single_observer is not None:
        observer.append({"attempt": None, "observation": single_observer})
    attempt_details = []
    for row in rows:
        attempt_messages = artifacts.session(row.get("session"), prompt) if isinstance(prompt, str) else None
        attempt_details.append({"outcome": row.get("outcome"), "wallMs": row.get("answerWallMs"),
                                "tokens": usage(row.get("tokens")),
                                "modelCalls": row.get("modelCalls", session_metrics(attempt_messages)["modelCalls"]),
                                "providerTimeout": row.get("providerTimeout"), "toolTimeouts": row.get("toolTimeoutErrors"),
                                "retrieval": retrieval(row, attempt_messages, formats, artifacts.recall_traces(directory, row))})
    return {"state": record.get("outcome", "missing"), "answer": record.get("answer"),
            "session": record.get("session"), "sessionSha256": record.get("sessionSha256"),
            "sessionObserved": messages is not None, "sessionFinalAnswer": sm["finalText"],
            "sessionAnswerMatchesResult": record.get("answer") == sm["finalText"] if sm["finalText"] is not None else None,
            "finalAttemptWallMs": record.get("answerWallMs"), "finalAttemptTokens": final,
            "allAttemptWallMs": record.get("totalAttemptWallMs", sum_known(r.get("answerWallMs") for r in rows) if attempts_complete else None),
            "allAttemptTokens": all_tokens, "modelCalls": record.get("modelCalls", sm["modelCalls"]),
            "allAttemptModelCalls": sum_known(a["modelCalls"] for a in attempt_details) if attempts_complete else None,
            "attemptCount": len(rows) if attempts_observed or rows else None, "attemptsComplete": attempts_complete,
            "providerRetries": len(rows) - 1 if attempts_observed and rows else None,
            "providerFailures": failure_count, "recoveredProviderRetries": record.get("recoveredProviderRetries"),
            "providerTimeouts": timeouts.get("provider"), "toolTimeouts": timeouts.get("tool"),
            "providerError": record.get("providerError"), "error": record.get("error"),
            "retrieval": retrieval(record, messages, formats, artifacts.recall_traces(directory, record)), "attempts": attempt_details,
            'automaticRecall': context_evidence(artifacts, directory),
            'toolsEvidence': artifacts.tool_evidence(record),
            "processMemory": observer or None}


def judge_data(artifacts, directory, record, answer):
    if not isinstance(record, dict):
        return {"status": "missing", "verdict": None, "correct": None, "guess": None, "hedged": None}
    status, verdict, error = record.get("status", "unknown"), None, None
    if status == "graded":
        try:
            if answer["state"] != "answered" or not isinstance(answer["answer"], str):
                raise ValueError("Graded judge lacks a successful original answer")
            verdict = contract.parse_verdict(json.dumps(record.get("verdict"), ensure_ascii=False), answer["answer"])
            if "rawVerdict" in record and contract.parse_verdict(record["rawVerdict"], answer["answer"]) != verdict:
                raise ValueError("Raw verdict differs from saved verdict")
        except (ValueError, TypeError) as failure:
            status, verdict, error = "invalid-verdict", None, str(failure)
    rows, observed, complete = attempts(artifacts, directory, record, "judge")
    messages = artifacts.session(record.get("session"), None)
    model_calls = [session_metrics(artifacts.session(r.get("session"), None))["modelCalls"] for r in rows]
    return {"status": status, "verdict": verdict, "correct": verdict["correct"] if verdict else None,
            "guess": verdict["guess"] if verdict else None, "hedged": verdict["hedged"] if verdict else None,
            "rawVerdict": record.get("rawVerdict"), "validationError": error,
            "failureKind": record.get("failureKind"), "error": record.get("error"),
            "seconds": record.get("seconds"), "tokens": usage(record.get("tokens")),
            "session": record.get("session"), "sessionSha256": record.get("sessionSha256"),
            "sessionObserved": messages is not None, "modelCalls": session_metrics(messages)["modelCalls"],
            "allAttemptSeconds": sum_known(r.get("seconds") for r in rows) if complete else None,
            "allAttemptTokens": {field: sum_known(usage(r.get("tokens"))[field] for r in rows) if complete else None for field in TOKENS},
            "allAttemptModelCalls": sum_known(model_calls) if complete else None,
            "providerTimeouts": sum_known(int(r["providerTimeout"]) if type(r.get("providerTimeout")) is bool else None for r in rows) if complete else None,
            "providerFailures": sum(r["status"] == "provider-error" for r in rows) if observed and all(isinstance(r.get("status"), str) for r in rows) else None,
            "providerRetries": len(rows) - 1 if observed and rows else None, "attemptsComplete": complete,
            "attempts": rows}


def compression_data(artifacts, qid):
    directory = Path("compression/pi") / qid
    progress = artifacts.json(directory / "progress.json")
    progress = progress if isinstance(progress, dict) else {}
    stages = progress.get("compactions")
    stages = stages if isinstance(stages, list) else None
    observed_attempts = []
    folder = artifacts.path(directory / "stages")
    if folder.is_dir():
        for stage in sorted(folder.iterdir()):
            if not stage.is_dir() or not re.fullmatch(r"\d+", stage.name):
                continue
            attempts_folder = artifacts.path(directory / "stages" / stage.name / "attempts")
            if not attempts_folder.is_dir():
                continue
            for attempt in sorted(attempts_folder.iterdir()):
                if not attempt.is_dir() or not re.fullmatch(r"\d+", attempt.name):
                    continue
                relative = directory / "stages" / stage.name / "attempts" / attempt.name
                record = artifacts.json(relative / "result.json")
                memory = artifacts.json(relative / "process-memory.json")
                if record is not None or memory is not None:
                    observed_attempts.append({"stage": stage.name, "attempt": attempt.name,
                                              "result": record, "processMemory": memory})
    # Native compaction usage is not equivalent to answer usage. Preserve the
    # actual response, but never infer token consumption from context sizes.
    stage_usages = []
    for stage in stages or []:
        response = stage.get("response")
        result = response.get("data") if isinstance(response, dict) else None
        stage_usages.append(result.get("usage") if isinstance(result, dict) else None)
    native_tokens = {field: sum_known(usage(value)[field] for value in stage_usages) for field in TOKENS}
    return {"state": progress.get("state", "missing"), "stagesExpected": 3,
            "stagesObserved": len(stages) if stages is not None else None,
            "stagesSucceeded": sum(s["success"] for s in stages) if stages is not None and all(type(s.get("success")) is bool for s in stages) else None,
            "stageSuccessUnknown": sum(type(s.get("success")) is not bool for s in stages) if stages is not None else None,
            "stageSeconds": [s.get("seconds") for s in stages] if stages is not None else None,
            "seconds": sum_known(s.get("seconds") for s in stages) if stages is not None else None,
            "allAttemptSecondsObserved": sum_known(a["result"].get("seconds") if isinstance(a["result"], dict) else None for a in observed_attempts),
            "attemptsObserved": observed_attempts or None,
            "tokens": native_tokens, "stageUsage": stage_usages if stages is not None else None,
            "tokenUsageAvailability": "observed" if any(isinstance(u, dict) for u in stage_usages) else "unknown",
            "stages": stages}


def score(rows, pending=('unknown', 'inflight')):
    verdicts = [r["verdict"] for r in rows if r.get("verdict") is not None]
    return {"selected": len(rows), "correct": sum(v["correct"] for v in verdicts),
            "scored": len(verdicts), "wrong": sum(not v["correct"] for v in verdicts),
            "failed": sum(r["status"] not in ('graded', 'missing', *pending) for r in rows),
            "missing": sum(r["status"] == "missing" for r in rows),
            "pendingOrUnknown": sum(r["status"] in pending for r in rows),
            "guess": sum(v["guess"] for v in verdicts), "hedged": sum(v["hedged"] for v in verdicts)}


def load_report(root):
    artifacts = Artifacts(root)
    manifest = artifacts.json("manifest.json") or {}
    questions = common.question_map(manifest.get("questions")) or {}
    selected = manifest.get("selected", manifest.get("selectedIds", list(questions)))
    selected = list(common.question_map(selected) or {})
    arm = manifest_arm(manifest)
    reused = arm in ('pi-concepts', 'pi-grep-fallback', 'pi-restored-grep')
    source_root = reused_source(manifest) if reused else None
    if reused and source_root is None:
        raise ValueError('Structured recall run requires immutable snapshotSource')
    formats = artifacts.json("runtime/report-formats.json") or {}
    per_question = []
    for qid in selected:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", qid):
            raise ValueError("Unsafe question ID")
        question = questions.get(qid, {})
        directory = Path('results') / arm / qid
        record = artifacts.json(directory / "result.json")
        if isinstance(record, dict) and (record.get('arm') != arm or record.get('question_id') != qid):
            raise ValueError("Answer identity mismatch: " + qid)
        answer = answer_data(artifacts, directory, record, question, formats)
        judged = {}
        for label in JUDGES:
            directory = Path('judge-v2') / label / arm / qid
            row = artifacts.json(directory / 'result.json')
            if isinstance(row, dict) and (row.get('arm') != arm or row.get('question_id') != qid or row.get('judgeName') != label):
                raise ValueError("Judge identity mismatch: " + label + "/" + qid)
            judged[label] = judge_data(artifacts, directory, row, answer)
        source_artifacts = Artifacts(source_root) if source_root else None
        compression = compression_data(source_artifacts, qid) if source_artifacts else compression_data(artifacts, qid)
        if source_artifacts:
            artifacts.issues.extend(source_artifacts.issues)
        if source_root:
            evidence = {str(path): hashlib.sha256(source_artifacts.path(path.relative_to(source_root)).read_bytes()).hexdigest()
                        for path in sorted((source_root / 'compression/pi' / qid).rglob('*')) if path.is_file()}
            compression = {'state': 'complete', 'reused': True, 'newCompressionCalls': 0,
                           'sourceRun': str(source_root), 'sourceFingerprint': manifest['identity']['snapshotSource']['fingerprint'],
                           'sourceBuild': manifest['snapshots']['pi/' + qid].get('build'), 'sourceCost': compression,
                           'sourceCostFilesSha256': evidence,
                           'seconds': 0, 'tokens': {field: 0 for field in TOKENS}}
        per_question.append({'id': qid, 'question': question, 'answer': answer, 'judges': judged, 'compression': compression})
    judges = {label: {group: score([row["judges"][label] for row in per_question
                                  if group == "total" or row["question"].get("subset") == group],
                                 ('unknown', 'inflight', 'pending', 'running', 'prepared') if arm == 'pi-restored-grep' else ('unknown', 'inflight'))
                     for group in ("total", "dev8", "hard8")} for label in JUDGES}
    answers = [row["answer"] for row in per_question]
    metrics = {field: measure(a.get(field) for a in answers) for field in
               ("finalAttemptWallMs", "allAttemptWallMs", "modelCalls", "allAttemptModelCalls",
                "providerRetries", "providerFailures", "providerTimeouts", "toolTimeouts")}
    for key in ("finalAttemptTokens", "allAttemptTokens"):
        metrics[key] = {field: measure(a[key][field] for a in answers) for field in TOKENS}
    metrics["toolCalls"] = {tool: measure(a["retrieval"]["counts"][tool] for a in answers) for tool in TOOLS}
    resource = artifacts.json("resource.json")
    if arm in ('pi-grep-fallback', 'pi-restored-grep'):
        policy = manifest.get('identity', {}).get('resourcePolicy') or {}
        if (policy.get('maxConcurrentSessions') != 8 or policy.get('authorizedSessionCeiling') != 8
                or policy.get('wholeRunMemoryMaxBytes') != 14 * 1024 ** 3
                or policy.get('wholeRunMemorySwapMaxBytes') != 0):
            raise ValueError('Fallback run requires eight workers and one 14GiB zero-swap scope')
        if resource is not None and (resource.get('maxConcurrentSessions') != 8
                or resource.get('workers') != 8 or resource.get('memoryMaxBytes') != 14 * 1024 ** 3
                or resource.get('swapMaxBytes') != 0 or any(resource.get(key, 0) > 8 for key in
                    ('peakActiveQuestions', 'peakActiveRpcSessions', 'activeQuestions', 'activeRpcSessions'))):
            raise ValueError('Fallback native resource ceiling differs')
    pending = ('missing', 'unknown', 'inflight', 'pending', 'running', 'prepared') if arm == 'pi-restored-grep' else ('missing', 'unknown', 'inflight')
    complete = len(per_question) == 16 and all(row["answer"]["state"] not in pending and
                                         row["compression"]["state"] in ("complete", "failed") and
                                         all(j["status"] not in pending for j in row["judges"].values())
                                         for row in per_question)
    return {'task': manifest.get('identity', {}).get('task', 'RSM-ZH16-NATIVE-LIVE-20261005'), 'arm': arm, 'run': str(artifacts.root),
            "state": "complete" if complete and not artifacts.issues else "incomplete", "manifestState": manifest.get("state"),
            "fingerprint": manifest.get("fingerprint"), "identity": manifest.get("identity"),
            "selected": selected, "selectedCount": len(selected), "expectedCount": 16,
            "denominators": {group: sum(q.get("subset") == group for q in (questions.get(qid, {}) for qid in selected)) for group in ("dev8", "hard8")},
            "judges": judges, "answerMetrics": metrics, "perQuestion": per_question,
            "resource": resource, "cgroupMemoryPeakBytes": resource.get("memoryPeakBytes") if isinstance(resource, dict) else None,
            "issues": artifacts.issues,
            'notes': (['Active recall rejects TOKENIZATION_LOSS before search and zero tokens as EMPTY_ANALYSIS; no automatic literal/mixed rarity fallback. Independent regex history_grep and automatic locators remain enabled.'
                       if manifest.get('identity', {}).get('task') == 'RSM-ZH16-TOKEN-LOSS-REJECT-E2E-20261006' else 'Restored independent regex history_grep retains recall automatic literal/rarity fallback; internal scans are not model tool calls, and active calls and automatic locators are separate. Normal FTS zero hits are not broadened; score differences do not establish success or causality.'
                       if arm == 'pi-restored-grep' else 'Literal fallback routes zero-token or partly unindexable surfaces internally without adding a model tool call; pure FTS zero hits are not relaxed.'
                       if arm == 'pi-grep-fallback' else 'Concepts changes both the structured recall interface and word-internal matching semantics versus rawfts; no cross-version BM25/score calibration or comparison.',
                       'This round makes zero new compression calls; immutable source build costs are listed separately.'] if source_root else []) + ['No provider/config/profile/source-code reads.',
                      "Missing/failed verdicts are unscored, never wrong; null means unknown.",
                      "All-attempt totals never fall back to final-attempt totals.",
                      "Compression tokens are unknown unless native response.data.usage emits them; RSS observations are not total cgroup memory.",
                      "Next actions use actual session event order, not toolResults list order."]}


def fenced(value, language="json"):
    body = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    ticks = "`" * max(3, max((len(m.group()) + 1 for m in re.finditer(r"`+", body)), default=3))
    return ticks + language + "\n" + body + "\n" + ticks


def question_report(row):
    answer = row["answer"]
    lines = ["# " + row["id"], "", "## Question / reference", fenced(row["question"]),
             "", "## Actual answer", "State: " + answer["state"], fenced(answer["answer"] if answer["answer"] is not None else "unknown", "text"),
             "", "## Judges (strict v2)"]
    for label, verdict in row["judges"].items():
        lines += ["", "### " + label, fenced(verdict)]
    lines += ["", "## Answer metrics, actual tool order, exact diagnostics and next actions", fenced(answer),
              "", "## Native compression", fenced(row["compression"]), ""]
    return "\n".join(lines)


def render_report(data):
    lines = ['# ' + ('English' if data['identity']['dataset'] == 'LME16-English' else 'Chinese') + ' native-live ' + data.get('arm', ARM), '', "State: **" + data["state"] + "**; manifest state: " + str(data["manifestState"]),
             f"Selected: {data['selectedCount']}/16; DEV8 denominator: {data['denominators']['dev8']}; hard8 denominator: {data['denominators']['hard8']}.",
             "", *data["notes"], "", "## Strict judge v2 scores", "",
             "| Judge | Subset | Correct | Scored | Selected | Wrong | Failed | Missing | Pending/unknown |", "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for label, groups in data["judges"].items():
        for group, summary in groups.items():
            lines.append("| " + " | ".join(map(str, (label, group, *(summary[key] for key in ("correct", "scored", "selected", "wrong", "failed", "missing", "pendingOrUnknown"))))) + " |")
    lines += ["", "## Per-question readable evidence", "", "| Question | Subset | Answer | Luna | Sol | Final wall ms | All-attempt wall ms |", "|---|---|---|---|---|---:|---:|"]
    for row in data["perQuestion"]:
        a = row["answer"]
        def verdict(label):
            j = row["judges"][label]
            return str(j["correct"]) if j["correct"] is not None else j["status"] + " (unscored)"
        lines.append(f"| [{row['id']}](question-reports/{row['id']}.md) | {row['question'].get('subset', 'unknown')} | {a['state']} | {verdict('luna')} | {verdict('sol')} | {a['finalAttemptWallMs']} | {a['allAttemptWallMs']} |")
    lines += ["", "## Metrics (only observed values contribute; missing totals stay null)", fenced(data["answerMetrics"]),
              "", "## Cgroup resource observation (not summed RSS)", fenced(data["resource"]),
              "", "## Read/progress issues", fenced(data["issues"]), ""]
    return "\n".join(lines)


def write_report(root):
    data = load_report(root)
    artifacts = Artifacts(root)
    artifacts.path("question-reports").mkdir(exist_ok=True)
    for row in data["perQuestion"]:
        artifacts.path(Path("question-reports") / (row["id"] + ".md")).write_text(question_report(row), encoding="utf-8")
    artifacts.path("aggregate.json").write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    artifacts.path("REPORT.md").write_text(render_report(data), encoding="utf-8")
    return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    args = parser.parse_args()
    data = write_report(args.run)
    print(json.dumps({"state": data["state"], "selected": data["selectedCount"], "judges": data["judges"]}, ensure_ascii=False))
