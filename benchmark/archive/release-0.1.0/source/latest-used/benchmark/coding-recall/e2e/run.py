"""Stage A: fixed coding dev8, official SDK/RPC boundaries, shared case snapshots."""
import argparse
import ast
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import importlib.util
import json
import math
import re
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
ARMS = ('pi-native', 'pi-mainline', 'pi-sqlite', 'omp-native', 'omp-sqlite')
IDS = ('q030', 'q058', 'q054', 'q042', 'q03', 'q01', 'q025', 'q029')
COMMITS = {'mainline': 'e21c6d39634c945bc68930ae7560f21e4dcc966d', 'sqlite': '8f154a333197c75bc1418ca44fc49e70ce5ebc00'}


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


e = module('coding_evaluate', ROOT / 'benchmark/evaluate.py')
scorer = module('coding_scorer', ROOT / 'benchmark/retrieval-score-answers.py')
write_json = e.write_json
sha = e.file_sha

CAPACITY_REJECTION = re.compile(r'context[_ -](?:length|window)[_ -]exceeded|maximum context length|prompt (?:is )?too long|too many input tokens|max_(?:output_)?tokens.{0,200}(?:too|exceed|must|invalid|unsupported|maximum|limit)|(?:exceed|invalid|unsupported|maximum|limit).{0,200}max_output_tokens|output token (?:budget|limit).{0,200}(?:exceed|maximum|limit)', re.I | re.S)


def capacity_error(record):
    if record.get('outcome') != 'model-error' and record.get('status') != 'provider-error':
        return None
    message = record.get('providerError') or record.get('error') or ''
    if record.get('session'):
        assistants = [r['message'] for r in transcript(Path(record['session'])) if r.get('message', {}).get('role') == 'assistant']
        if assistants and assistants[-1].get('stopReason') == 'error':
            message = assistants[-1].get('errorMessage') or message
    return message if CAPACITY_REJECTION.search(message) else None



def load_dataset(data, selection_path):
    selection = json.loads(selection_path.read_text())
    questions_path, gold_path = data / 'full/questions.json', data / 'full/gold.json'
    if tuple(selection.get('ids', [])) != IDS or selection.get('questions_sha256') != sha(questions_path):
        raise ValueError('Frozen dev8 selection or question bytes changed')
    by_id = {q['id']: q for q in json.loads(questions_path.read_text())}
    questions = [by_id[q] for q in IDS]
    if any(q['split'] != 'dev' for q in questions):
        raise ValueError('Stage A cannot include test questions')
    cases, files = {}, {str(p): sha(p) for p in (selection_path, questions_path, gold_path)}
    for q in questions:
        case = q['caseId']
        if case in cases:
            continue
        directory = data / 'data' / q['subset'] / case
        corpus_path, provenance_path = directory / 'corpus.json', directory / 'provenance.json'
        corpus = json.loads(corpus_path.read_text())
        provenance = json.loads(provenance_path.read_text())
        messages = []
        if len(corpus['haystack_sessions']) != len(provenance['sessions']):
            raise ValueError('Corpus/provenance session mismatch')
        for session_index, (turns, source) in enumerate(zip(corpus['haystack_sessions'], provenance['sessions'])):
            if len(turns) != len(source['messages']):
                raise ValueError('Corpus/provenance turn mismatch')
            for turn, metadata in zip(turns, source['messages']):
                if turn['role'] != metadata['role'] or turn['content'] != metadata['text']:
                    raise ValueError('Frozen searchable projection changed')
                messages.append({'id': f"s{session_index}-{metadata['entryId']}", 'timestamp': metadata['timestamp'],
                                 'role': turn['role'], 'text': turn['content']})
        if len({m['id'] for m in messages}) != len(messages):
            raise ValueError('Duplicate original message coordinates')
        cases[case] = messages
        files.update({str(p): sha(p) for p in (corpus_path, provenance_path)})
    if set(cases) != set(selection['cases']) or len(cases) != 3:
        raise ValueError('Stage A must contain the three frozen cases')
    return questions, cases, files


