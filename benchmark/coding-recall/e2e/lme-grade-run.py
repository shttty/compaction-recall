"""Grade immutable Chinese LME16 answers; reuse the existing prompt and SDK judge."""
import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import threading
import time

import run as common

HERE = Path(__file__).resolve().parent
e = common.e
judge = common.module('supplement_judge_transport', HERE / 'rejudge-v2.py')
scorer = common.scorer
MEMORY_MAX = 14 * 1024 ** 3
LABELS = ('luna', 'sol')
CURRENT_ARMS = ('pi-native', 'pi-lite', 'pi-full')
REUSED_ARMS = ('pi-concepts', 'pi-grep-fallback', 'pi-restored-grep', *CURRENT_ARMS)


def now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path):
    return json.loads(Path(path).read_text())


def frozen_json(path, value):
    if path.exists():
        if read_json(path) != value:
            raise ValueError('Frozen supplement artifact changed: ' + str(path))
    else:
        e.write_json(path, value)


def verify_files(hashes):
    changed = [filename for filename, digest in hashes.items()
               if not Path(filename).is_file() or common.sha(Path(filename)) != digest]
    if changed:
        raise ValueError('Immutable input bytes changed: ' + ', '.join(changed))


def load_inputs(original):
    manifest = read_json(original / 'manifest.json')
    if manifest.get('state') != 'complete' or manifest['identity']['dataset'] not in ('LME16-Chinese', 'LME16-English'):
        raise ValueError('Requires completed native LME16 run')
    language = 'en' if manifest['identity']['dataset'] == 'LME16-English' else 'zh'
    selected = manifest['selected']
    arms = manifest.get('arms')
    if len(selected) != 16 or len(set(selected)) != 16 or not isinstance(arms, list) or len(arms) != 1 or arms[0] not in ('pi-rawfts', *REUSED_ARMS):
        raise ValueError('Requires the exact original sixteen answers and an authorized arm')
    arm = arms[0]
    if arm in CURRENT_ARMS and language != 'en':
        raise ValueError('Current arms require native English snapshots')
    originals = {}
    for filename in ('manifest.json', 'REPORT.md', 'FINAL.json', 'aggregate.json', 'answer-ledger.json', 'resource.json'):
        path = original / filename
        originals[str(path)] = common.sha(path)
    for name in ('results', 'judge-v2', 'compression'):
        for path in sorted((original / name).rglob('*')):
            if path.is_symlink():
                raise ValueError('Original artifact symlinks are not accepted')
            if path.is_file():
                originals[str(path)] = common.sha(path)
    questions = {q['id']: q for q in manifest['questions']}
    inputs, hashes = [], {}
    for qid in selected:
        question = questions[qid]
        paths = [Path(p) for p in manifest['identity']['inputs']
                 if Path(p).name == ('question.json' if language == 'en' else 'question-zh.json') and Path(p).parent.name == qid]
        if len(paths) != 1:
            raise ValueError('Original question source is ambiguous')
        directory = paths[0].parent
        for name in (('question.json', 'answer.json') if language == 'en' else ('question-zh.json', 'question.json', 'answer.json')):
            path = directory / name
            digest = common.sha(path)
            if manifest['identity']['inputs'].get(str(path)) != digest:
                raise ValueError('Original question/reference source changed')
            hashes[str(path)] = digest
        bilingual = read_json(paths[0])
        english = read_json(directory / 'question.json')
        reference = read_json(directory / 'answer.json')['answer']
        source = original / 'results' / arm / qid / 'result.json'
        answer = read_json(source)
        failed = arm in REUSED_ARMS and answer.get('outcome') not in ('answered', 'missing', 'unknown', 'inflight', 'pending', 'running', None)
        if (bilingual['question'] != question['question'] or (bilingual['question'] if language == 'en' else bilingual['question_en']) != english['question']
                or reference != question['answer'] or answer['question_id'] != qid
                or answer['arm'] != arm or (not failed and answer.get('outcome') != 'answered')
                or not isinstance(answer.get('answer'), str)):
            raise ValueError('Original question/reference/answer identity mismatch')
        if answer.get('session'):
            if common.sha(Path(answer['session'])) != answer['sessionSha256']:
                raise ValueError('Original answer transcript changed')
        elif not failed:
            raise ValueError('Original answer transcript missing')
        fields = {'question_en': english['question'], 'question_zh': '' if language == 'en' else bilingual['question'],
                  'reference_answer': reference, 'model_answer': answer['answer']}
        prompt = scorer.JUDGE_PROMPT + '\n\n' + json.dumps(fields, ensure_ascii=False, allow_nan=False)
        item = {'arm': arm, 'question_id': qid, 'subset': question['subset'], **fields,
                'prompt': prompt, 'inputSha256': e.object_sha({'prompt': prompt}),
                'modelAnswerSha256': hashlib.sha256(answer['answer'].encode()).hexdigest(),
                'originalResultSha256': originals[str(source)], 'originalResultPath': str(source)}
        if failed:
            item['answerFailure'] = answer['outcome']
        inputs.append(item)
    if {group: sum(i['subset'] == group for i in inputs) for group in ('dev8', 'hard8')} != {'dev8': 8, 'hard8': 8}:
        raise ValueError('Original dev8/hard8 coverage changed')
    return manifest, inputs, originals, hashes


