"""Current fixed-snapshot flow: artifact integrity and durable SDK phases."""
import hashlib
import os
import uuid
import importlib.util
import json
import re
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

CONFIG = CONFIG_PATH = None
b = module('current_ask', ROOT / 'benchmark/runner/answer_prompt.py')
rpc = module('current_rpc', ROOT / 'benchmark/sdk/observer.py')
scorer = module('coding_scorer', ROOT / 'benchmark/judging/score_contract.py')
def child_env(source=None):
    allowed = {"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SYSTEMROOT"}
    return {k: v for k, v in (os.environ if source is None else source).items() if k in allowed}


def write_json(path, value, private=True):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as output:
        output.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        if private:
            os.fchmod(output.fileno(), 0o600)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def object_sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def safe_error(text):
    """Never open credential resources merely to format diagnostics.

    Provider text can contain arbitrary unlabelled secrets. Retain only fixed
    local integrity labels; unknown details are deliberately not persisted.
    """
    message = str(text)
    if not message:
        return ""
    for label in ('Saved phase identity changed', 'Saved phase output bytes changed',
                  'Saved transcript bytes changed', 'Judge provider failed'):
        if label in message:
            return label
    if "inflight" in message.lower():
        return "Unknown inflight phase; implicit provider replay refused"
    return "Untrusted diagnostic omitted (no credential access)"


def answer_outcome(outcome, text, terminal=None):
    if terminal == "error" or outcome not in ("completed", "offline-ready"):
        return "model-error"
    if not text.strip():
        return "empty-answer"
    return "answered"

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


def transcript(path):
    return [json.loads(line) for line in path.read_text().split('\n') if line]


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
    if any(message.get('provider') != CONFIG['answer']['provider'] or message.get('model') != CONFIG['answer']['model'] for message in assistants):
        raise ValueError('Answer transcript uses an unexpected model')
    usage = [message['usage'] for message in assistants if isinstance(message.get('usage'), dict)]
    tokens = {key: sum(row.get(key, 0) or 0 for row in usage) for key in ('input', 'output', 'cacheRead', 'cacheWrite')} if usage else None
    return {'question_id': question['id'], 'arm': arm, 'outcome': answer_outcome(observed['outcome'], text, final.get('stopReason')),
            'answer': text, 'tool_calls': [call['name'] for call in calls], 'toolErrors': sum(bool(row.get('isError')) for row in results),
            'toolResults': [{'toolName': row['toolName'], 'toolCallId': row['toolCallId'], 'isError': bool(row.get('isError')),
                             'arguments': call_ids[(row['toolCallId'], row['toolName'])].get('arguments'),
                             'content': row.get('content', []), 'details': row.get('details')} for row in results],
            'answerWallMs': elapsed, 'timing': observed['timing'], 'tokens': tokens, 'modelCalls': len(assistants),
            'providerError': safe_error(final.get('errorMessage', '')) if final.get('stopReason') == 'error' else None,
            'rc': observed['rc'], 'error': safe_error(observed.get('stderr', '')) if observed['rc'] else None,
            'snapshotSha256': sha(snapshot), 'sessionSha256': sha(path), 'session': str(path),
            'metadata': {key: question.get(key) for key in ('caseId', 'subset', 'language', 'type', 'overlap')}}


def durable_phase(directory, name, identity, operation):
    path, marker = directory / f'{name}.json', directory / f'{name}-state.json'
    if path.exists():
        record = json.loads(path.read_text())
        if record.get('identity') != identity:
            raise ValueError('Saved phase identity changed')
        if not marker.exists():
            raise ValueError('Saved phase completion evidence missing; implicit provider replay refused')
        state = json.loads(marker.read_text())
        if state.get('identity') != identity:
            raise ValueError('Saved phase identity changed')
        if state.get('state') != 'complete':
            raise ValueError('Unknown inflight or incomplete phase refuses implicit provider replay')
        if state.get('resultSha256') != sha(path):
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


def answer_system_prompt(question):
    return b.ASK.format(question['question_date'], '').partition('\nQuestion:')[0].rstrip()