def segment_plan(messages, model, chars_per_token, overhead):
    # The model's full generation maximum bounds both retained summary and generation.
    # SDK chars/4 preflight is stricter than lme-bench's chars/4.84 T estimate.
    generation = model['maxTokens']
    available = model['contextWindow'] - generation * 2 - overhead
    if available <= 0:
        raise ValueError('No safe segment capacity after summary/generation reserves')
    cap = available * 4 / chars_per_token
    sizes = [len(m['text']) / chars_per_token for m in messages]
    total = sum(sizes)
    count = max(4, math.ceil(total / cap))
    if len(messages) < count or any(size > cap for size in sizes):
        raise ValueError('A message cannot fit safely without truncation')
    cuts, consumed, cursor = [0], 0.0, 0
    for part in range(1, count):
        target = total * part / count
        while cursor < len(sizes) - (count - part) and consumed + sizes[cursor] / 2 < target:
            consumed += sizes[cursor]
            cursor += 1
        cursor = max(cursor, cuts[-1] + 1)
        consumed = sum(sizes[:cursor])
        cuts.append(cursor)
    cuts.append(len(messages))
    tokens = [sum(sizes[a:b]) for a, b in zip(cuts, cuts[1:])]
    if max(tokens) > cap:
        raise ValueError('Message-boundary balanced cut exceeds safe segment capacity')
    return {'T': total, 'N': count, 'S': cap, 'cuts': cuts, 'segmentTokens': tokens,
            'charsPerToken': chars_per_token, 'contextWindow': model['contextWindow'],
            'generationReserve': generation, 'summaryAllowance': generation, 'overheadTokens': overhead,
            'protocol': 'all-segments-compacted-v1', 'keepRecentTokens': 0}


def transcript(path):
    return [json.loads(line) for line in path.read_text().split('\n') if line]


def initial_session(path, case, messages, model, omp):
    timestamp = messages[0]['timestamp']
    rows = []
    if omp:
        title = {'type': 'title', 'v': 1, 'title': case, 'updatedAt': timestamp, 'pad': ''}
        text = json.dumps(title, separators=(',', ':'))
        title['pad'] = ' ' * max(0, 255 - len(text.encode()))
        rows.append(title)
    rows.append({'type': 'session', 'version': 3, 'id': hashlib.sha256(case.encode()).hexdigest()[:32],
                 'timestamp': timestamp, 'cwd': str(path.parent)})
    path.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
    path.chmod(0o600)