def prepare(original, workers=16):
    original_manifest, items, original_hashes, input_hashes = load_inputs(original)
    arm = original_manifest['arms'][0]
    if type(workers) is not int or workers < 1 or workers > 16 or (arm in REUSED_ARMS and workers != 8):
        raise ValueError('Reused-snapshot grading requires exactly eight workers; rawfts permits 1–16')
    output = original / 'grade-1to10'
    output.mkdir(mode=0o700, exist_ok=True)
    freeze = output / 'initial-freeze.json'
    if freeze.exists():
        initial = read_json(freeze)
        if (initial['originalFingerprint'] != original_manifest['fingerprint']
                or initial['originalFilesSha256'] != original_hashes
                or initial['inputFilesSha256'] != input_hashes
                or initial['inputsSha256'] != e.object_sha(items)):
            raise ValueError('Initial immutable grading input freeze changed')
    paths, judges, config_hashes = {}, {}, {}
    for label, model, effort in (('luna', 'gpt-6-luna', 'xhigh'), ('sol', 'gpt-6.1-sol', 'medium')):
        source = original / 'judge-v2' / (label + '-config.json')
        config = read_json(source)
        selected = config['judge']
        if {k: selected[k] for k in ('provider', 'model', 'effort')} != {'provider': 'clp', 'model': model, 'effort': effort}:
            raise ValueError('Judge differs from authorized model/effort')
        # Only config paths; credential profiles remain exclusively host SDK inputs.
        paths[label] = output / (label + '-config.json')
        # Sessions live under results/, so both judges share the supplement output boundary.
        config['output_dir'] = str(output)
        frozen_json(paths[label], config)
        config_hashes[str(source)] = common.sha(source)
        config_hashes[str(paths[label])] = common.sha(paths[label])
        judges[label] = {k: selected[k] for k in ('provider', 'model', 'effort')}
    sources = (Path(__file__), HERE / 'lme-grade-report.py', HERE / 'rejudge-v2.py', HERE / 'judge-pi-rpc.mjs',
               HERE / 'run.py', common.ROOT / 'benchmark/retrieval-score-answers.py',
               common.ROOT / 'benchmark/sdk-rpc.mjs', Path(e.__file__), Path(e.rpc.__file__))
    identity = {'task': 'RSM-ZH16-GRADED-SUPPLEMENT-20261005', 'originalRun': str(original),
                'originalFingerprint': original_manifest['fingerprint'], 'originalFilesSha256': original_hashes,
                'inputFilesSha256': input_hashes, 'sourceSha256': {str(p): common.sha(p) for p in sources},
                'configSha256': config_hashes, 'judges': judges,
                'promptSha256': hashlib.sha256(scorer.JUDGE_PROMPT.encode()).hexdigest(),
                'rule': 'retrieval-score-answers.JUDGE_PROMPT + parse_score; unchanged',
                'inputPolicy': 'question_en/question_zh/reference_answer/full model_answer only; no strict or peer verdict',
                'resourcePolicy': {'questionWorkers': workers, 'providerConcurrencyCeiling': workers,
                                   'memoryMaxBytes': MEMORY_MAX, 'swapMaxBytes': 0},
                'retryPolicy': {'maximumAttempts': 3, 'retryOnly': 'provider-error', 'delaysSeconds': [2, 4]},
                'inputsSha256': e.object_sha(items), 'newCompressionCalls': 0, 'newAnswerCalls': 0,
                'candidateLoaded': False}
    if arm in REUSED_ARMS:
        identity['arm'] = arm
        identity['task'] = original_manifest['identity']['task']
        source = original_manifest['identity']['snapshotSource']
        source_hashes = dict(source['filesSha256'])
        aggregate = read_json(original / 'aggregate.json')
        for row in aggregate['perQuestion']:
            compression = row['compression']
            if compression.get('reused') is not True or compression.get('sourceRun') != source['run']:
                raise ValueError('Concept aggregate compression reuse differs')
            source_hashes.update(compression.get('sourceCostFilesSha256', {}))
        verify_files(source_hashes)
        identity['snapshotSourceFilesSha256'] = source_hashes
    fingerprint = e.object_sha(identity)
    path = output / 'manifest.json'
    if path.exists():
        manifest = read_json(path)
        if manifest['fingerprint'] != fingerprint:
            raise ValueError('Frozen supplement identity changed; refusing resume')
    else:
        manifest = {'fingerprint': fingerprint, 'identity': identity, 'selected': original_manifest['selected'],
                    'state': 'prepared', 'firstValidResult': None}
        e.write_json(path, manifest)
    frozen_json(output / 'inputs.json', items)
    return output, manifest, items, paths, judges


