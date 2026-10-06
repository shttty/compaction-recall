"""Independent 1–10 grading of immutable current answers; no solver/candidate loading."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import threading
import time
import run as common
import prepare as preparation
import phases

HERE = Path(__file__).resolve().parent
LABELS = preparation.LABELS


def load_inputs(original):
    manifest = json.loads((original / 'manifest.json').read_text())
    if (manifest['state'] != 'complete' or manifest['fingerprint'] != common.object_sha(manifest['identity'])
            or common.object_sha(manifest['questions']) != manifest['identity']['questionsSha256']
            or common.object_sha(manifest['snapshots']) != manifest['identity']['snapshotsSha256']):
        raise ValueError('Requires complete identity-bound answer/strict run')
    preparation.verify_files(manifest['identity']['inputs'])
    preparation.verify_files(manifest['identity']['snapshotSource']['filesSha256'])
    arm = manifest['arms'][0]
    items = []
    for question in manifest['questions']:
        path = original / 'results' / arm / question['id'] / 'result.json'
        identity = common.object_sha({'run': manifest['fingerprint'], 'tools': manifest['toolEvidence'][arm]['sha256'],
                                      'arm': arm, 'id': question['id']})
        if not path.is_file():
            raise ValueError('Completed answer missing')
        answer = common.durable_phase(path.parent, 'result', identity, lambda: None)
        if answer['question_id'] != question['id'] or answer['arm'] != arm:
            raise ValueError('Answer question/arm binding changed')
        if answer.get('session'):
            preparation.verify_files({answer['session']: answer['sessionSha256']})
        fields = {'question_en': question['question'], 'question_zh': '',
                  'reference_answer': question['answer'], 'model_answer': answer['answer']}
        prompt = common.scorer.JUDGE_PROMPT + '\n\n' + json.dumps(fields, ensure_ascii=False, allow_nan=False)
        item = {'question_id': question['id'], 'arm': arm, 'subset': question['subset'], **fields,
                'prompt': prompt, 'inputSha256': common.object_sha({'prompt': prompt}),
                'originalResultPath': str(path), 'originalResultSha256': common.sha(path)}
        if answer['outcome'] != 'answered':
            item['answerFailure'] = answer['outcome']
        items.append(item)
    return manifest, items


def grade_one(item, label, config, selected, output, fingerprint, rpc_runner, capacity_stop=None):
    directory = output / 'results' / label / item['question_id']
    directory.mkdir(parents=True, exist_ok=True)
    identity = common.object_sha({'run': fingerprint, 'judgeName': label, 'arm': item['arm'],
                                  'question_id': item['question_id'], 'inputSha256': item['inputSha256']})
    def operation():
        if item.get('answerFailure'):
            return {'question_id': item['question_id'], 'arm': item['arm'], 'judgeName': label,
                    'status': 'answer-failure', 'verdict': None, 'answerOutcome': item['answerFailure'], 'attempts': []}
        attempts = []
        for number in range(1, 4):
            saved = phases.judge.judge_one(item, label, config, selected,
                directory / 'attempts' / f'{number:02d}', fingerprint + '/' + str(number), rpc_runner=rpc_runner,
                verdict_parser=lambda raw, answer: common.scorer.parse_score(raw))
            attempts.append(saved)
            if (capacity_stop is not None and capacity_stop(saved)) or saved['status'] != 'provider-error' or number == 3:
                break
            time.sleep(2 ** number)
        result = dict(attempts[-1])
        result['attempts'] = [{'attempt': n + 1, **{k: record.get(k) for k in ('status', 'session', 'sessionSha256', 'seconds')}} for n, record in enumerate(attempts)]
        return result
    return common.durable_phase(directory, 'result', identity, operation)


def run(original, *, workers=8, rpc_runner=None, scope=None):
    if type(workers) is not int or not 1 <= workers <= 8:
        raise ValueError('Grading worker ceiling is eight')
    original = Path(original).resolve()
    source, items = load_inputs(original)
    live = common.module('grade_resource_scope', HERE / 'lme-zh-run.py')
    scope = scope or live.whole_scope()
    output = original / 'grade-1to10'
    output.mkdir(mode=0o700, exist_ok=True)
    paths, selected = {}, {}
    for label in LABELS:
        config = json.loads((original / 'judge-v2' / (label + '-config.json')).read_text())
        selected[label] = config['judge']
        config['output_dir'] = str(output)
        paths[label] = output / (label + '-config.json')
        preparation.frozen_json(paths[label], config)
    identity = {'originalFingerprint': source['fingerprint'], 'inputs': items,
                'judges': selected, 'workers': workers,
                'promptSha256': hashlib.sha256(common.scorer.JUDGE_PROMPT.encode()).hexdigest()}
    fingerprint = common.object_sha(identity)
    path = output / 'manifest.json'
    if path.exists():
        manifest = json.loads(path.read_text())
        if manifest['fingerprint'] != fingerprint:
            raise ValueError('Frozen grading identity changed')
    else:
        manifest = {'fingerprint': fingerprint, 'identity': identity, 'state': 'prepared', 'completed': [], 'failures': {}}
        common.write_json(path, manifest)
    preparation.frozen_json(output / 'inputs.json', items)
    lock, stop = threading.RLock(), threading.Event()
    if manifest.get('capacityRejection'):
        stop.set()
    slots = threading.BoundedSemaphore(workers)
    active, peak = 0, 0
    def persist():
        with lock:
            common.write_json(path, manifest)
            common.write_json(output / 'resource.json', {'memoryMaxBytes': 14 * 1024 ** 3, 'swapMaxBytes': 0,
                'memoryPeakBytes': int((scope / 'memory.peak').read_text()), 'workers': workers,
                'activeProviderRequests': active, 'peakActiveProviderRequests': peak})
    def measured(command, env, directory, **kwargs):
        nonlocal active, peak
        with slots:
            with lock:
                active += 1
                peak = max(peak, active)
                persist()
            try:
                return (rpc_runner or common.rpc.run_rpc)(command, env, directory, **kwargs)
            finally:
                with lock:
                    active -= 1
                    persist()
    def capacity(record):
        message = common.capacity_error(record)
        if message is not None:
            with lock:
                manifest.setdefault('capacityRejection', {'id': record['question_id'], 'session': record.get('session'), 'message': common.safe_error(message)})
                stop.set()
                persist()
        return message is not None
    def case(item):
        if stop.is_set():
            return
        judged = {}
        for label in LABELS:
            if stop.is_set():
                return
            judged[label] = grade_one(item, label, paths[label], selected[label], output, fingerprint, measured, capacity)
            if judged[label]['status'] != 'graded':
                with lock:
                    manifest['failures'].setdefault(item['question_id'], {})[label] = judged[label]['status']
                    persist()
        with lock:
            if all(row['status'] == 'graded' for row in judged.values()) and item['question_id'] not in manifest['completed']:
                manifest['completed'].append(item['question_id'])
            persist()
    if manifest['state'] in ('complete', 'partial', 'failed', 'capacity-blocked'):
        def refuse(*args, **kwargs):
            raise ValueError('Completed grade refuses provider replay')
        for item in items:
            for label in LABELS:
                if not (output / 'results' / label / item['question_id'] / 'result.json').is_file():
                    if manifest['state'] == 'complete':
                        raise ValueError('Completed grade result missing')
                    continue
                grade_one(item, label, paths[label], selected[label], output, fingerprint, refuse)
        return manifest
    manifest['state'] = 'running'
    persist()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = [pool.submit(case, item) for item in items]
        for job in as_completed(jobs):
            job.result()
    preparation.verify_files({item['originalResultPath']: item['originalResultSha256'] for item in items})
    manifest['state'] = ('capacity-blocked' if stop.is_set() else 'complete' if len(manifest['completed']) == len(items)
                         else 'partial' if manifest['completed'] else 'failed')
    persist()
    return manifest