def append_segment(path, messages, stage, model, chars_per_token):
    rows = transcript(path)
    parent = next((row['id'] for row in reversed(rows) if 'parentId' in row), None)
    base = next((row.get('tokensAfter', math.ceil(len(row.get('summary', '')) / 4)) for row in reversed(rows) if row['type'] == 'compaction'), 0)
    chars, added = 0, []
    for source in messages:
        chars += len(source['text'])
        message = {'role': source['role'], 'content': [{'type': 'text', 'text': source['text']}],
                   'timestamp': int(datetime.fromisoformat(source['timestamp'].replace('Z', '+00:00')).timestamp() * 1000)}
        if source['role'] == 'assistant':
            estimate = base + math.ceil(chars / chars_per_token)
            message.update(api='openai-responses', provider=model['provider'], model=model['model'], stopReason='stop',
                           usage={'input': estimate, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': estimate,
                                  'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}})
        row = {'type': 'message', 'id': source['id'], 'parentId': parent, 'timestamp': source['timestamp'], 'message': message}
        added.append(row)
        parent = source['id']
    sentinel = {'type': 'message', 'id': f'e2e-boundary-{stage}', 'parentId': parent, 'timestamp': messages[-1]['timestamp'],
                'message': {'role': 'user', 'content': [{'type': 'text', 'text': '[End of historical segment. Compact before continuing.]'}], 'timestamp': 0}}
    added.append(sentinel)
    with path.open('a') as stream:
        stream.write(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in added))
        stream.flush()
        os.fsync(stream.fileno())


def compact_rpc(command, cwd, timeout=900):
    process = subprocess.Popen(command, cwd=cwd, env=e.child_env(), stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    events, errors = queue.Queue(), []
    def collect():
        for line in process.stdout:
            try:
                events.put(json.loads(line))
            except ValueError:
                continue
        events.put(None)
    def stderr():
        for line in process.stderr:
            errors.append(line)
    threads = [threading.Thread(target=collect, daemon=True), threading.Thread(target=stderr, daemon=True)]
    for thread in threads:
        thread.start()
    start, response = time.monotonic(), None
    process.stdin.write(e.rpc_line({'id': 'ready', 'type': 'get_state'})); process.stdin.flush()
    try:
        while time.monotonic() - start < timeout:
            try:
                event = events.get(timeout=0.2)
            except queue.Empty:
                continue
            if event is None:
                break
            if event.get('id') == 'ready' and event.get('type') == 'response':
                if not event.get('success'):
                    response = event; break
                process.stdin.write(e.rpc_line({'id': 'compact', 'type': 'compact'})); process.stdin.flush()
            if event.get('id') == 'compact' and event.get('type') == 'response':
                response = event; break
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait()
        for thread in threads:
            thread.join(timeout=1)
        process.stdout.close(); process.stderr.close()
    return {'success': bool(response and response.get('success')), 'response': response,
            'stderr': e.safe_error(''.join(errors)), 'seconds': time.monotonic() - start, 'rc': process.returncode}


def prepare_snapshot(case, messages, plan, mode, output, fingerprint, boundary, model):
    key = e.object_sha({'run': fingerprint, 'case': case, 'mode': mode, 'plan': plan})
    folder = output / 'compression' / mode / key
    folder.mkdir(parents=True, exist_ok=True)
    path, journal_path = folder / 'session.jsonl', folder / 'progress.json'
    journal = json.loads(journal_path.read_text()) if journal_path.exists() else None
    if journal:
        if journal.get('key') != key or journal.get('sessionSha256') != sha(path):
            raise ValueError('Compression checkpoint bytes changed')
        if journal['state'] not in ('ready', 'complete'):
            raise ValueError('Failed/ambiguous compression is not replayed automatically')
    else:
        initial_session(path, case, messages, model, mode == 'omp')
        journal = {'key': key, 'caseId': case, 'mode': mode, 'state': 'ready', 'nextStage': 0, 'compactions': [], 'sessionSha256': sha(path)}
        write_json(journal_path, journal)
    for stage in range(journal['nextStage'], plan['N']):
        journal['state'] = 'inflight'
        write_json(journal_path, journal)
        append_segment(path, messages[plan['cuts'][stage]:plan['cuts'][stage + 1]], stage, model, plan['charsPerToken'])
        before = e.preflight(path)
        result = compact_rpc(boundary('compression', path, mode), folder)
        result['estimatedTokensBefore'] = before
        if result['success']:
            after = e.preflight(path)
            compact = next(row for row in reversed(transcript(path)) if row['type'] == 'compaction')
            result.update(tokensBefore=compact.get('tokensBefore'), tokensAfter=compact.get('tokensAfter', after),
                          estimatedTokensAfter=after, firstKeptEntryId=compact.get('firstKeptEntryId'))
            if compact.get('firstKeptEntryId') != f'e2e-boundary-{stage}':
                result['success'] = False
                result['error'] = 'Original case evidence remained outside the compacted boundary'
        journal['compactions'].append(result)
        journal.update(state='ready' if result['success'] else 'failed', nextStage=stage + 1, sessionSha256=sha(path))
        write_json(journal_path, journal)
        print(json.dumps({'case': case, 'mode': mode, 'stage': stage + 1, 'success': result['success']}), flush=True)
        if not result['success']:
            raise RuntimeError(f'Compaction failed: {journal_path}')
    journal['state'] = 'complete'
    write_json(journal_path, journal)
    return path, journal


def extract_answer(path, snapshot, observed, question, arm, elapsed):
    raw, prefix = path.read_bytes(), snapshot.read_bytes()
    if not raw.startswith(prefix):
        raise ValueError('Answer session changed immutable snapshot prefix')
    rows = [json.loads(line) for line in raw[len(prefix):].decode().split('\n') if line]
    users = [row['message'] for row in rows if row.get('message', {}).get('role') == 'user']
    prompt = question['question']
    if len(users) != 1 or ''.join(block.get('text', '') for block in users[0]['content'] if block['type'] == 'text') != prompt:
        raise ValueError('Answer transcript does not contain the exact frozen question')
    assistants = [row['message'] for row in rows if row.get('message', {}).get('role') == 'assistant']
    final = assistants[-1] if assistants else {}
    text = ''.join(block.get('text', '') for block in final.get('content', []) if block['type'] == 'text')
    results = [row['message'] for row in rows if row.get('message', {}).get('role') == 'toolResult']
    calls = [block for message in assistants for block in message.get('content', []) if block['type'] == 'toolCall']
    call_ids = {(call['id'], call['name']): call for call in calls}
    if any((result['toolCallId'], result['toolName']) not in call_ids for result in results):
        raise ValueError('Tool call/result identity mismatch')
    if any(message.get('provider') != e.CONFIG['answer']['provider'] or message.get('model') != e.CONFIG['answer']['model'] for message in assistants):
        raise ValueError('Answer transcript uses an unexpected model')
    usage = [message['usage'] for message in assistants if isinstance(message.get('usage'), dict)]
    tokens = {key: sum(row.get(key, 0) or 0 for row in usage) for key in ('input', 'output', 'cacheRead', 'cacheWrite')} if usage else None
    return {'question_id': question['id'], 'arm': arm, 'outcome': e.answer_outcome(observed['outcome'], text, final.get('stopReason')),
            'answer': text, 'tool_calls': [call['name'] for call in calls], 'toolErrors': sum(bool(row.get('isError')) for row in results),
            'toolResults': [{'toolName': row['toolName'], 'toolCallId': row['toolCallId'], 'isError': bool(row.get('isError')),
                             'arguments': call_ids[(row['toolCallId'], row['toolName'])].get('arguments'),
                             'content': row.get('content', []), 'details': row.get('details')} for row in results],
            'answerWallMs': elapsed, 'timing': observed['timing'], 'tokens': tokens, 'modelCalls': len(assistants),
            'providerError': e.safe_error(final.get('errorMessage', '')) if final.get('stopReason') == 'error' else None,
            'rc': observed['rc'], 'error': e.safe_error(observed.get('stderr', '')) if observed['rc'] else None,
            'snapshotSha256': sha(snapshot), 'sessionSha256': sha(path), 'session': str(path),
            'metadata': {key: question.get(key) for key in ('caseId', 'subset', 'language', 'type', 'overlap')}}


def durable_phase(directory, name, identity, operation):
    path, marker = directory / f'{name}.json', directory / f'{name}-state.json'
    if path.exists():
        record = json.loads(path.read_text())
        if record.get('identity') != identity:
            raise ValueError('Saved phase identity changed')
        if marker.exists():
            state = json.loads(marker.read_text())
            if state.get('state') == 'complete' and state.get('resultSha256') != sha(path):
                raise ValueError('Saved phase output bytes changed')
        for key in ('session', 'judgeSession'):
            if record.get(key) and sha(Path(record[key])) != record.get(key + 'Sha256', record.get('sessionSha256')):
                raise ValueError('Saved transcript bytes changed')
        return record
    if marker.exists():
        raise ValueError('Unknown inflight phase refuses implicit provider replay')
    write_json(marker, {'identity': identity, 'state': 'inflight'})
    record = operation()
    record['identity'] = identity
    write_json(path, record)
    write_json(marker, {'identity': identity, 'state': 'complete', 'resultSha256': sha(path)})
    return record


def validate_pi_reuse(path, identity):
    previous = json.loads(path.read_text())
    old = previous['identity']
    if previous.get('hostStates', {}).get('pi') != 'complete':
        raise ValueError('Only completed Pi snapshot sets can be reused')
    for key in ('inputs', 'plans'):
        if old[key] != identity[key]:
            raise ValueError('Reused Pi dataset/cuts changed')
    for key in ('compression', 'protocol', 'system_prompt'):
        if old['runtimeConfig'][key] != identity['runtimeConfig'][key]:
            raise ValueError('Reused Pi compression configuration changed')
    if old['models']['compression'] != identity['models']['compression']:
        raise ValueError('Reused Pi compression model changed')
    source = path.parent / 'run.py'
    if sha(source) != old['sources'][str(Path(__file__))]:
        raise ValueError('Original compression runner source proof changed')
    names = {'load_dataset', 'segment_plan', 'transcript', 'initial_session', 'append_segment', 'compact_rpc', 'prepare_snapshot'}
    def functions(filename):
        text = filename.read_text()
        return {node.name: ast.get_source_segment(text, node) for node in ast.parse(text).body if isinstance(node, ast.FunctionDef) and node.name in names}
    if functions(source) != functions(Path(__file__)):
        raise ValueError('Compression orchestration changed; old snapshots cannot be reused')
    for filename in (HERE / 'pi-rpc.mjs', ROOT / 'benchmark/sdk-rpc.mjs', ROOT / 'benchmark/evaluate.py', ROOT / 'benchmark/pi-context-estimate.mjs', Path(identity['runtimeConfig']['helper_path'])):
        if old['sources'][str(filename)] != sha(filename):
            raise ValueError('Compression dependency changed')
    for case in identity['plans']:
        saved = previous['snapshots'][f'pi/{case}']
        session = Path(saved['path'])
        if saved['state'] != 'complete' or saved['sessionSha256'] != sha(session):
            raise ValueError('Reused Pi snapshot bytes changed')
    return previous['snapshots']


def answer_system_prompt(question):
    return e.b.ASK.format(question['question_date'], '').partition('\nQuestion:')[0].rstrip()


def answer_one(question, arm, snapshot, output, fingerprint, boundary):
    directory = output / 'results' / arm / question['id']
    directory.mkdir(parents=True, exist_ok=True)
    system_path = directory / 'answer-system.txt'
    instructions = answer_system_prompt(question)
    if system_path.exists():
        if system_path.read_text() != instructions:
            raise ValueError('Frozen answer system prompt changed')
    else:
        system_path.write_text(instructions)
        system_path.chmod(0o444)
    identity = e.object_sha({'run': fingerprint, 'arm': arm, 'question': question['id'], 'snapshot': sha(snapshot)})
    def answer():
        session = directory / 'session.jsonl'
        shutil.copyfile(snapshot, session)
        start = time.monotonic()
        try:
            observed = e.rpc.run_rpc(boundary('answer', session, 'omp' if arm.startswith('omp-') else 'pi', arm),
                                     e.child_env(), directory, prompt=question['question'], timeout=900)
            return extract_answer(session, snapshot, observed, question, arm, (time.monotonic() - start) * 1000)
        except Exception as error:
            return {'question_id': question['id'], 'arm': arm, 'outcome': 'model-error', 'answer': '', 'tool_calls': [], 'tokens': None,
                    'answerWallMs': (time.monotonic() - start) * 1000, 'timing': {}, 'error': e.safe_error(error),
                    'session': str(session), 'sessionSha256': sha(session), 'snapshotSha256': sha(snapshot),
                    'metadata': {key: question.get(key) for key in ('caseId', 'subset', 'language', 'type', 'overlap')}}
    saved = durable_phase(directory, 'answer', identity, answer)
    def judge():
        if saved['outcome'] != 'answered':
            return {'judge': {'correct': None, 'status': 'answer-failure-not-scored'}}
        prompt = scorer.JUDGE_PROMPT
        if question['type'] == 'no-answer':
            prompt += '\n本题历史没有可回答的依据。明确表示在历史中找不到/无法确认算正确（10分）；编造具体答案算错误（1分）。'
        data = {'question_en': question['question'], 'reference_answer': question['answer'], 'model_answer': saved['answer']}
        if question['language'] != 'en':
            data['question_zh'] = question['question']
        prompt += '\n\n' + json.dumps(data, ensure_ascii=False, allow_nan=False)
        session = directory / 'judge-session.jsonl'
        start = time.monotonic()
        try:
            observed = e.rpc.run_rpc(boundary('judge', session, 'pi'), e.child_env(), directory, prompt=prompt, timeout=900)
            assistants = [row['message'] for row in transcript(session) if row.get('message', {}).get('role') == 'assistant']
            final = assistants[-1] if assistants else {}
            if observed['outcome'] != 'completed' or final.get('stopReason') == 'error':
                raise RuntimeError('Judge provider failed')
            verdict = ''.join(block.get('text', '') for block in final.get('content', []) if block['type'] == 'text')
            parsed = scorer.parse_score(verdict)
            return {'judge': {**parsed, 'verdict': verdict, 'correct': parsed['score'] >= 8, 'status': 'graded', 'seconds': time.monotonic() - start},
                    'judgeSession': str(session), 'judgeSessionSha256': sha(session)}
        except Exception as error:
            return {'judge': {'correct': None, 'status': 'judge-error', 'error': e.safe_error(error), 'seconds': time.monotonic() - start},
                    **({'judgeSession': str(session), 'judgeSessionSha256': sha(session)} if session.exists() else {})}
    judged = durable_phase(directory, 'judge', identity, judge)
    result = {**saved, **judged}
    write_json(directory / 'result.json', result)
    print(json.dumps({'id': question['id'], 'arm': arm, 'outcome': result['outcome'], 'judge': result['judge']}), flush=True)
    return result


def run(args):
    output, data = args.output.resolve(), args.data_root.resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (output / 'live-paused.json').exists():
        raise RuntimeError('Coding replay protocol is withdrawn; no new real calls are allowed')
    config = json.loads(args.config.read_text())
    judge_config = json.loads(args.judge_config.read_text())
    config['judge'] = judge_config['judge']
    config['output_dir'] = str(output)
    runtime_config = output / 'config.json'
    write_json(runtime_config, config)
    e.CONFIG, e.CONFIG_PATH = config, runtime_config
    e.b = e.configuration.load_helper(Path(config['helper_path']), config)
    models = {}
    for phase in ('compression', 'answer', 'judge'):
        described = subprocess.run(['node', str(ROOT / 'benchmark/sdk-rpc.mjs'), '--config', str(runtime_config), '--phase', phase, '--describe'],
                                   env=e.child_env(), capture_output=True, text=True, check=True)
        models[phase] = json.loads(described.stdout)
    e.CONTEXT_WINDOW_TOKENS = models['compression']['contextWindow']
    e.COMPACTION_RESERVE_TOKENS = models['compression']['maxTokens']
    e.PREFLIGHT_OVERHEAD_TOKENS = config['protocol']['overhead_tokens']
    e.PREFLIGHT_CEILING_TOKENS = e.CONTEXT_WINDOW_TOKENS - e.COMPACTION_RESERVE_TOKENS
    questions, cases, inputs = load_dataset(data, args.selection)
    pins = json.loads((output / 'probe/snapshots.json').read_text())
    wrappers = {}
    prompts = str(Path(pins['mainline']['path']) / 'doc/SOFT_MATCH_PROMPTS.md')
    for name in COMMITS:
        pin = pins[name]
        if pin['commit'] != COMMITS[name]:
            raise ValueError('Unexpected plugin commit')
        base = Path(pin['path'])
        if any(sha(base / path) != digest for path, digest in pin['runtimeClosureSha256'].items()):
            raise ValueError('Archived runtime import closure changed')
        folder = output / 'wrappers' / name
        folder.mkdir(parents=True, exist_ok=True)
        entry = folder / 'entry.mjs'
        settings = {'entry': str(base / pin['entry']), 'sdkPath': config['sdk_path'], 'promptsPath': prompts, 'sqlite': name == 'sqlite'}
        wrapper_source = f"import {{ registerPinned }} from {json.dumps(str(HERE / 'plugin.mjs'))};\nexport default pi => registerPinned(pi, {json.dumps(settings)});\n"
        if entry.exists():
            if entry.read_text() != wrapper_source:
                raise ValueError('Pinned benchmark wrapper changed')
        else:
            entry.write_text(wrapper_source)
        write_json(folder / 'package.json', {'type': 'module', 'pi': {'extensions': ['./entry.mjs']}})
        entry.chmod(0o444); (folder / 'package.json').chmod(0o444)
        wrappers[name] = folder
    omp_config = {**config, 'prompts_path': prompts}
    write_json(output / 'omp-config.json', omp_config)
    def boundary(phase, session, mode, arm=None):
        if mode == 'omp':
            command = ['python3', str(HERE / 'omp-rpc.py'), '--config', str(output / 'omp-config.json'), '--phase', phase, '--session', str(session)]
            if phase == 'answer':
                command += ['--append-system-prompt', str(session.parent / 'answer-system.txt')]
            if arm == 'omp-sqlite':
                command += ['--plugin-entry', str(Path(pins['sqlite']['path']) / pins['sqlite']['entry']), '--timing-file', str(session.parent / 'timing.jsonl')]
            return command
        command = ['node', str(HERE / 'pi-rpc.mjs'), '--config', str(runtime_config), '--phase', phase, '--session', str(session)]
        if phase == 'answer':
            command += ['--arm', 'native' if arm == 'pi-native' else 'production']
            command += ['--append-system-prompt', str(session.parent / 'answer-system.txt')]
            if arm != 'pi-native':
                name = 'mainline' if arm == 'pi-mainline' else 'sqlite'
                command += ['--plugin-dir', str(wrappers[name]), '--timing-file', str(session.parent / 'timing.jsonl')]
        return command
    plans = {case: segment_plan(messages, models['compression'], e.b.CHARS_PER_TOKEN, config['protocol']['overhead_tokens']) for case, messages in cases.items()}
    source_files = [Path(__file__), HERE / 'plugin.mjs', HERE / 'pi-rpc.mjs',
                    ROOT / 'benchmark/sdk-rpc.mjs', ROOT / 'benchmark/evaluate.py', ROOT / 'benchmark/pi-rpc-observer.py',
                    ROOT / 'benchmark/pi-context-estimate.mjs', ROOT / 'benchmark/retrieval-score-answers.py', Path(config['helper_path']), ROOT / 'package-lock.json']
    identity = {'schema': 'coding-e2e-stage-a-v1', 'inputs': inputs, 'configs': {str(p): sha(p) for p in (args.config, args.judge_config)},
                'runtimeConfig': config, 'models': models, 'plugins': {name: pins[name] for name in COMMITS}, 'plans': plans,
                'sources': {str(path): sha(path) for path in source_files}, 'promptsSha256': sha(Path(prompts)),
                'judgePromptSha256': hashlib.sha256(scorer.JUDGE_PROMPT.encode()).hexdigest(), 'accuracy': 'score >=8, matching S5 atLeast8 descriptive bucket',
                'noAnswer': 'explicit history-not-found=10; hallucination=1', 'pilotId': 'q01', 'selected': list(IDS),
                'automaticQuery': 'unmodified raw user question; date and answer requirements are in the system prompt'}
    reuse_path = getattr(args, 'reuse_pi_manifest', None)
    reusable = validate_pi_reuse(reuse_path, identity) if reuse_path else {}
    if reuse_path:
        identity['reusePiManifest'] = {'path': str(reuse_path), 'sha256': sha(reuse_path)}
    fingerprint = e.object_sha(identity)
    manifest_path = output / 'manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest['fingerprint'] != fingerprint:
            raise ValueError('Manifest/data/code/config changed; cannot resume this run')
    else:
        manifest = {'fingerprint': fingerprint, 'identity': identity, 'selected': list(IDS), 'questions': questions,
                    'arms': list(ARMS), 'stage': 'A', 'state': 'prepared', 'snapshots': {}}
        write_json(manifest_path, manifest)
    host = getattr(args, 'host', 'pi')
    if host not in ('pi', 'omp'):
        raise ValueError('Run Pi first, then OMP as a separate host phase')
    manifest.setdefault('hostStates', {})
    host_fingerprint = fingerprint
    if host == 'omp':
        if manifest['hostStates'].get('pi') != 'complete':
            raise ValueError('Real OMP execution must wait for all Pi dev8 arms')
        omp_identity = {str(path): sha(path) for path in (HERE / 'omp-rpc.py', HERE / 'omp-extension.mjs')}
        if manifest.get('ompIdentity', omp_identity) != omp_identity:
            raise ValueError('Frozen OMP boundary changed')
        manifest['ompIdentity'] = omp_identity
        host_fingerprint = e.object_sha({'pi': fingerprint, 'omp': omp_identity})
    active_arms = ARMS[:3] if host == 'pi' else ARMS[3:]
    snapshots = {}
    def snapshots_for(case):
        for mode in (host,):
            pair = (mode, case)
            if pair not in snapshots:
                if mode == 'pi' and f'pi/{case}' in reusable:
                    checkpoint = {**reusable[f'pi/{case}'], 'reusedFrom': identity['reusePiManifest']}
                    snapshot = Path(checkpoint['path'])
                else:
                    snapshot, checkpoint = prepare_snapshot(case, cases[case], plans[case], mode, output, host_fingerprint, boundary, models['compression'])
                snapshots[pair] = snapshot
                manifest['snapshots'][f'{mode}/{case}'] = {'path': str(snapshot), **checkpoint, 'plan': plans[case]}
                write_json(manifest_path, manifest)
    pilot = next(q for q in questions if q['id'] == 'q01')
    snapshots_for(pilot['caseId'])
    for arm in active_arms:
        result = answer_one(pilot, arm, snapshots[(host, pilot['caseId'])], output, host_fingerprint, boundary)
        if result['outcome'] != 'answered' or result['judge']['status'] != 'graded':
            raise RuntimeError('Pilot chain failed; inspect durable artifacts before full stage A')
    manifest['hostStates'][host] = 'pilot-passed'
    manifest['state'] = host + '-pilot-passed'
    write_json(manifest_path, manifest)
    if args.stage == 'pilot':
        return manifest
    for case in cases:
        snapshots_for(case)
    jobs = [(question, arm) for question in questions for arm in active_arms]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(answer_one, question, arm, snapshots[(host, question['caseId'])], output, host_fingerprint, boundary) for question, arm in jobs]
        records = [future.result() for future in futures]
    # Rebuild ledger from already durable answer/judge records; never call a provider to recover it.
    write_json(output / f'{host}-ledger.json', {'fingerprint': host_fingerprint, 'records': records})
    manifest['hostStates'][host] = 'complete'
    manifest['state'] = 'complete' if all(manifest['hostStates'].get(mode) == 'complete' for mode in ('pi', 'omp')) else host + '-complete'
    if manifest['state'] == 'complete':
        pi_records = json.loads((output / 'pi-ledger.json').read_text())['records']
        omp_records = json.loads((output / 'omp-ledger.json').read_text())['records']
        write_json(output / 'ledger.json', {'fingerprint': fingerprint, 'records': pi_records + omp_records})
    write_json(manifest_path, manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('config', 'judge-config', 'data-root', 'selection', 'output'):
        parser.add_argument('--' + key, type=Path, required=True)
    parser.add_argument('--stage', choices=('pilot', 'all'), default='pilot')
    parser.add_argument('--host', choices=('pi', 'omp'), default='pi')
    parser.add_argument('--workers', type=int, choices=(1, 2, 3, 4), default=4)
    parser.add_argument('--reuse-pi-manifest', type=Path, help='Explicit validated prior snapshot provenance; never reuse prior answers')
    args = parser.parse_args()
    run(args)


if __name__ == '__main__':
    main()