def scope_directory():
    relative = next(line.split('::', 1)[1] for line in Path('/proc/self/cgroup').read_text().split('\n') if line.startswith('0::'))
    scope = Path('/sys/fs/cgroup') / relative.lstrip('/')
    if int((scope / 'memory.max').read_text()) != MEMORY_MAX or int((scope / 'memory.swap.max').read_text()) != 0:
        raise ValueError('Requires one shared MemoryMax=14G / MemorySwapMax=0 scope')
    return scope


def describe(config_path, expected):
    process = subprocess.run(['node', str(HERE / 'judge-pi-rpc.mjs'), '--config', str(config_path),
                              '--phase', 'judge', '--describe'], env=e.child_env(), capture_output=True, text=True)
    if process.returncode:
        raise RuntimeError('Judge descriptor failed; provider details not exposed')
    descriptor = json.loads(process.stdout)
    if any(descriptor[k] != expected[k] for k in ('provider', 'model', 'effort')):
        raise ValueError('Actual SDK judge identity differs')
    return descriptor


def grade_one(item, label, config, selected, output, fingerprint, rpc_runner, capacity_stop=None):
    directory = output / 'results' / label / item['question_id']
    directory.mkdir(parents=True, exist_ok=True)
    identity = e.object_sha({'run': fingerprint, 'judgeName': label, 'arm': item['arm'],
                             'question_id': item['question_id'], 'inputSha256': item['inputSha256']})
    def operation():
        if item.get('answerFailure'):
            return {key: item[key] for key in ('arm', 'question_id', 'inputSha256', 'originalResultSha256')} | {
                'judgeName': label, 'status': 'answer-failure-not-scored', 'verdict': None,
                'answerFailure': item['answerFailure'], 'attempts': [], 'supplementFingerprint': fingerprint}
        attempts = []
        for number in range(1, 4):
            folder = directory / 'attempts' / f'{number:02d}'
            record = judge.judge_one(item, label, config, selected, folder, fingerprint + '/' + str(number),
                                     rpc_runner=rpc_runner, verdict_parser=lambda text, answer: scorer.parse_score(text))
            attempts.append({'attempt': number, 'status': record['status'], 'path': str(folder / 'result.json')})
            capacity = common.capacity_error(record)
            if capacity:
                if capacity_stop:
                    capacity_stop(item, label, capacity)
                break
            if record['status'] != 'provider-error' or number == 3:
                break
            time.sleep(2 ** number)
        result = dict(record)
        result['attempts'] = attempts
        result['supplementFingerprint'] = fingerprint
        return result
    result = common.durable_phase(directory, 'result', identity, operation)
    if result['status'] == 'graded' and scorer.parse_score(result['rawVerdict']) != result['verdict']:
        raise ValueError('Cached grade differs from raw validated verdict')
    for attempt in result['attempts']:
        path = Path(attempt['path'])
        state = read_json(path.parent / 'result-state.json')
        if state['state'] != 'complete' or common.sha(path) != state['resultSha256']:
            raise ValueError('Cached attempt bytes changed')
        saved = read_json(path)
        if saved.get('session') and common.sha(Path(saved['session'])) != saved['sessionSha256']:
            raise ValueError('Cached attempt session bytes changed')
        if saved.get('effortEvidence') and common.sha(Path(saved['effortEvidence']['path'])) != saved['effortEvidence']['sha256']:
            raise ValueError('Cached wire effort bytes changed')
    return result


def run(original, *, workers=16, rpc_runner=None, scope=None, descriptor=None):
    scope = scope or scope_directory()
    output, manifest, items, configs, selected = prepare(original, workers=workers)
    if manifest['state'] == 'complete':
        verify_files(manifest['identity']['originalFilesSha256'])
        verify_files(manifest['identity']['inputFilesSha256'])
        verify_files(manifest['identity'].get('snapshotSourceFilesSha256', {}))
        for item in items:
            for label in LABELS:
                grade_one(item, label, configs[label], selected[label], output, manifest['fingerprint'],
                          lambda *a, **k: (_ for _ in ()).throw(RuntimeError('Completed resume cannot call provider')))
        return manifest
    if manifest['state'] == 'capacity-blocked':
        verify_files(manifest['identity']['originalFilesSha256'])
        verify_files(manifest['identity']['inputFilesSha256'])
        verify_files(manifest['identity'].get('snapshotSourceFilesSha256', {}))
        reporter = common.module('supplement_report', HERE / 'lme-grade-report.py')
        reporter.write_report(output)
        return manifest
    manifest['descriptors'] = {label: (descriptor or describe)(configs[label], selected[label]) for label in LABELS}
    lock = threading.RLock()
    active_questions, provider_active, peak_questions, peak_providers = set(), 0, 0, 0
    records = []
    stopped = threading.Event()
    def capacity_stop(item, label, message):
        with lock:
            stopped.set()
            manifest.setdefault('capacityBlock', {'question_id': item['question_id'], 'judgeName': label,
                                                 'error': message})
            manifest['state'] = 'capacity-blocked'
    for item in items:
        for label in LABELS:
            path = output / 'results' / label / item['question_id'] / 'result.json'
            if path.exists(): records.append(read_json(path))
    started = time.monotonic()
    manifest.setdefault('startedAt', now())
    manifest['state'] = 'running'
    def persist():
        with lock:
            e.write_json(output / 'manifest.json', manifest)
            e.write_json(output / 'ledger.json', {'fingerprint': manifest['fingerprint'], 'records': records})
            resource = {'state': manifest['state'], 'cgroupPath': str(scope), 'scopeName': scope.name,
                        'memoryMaxBytes': MEMORY_MAX, 'swapMaxBytes': 0,
                        'memoryPeakBytes': int((scope / 'memory.peak').read_text()),
                        'questionWorkers': workers, 'providerConcurrencyCeiling': workers,
                        'peakActiveQuestions': peak_questions, 'activeQuestions': len(active_questions),
                        'peakActiveProviderRequests': peak_providers, 'activeProviderRequests': provider_active,
                        'startedAt': manifest['startedAt'], 'finishedAt': manifest.get('finishedAt'),
                        'wallSeconds': manifest.get('wallSeconds')}
            if manifest['identity'].get('arm') in REUSED_ARMS:
                resource['memoryPeakScope'] = 'Shared cumulative outer scope including native answer/strict and graded sessions; not an isolated graded-stage increment'
            e.write_json(output / 'resource.json', resource)
    def observed_rpc(command, env, directory, **kwargs):
        nonlocal provider_active, peak_providers
        if command[command.index('--phase') + 1] != 'judge' or '--plugin-dir' in command:
            raise ValueError('Supplement permits tool-free judge only')
        with lock:
            provider_active += 1
            peak_providers = max(peak_providers, provider_active)
            if provider_active > workers: raise ValueError('Provider concurrency exceeded worker ceiling')
            persist()
        try:
            observed = (rpc_runner or e.rpc.run_rpc)(command, env, directory, collect_memory=True, **kwargs)
            e.write_json(Path(directory) / 'process-memory.json', observed.get('memory'))
            return observed
        finally:
            with lock:
                provider_active -= 1
                persist()
    def question_worker(item):
        nonlocal peak_questions
        qid = item['question_id']
        with lock:
            active_questions.add(qid)
            peak_questions = max(peak_questions, len(active_questions))
            persist()
        try:
            for label in LABELS:
                if stopped.is_set():
                    break
                result = grade_one(item, label, configs[label], selected[label], output, manifest['fingerprint'], observed_rpc, capacity_stop)
                capacity = common.capacity_error(result)
                if capacity:
                    capacity_stop(item, label, capacity)
                with lock:
                    records[:] = [r for r in records if (r['question_id'], r['judgeName']) != (qid, label)]
                    records.append(result)
                    if result['status'] == 'graded' and manifest['firstValidResult'] is None:
                        manifest['firstValidResult'] = {'question_id': qid, 'judgeName': label,
                                                       'path': str(output / 'results' / label / qid / 'result.json'),
                                                       'reusedInFinalScores': True}
                    persist()
                print(json.dumps({'judge': label, 'id': qid, 'status': result['status'],
                                  'score': (result.get('verdict') or {}).get('score'),
                                  'durableResults': len(records)}), flush=True)
        finally:
            with lock:
                active_questions.remove(qid)
                persist()
    persist()
    print('ZH16_GRADE_SCOPE_READY ' + json.dumps({'fingerprint': manifest['fingerprint'], 'scope': scope.name,
                                                'questionWorkers': workers, 'providerCeiling': workers}), flush=True)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        remaining = iter(items)
        futures = {pool.submit(question_worker, item) for item in [next(remaining) for _ in range(min(workers, len(items)))]}
        while futures:
            done, futures = wait(futures, return_when=FIRST_COMPLETED)
            for future in done:
                future.result()
            if not stopped.is_set():
                for _ in done:
                    item = next(remaining, None)
                    if item is None:
                        break
                    futures.add(pool.submit(question_worker, item))
    verify_files(manifest['identity']['originalFilesSha256'])
    verify_files(manifest['identity']['inputFilesSha256'])
    verify_files(manifest['identity'].get('snapshotSourceFilesSha256', {}))
    manifest['state'] = 'capacity-blocked' if stopped.is_set() else 'complete'
    manifest['finishedAt'] = now()
    manifest['wallSeconds'] = time.monotonic() - started
    manifest['outcomes'] = {label: {status: sum(r['judgeName'] == label and r['status'] == status for r in records)
                                  for status in (('graded', 'judge-error', 'provider-error', 'answer-failure-not-scored')
                                                 if manifest['identity'].get('arm') in REUSED_ARMS else ('graded', 'judge-error', 'provider-error'))} for label in LABELS}
    persist()
    e.write_json(output / 'verification.json', {'state': 'verified',
                 'originalFilesChecked': len(manifest['identity']['originalFilesSha256']),
                 'inputFilesChecked': len(manifest['identity']['inputFilesSha256']),
                 'originalChangedFiles': [], 'inputsChangedFiles': [], 'newCompressionCalls': 0,
                 'newAnswerCalls': 0, 'candidateLoaded': False})
    reporter = common.module('supplement_report', HERE / 'lme-grade-report.py')
    reporter.write_report(output)
    print(json.dumps({'state': manifest['state'], 'outcomes': manifest['outcomes'],
                      'peakActiveQuestions': peak_questions, 'peakActiveProviderRequests': peak_providers}), flush=True)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original', type=Path, required=True, help='Completed immutable Chinese16 run')
    parser.add_argument('--prepare-only', action='store_true', help='Freeze hashes/configuration without provider calls')
    parser.add_argument('--workers', type=int, default=16, help='Question/RPC ceiling; reused-snapshot arms require 8')
    args = parser.parse_args()
    if args.prepare_only:
        output, manifest, *_ = prepare(args.original.resolve(), workers=args.workers)
        print(json.dumps({'state': manifest['state'], 'fingerprint': manifest['fingerprint'], 'output': str(output)}))
    else:
        run(args.original.resolve(), workers=args.workers)
