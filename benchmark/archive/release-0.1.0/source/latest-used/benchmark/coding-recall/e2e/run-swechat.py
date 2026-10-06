"""Task-only SWE-chat DEV8 connection to existing durable answer/judge boundaries."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
HERE = ROOT / 'benchmark/coding-recall/e2e'
sys.path.insert(0, str(HERE))
import run as common
live = common.module('swechat_existing_live', HERE / 'lme-zh-run.py')
r2, e = live.r2, common.e
scorer = common.scorer
OUT = Path(__file__).resolve().parent
DATA = OUT
ARM = 'pi-restored-grep'
MEMORY = 14 * 1024 ** 3
load = lambda path: json.loads(Path(path).read_text())


def prepare():
    frozen = load(DATA / 'freeze.json')
    live.verify_files(frozen['filesSha256'], 'Frozen questions/gold/evidence/native snapshots')
    config, _, _ = e.configuration.load(CONFIG, ROOT)
    config.update(output_dir=str(OUT), data_path=str(DATA / 'questions.json'))
    r2.frozen_json(OUT / 'config.json', config)
    r2.frozen_json(OUT / 'recall-config.json', {'mode': 'full', 'trace': True, 'autoGate': 280, 'snippetBudget': 240, 'recallTimeoutMs': 5000})
    pins = load(PINNED / 'pins.json')
    pin = pins['sqlite']
    candidate = load(PINNED / 'candidate/candidate.json')
    if pin['commit'] != COMMIT or candidate['snapshotCommit'] != pin['commit']:
        raise ValueError('Candidate commit changed')
    if common.sha(Path(candidate['archivePath'])) != pin['archiveSha256']:
        raise ValueError('Candidate archive changed')
    live.verify_files({str(Path(pin['path']) / name): digest for name, digest in pin['runtimeClosureSha256'].items()}, 'Pinned runtime closure')
    pin['configuration'] = {**live.FIXED_ENV, 'COMPACTION_RECALL_SQLITE_HAN_PHRASE_TRIAL': 'jieba'}
    if candidate['configuration'] != pin['configuration']:
        raise ValueError('Candidate environment changed')
    questions = load(DATA / 'questions.json')
    gold = load(DATA / 'gold.json')
    if len(questions) != 8 or len({q['id'] for q in questions}) != 8 or set(gold) != {q['id'] for q in questions}:
        raise ValueError('Requires exactly eight frozen questions')
    questions = [{**q, 'answer': gold[q['id']]['answer']} for q in questions]
    e.CONFIG, e.CONFIG_PATH = config, OUT / 'config.json'
    e.b = e.configuration.load_helper(Path(config['helper_path']), config)
    configs, paths = {}, {}
    for label in ('luna', 'sol'):
        own = {**config, 'judge': load(JUDGE_CONFIGS[label])['judge'],
               'output_dir': str(OUT / 'judge-v2' / label)}
        Path(own['output_dir']).mkdir(parents=True, exist_ok=True)
        paths[label] = OUT / 'judge-v2' / (label + '-config.json')
        r2.frozen_json(paths[label], own)
        configs[label] = own
    prior = load(TOOL_DEFINITION_MANIFEST)
    preflight = load(TOOL_DEFINITION_MANIFEST)['preflight']
    live.verify_files({v['path']: v['sha256'] for v in preflight.values()}, 'Reused native tool definitions')
    sources = [Path(__file__), HERE / 'run.py', HERE / 'round2-run.py', HERE / 'lme-zh-run.py', HERE / 'lme-zh-rpc.mjs',
               HERE / 'rejudge-v2.py', HERE / 'judge-v2.py', HERE / 'judge-pi-rpc.mjs', HERE / 'plugin.mjs',
               HERE / 'round2-tools.mjs', HERE / 'round3-context.mjs', ROOT / 'benchmark/sdk-rpc.mjs',
               ROOT / 'benchmark/pi-context-estimate.mjs', ROOT / 'benchmark/retrieval-score-answers.py', Path(e.__file__), Path(e.rpc.__file__)]
    identity = {'task': TASK, 'dataset': 'SWE-chat-Pi-DEV8',
                'inputs': frozen['filesSha256'], 'sources': {str(p): common.sha(p) for p in sources}, 'config': config,
                'pins': {'sqlite': pin}, 'candidateArchive': candidate['archivePath'], 'candidateArchiveSha256': pin['archiveSha256'],
                'judgeConfigs': configs, 'preflight': preflight, 'answerEstimate': 'diagnostic-only', 'actualOutputBudget': 'unchanged',
                'maxConcurrentSessions': 8, 'memoryMaxBytes': MEMORY, 'swapMaxBytes': 0, 'newCompressionCalls': 0,
                'retryPolicy': 'existing provider-only maximum3 delays2/4; no capacity retry; unknown inflight fails closed',
                'strictPromptSha256': e.object_sha(r2.judge.contract.JUDGE_V2_PROMPT),
                'gradedPromptSha256': e.object_sha(scorer.JUDGE_PROMPT)}
    fingerprint = e.object_sha(identity)
    manifest = {'fingerprint': fingerprint, 'identity': identity, 'questions': questions, 'selected': [q['id'] for q in questions],
                'arms': [ARM], 'snapshots': {'pi/' + q['id']: {'path': q['snapshot'], 'sha256': q['snapshotSha256']} for q in questions},
                'preflight': preflight, 'answerDescriptor': prior['answerDescriptor'], 'state': 'prepared'}
    if (OUT / 'manifest.json').exists():
        saved = load(OUT / 'manifest.json')
        if saved['fingerprint'] != fingerprint:
            raise ValueError('Frozen run identity changed; refuse resume')
        manifest = saved
    else:
        e.write_json(OUT / 'manifest.json', manifest)
    return config, pins, manifest, configs, paths


def main():
    scope = live.whole_scope()
    config, pins, manifest, configs, paths = prepare()
    launch = {'pid': os.getpid(), 'scope': scope.name, 'cgroupPath': str(scope), 'startedUnixSeconds': time.time(),
              'workers': 8, 'memoryMaxBytes': MEMORY, 'swapMaxBytes': 0, 'newCompressionCalls': 0}
    if not (OUT / 'launch.json').exists():
        e.write_json(OUT / 'launch.json', launch)
    stop = threading.Event()
    lock = threading.RLock()
    slots = threading.BoundedSemaphore(8)
    gauges = {'activeRpcSessions': 0, 'peakActiveRpcSessions': 0, 'phaseCounts': {}, 'capacityRejection': None}

    def persist():
        with lock:
            e.write_json(OUT / 'manifest.json', manifest)
            e.write_json(OUT / 'resource.json', {**launch, **gauges, 'memoryPeakBytes': int((scope / 'memory.peak').read_text()), 'state': manifest['state']})
            for phase, glob in [('answer', 'results/*/*/result.json'), ('strict', 'judge-v2/*/*/*/result.json'), ('graded', 'grade-1to10/results/*/*/result.json')]:
                records = [load(p) for p in sorted(OUT.glob(glob))]
                e.write_json(OUT / (phase + '-ledger.json'), {'fingerprint': manifest['fingerprint'], 'records': records})

    def capacity(record):
        message = common.capacity_error(record)
        if message is not None:
            with lock:
                stop.set()
                gauges['capacityRejection'] = gauges['capacityRejection'] or {'id': record.get('question_id'), 'session': record.get('session'), 'error': e.safe_error(message)}
                persist()
        return stop.is_set()

    def rpc(command, env, directory, **kwargs):
        with slots:
            with lock:
                if stop.is_set():
                    raise RuntimeError('New request blocked after actual provider capacity rejection')
                phase = command[command.index('--phase') + 1]
                gauges['activeRpcSessions'] += 1
                gauges['peakActiveRpcSessions'] = max(gauges['peakActiveRpcSessions'], gauges['activeRpcSessions'])
                gauges['phaseCounts'][phase] = gauges['phaseCounts'].get(phase, 0) + 1
                persist()
            try:
                observed = live.plain_rpc(command, env, directory, **kwargs)
                session = Path(command[command.index('--session') + 1])
                if session.exists():
                    assistants = [x['message'] for x in common.transcript(session) if x.get('message', {}).get('role') == 'assistant']
                    if assistants and assistants[-1].get('stopReason') == 'error':
                        capacity({'status': 'provider-error', 'providerError': assistants[-1].get('errorMessage', ''), 'session': str(session)})
                return observed
            finally:
                with lock:
                    gauges['activeRpcSessions'] -= 1
                    persist()

    r2.scoped_rpc = rpc
    r2.scope_command = lambda command: command
    r2.scope_env = e.child_env
    print('SWECHAT_SCOPE_READY ' + json.dumps(launch), flush=True)
    answers = {}
    def answer(q):
        if stop.is_set(): return None
        snap = Path(q['snapshot'])
        estimate = subprocess.run(['node', str(ROOT / 'benchmark/pi-context-estimate.mjs'), '--sdk-path', config['sdk_path'], '--session', str(snap)],
                                  capture_output=True, text=True, check=True, env=e.child_env())
        folder = OUT / 'results' / ARM / q['id']
        folder.mkdir(parents=True, exist_ok=True)
        e.write_json(folder / 'answer-context-budget.json', {**json.loads(estimate.stdout), 'policy': 'diagnostic-only', 'actualOutputBudget': 'unchanged'})
        result = r2.answer_one(OUT, config, pins, manifest, q, ARM, command_factory=live.answer_command, stop_retry=capacity)
        with lock:
            answers[q['id']] = result
            persist()
        print('SWECHAT_ANSWER ' + json.dumps({'id': q['id'], 'outcome': result['outcome'], 'result': str(folder / 'result.json')}), flush=True)
        return result

    manifest['state'] = 'answering'; persist()
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = [pool.submit(answer, q) for q in manifest['questions']]
        for job in concurrent.futures.as_completed(jobs): job.result()
    if not stop.is_set():
        manifest['state'] = 'judging'; persist()
        def judge(q, label, style):
            if stop.is_set(): return None
            answer_result = answers[q['id']]
            if style == 'strict':
                result = r2.judge_one(OUT, manifest, paths, configs, q, ARM, answer_result, label, stop_retry=capacity)
            else:
                fields = {'question_en': q['question'], 'question_zh': '', 'reference_answer': q['answer'], 'model_answer': answer_result['answer']}
                prompt = scorer.JUDGE_PROMPT + '\n\n' + json.dumps(fields, ensure_ascii=False, allow_nan=False)
                item = {'arm': ARM, 'question_id': q['id'], 'model_answer': answer_result['answer'], 'prompt': prompt,
                        'inputSha256': e.object_sha({'prompt': prompt}), 'originalResultSha256': common.sha(OUT / 'results' / ARM / q['id'] / 'result.json')}
                directory = OUT / 'grade-1to10/results' / label / q['id']
                directory.mkdir(parents=True, exist_ok=True)
                identity = e.object_sha({'run': manifest['fingerprint'], 'label': label, 'id': q['id'], 'input': item['inputSha256']})
                def grade():
                    if answer_result['outcome'] != 'answered':
                        return {'question_id': q['id'], 'judgeName': label, 'status': 'answer-failure', 'verdict': None, 'attempts': []}
                    attempts = []
                    for number in range(1, 4):
                        saved = r2.judge.judge_one(item, label, grade_paths[label], configs[label]['judge'], directory / 'attempts' / f'{number:02d}',
                                                 manifest['fingerprint'] + '/graded/' + str(number), rpc_runner=rpc,
                                                 verdict_parser=lambda text, unused: scorer.parse_score(text))
                        attempts.append({'path': str(directory / 'attempts' / f'{number:02d}' / 'result.json'), 'status': saved['status']})
                        if capacity(saved) or saved['status'] != 'provider-error' or number == 3: break
                        time.sleep(2 ** number)
                    return {**saved, 'attempts': attempts}
                result = common.durable_phase(directory, 'result', identity, grade)
            persist()
            print('SWECHAT_JUDGE ' + json.dumps({'id': q['id'], 'label': label, 'style': style, 'status': result['status']}), flush=True)
            return result
        grade_paths = {}
        for label in ('luna', 'sol'):
            own = {**configs[label], 'output_dir': str(OUT / 'grade-1to10')}
            Path(own['output_dir']).mkdir(parents=True, exist_ok=True)
            grade_paths[label] = OUT / 'grade-1to10' / (label + '-config.json')
            r2.frozen_json(grade_paths[label], own)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            jobs = [pool.submit(judge, q, label, style) for q in manifest['questions'] for label in ('luna', 'sol') for style in ('strict', 'graded')]
            for job in concurrent.futures.as_completed(jobs): job.result()
    live.verify_files(manifest['identity']['inputs'], 'Frozen task inputs')
    live.verify_files(manifest['identity']['sources'], 'Execution source')
    manifest['state'] = 'capacity-blocked' if stop.is_set() else 'complete'
    persist()
    print('SWECHAT_COMPLETE ' + json.dumps({'state': manifest['state'], 'answers': len(answers), 'capacityRejection': gauges['capacityRejection']}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--luna-config', type=Path, required=True)
    parser.add_argument('--sol-config', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--candidate-root', type=Path, required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--task', required=True)
    parser.add_argument('--tool-definition-manifest', type=Path, required=True)
    args = parser.parse_args()
    OUT, DATA, PINNED, COMMIT, TASK = args.output, args.data_root, args.candidate_root, args.commit, args.task
    TOOL_DEFINITION_MANIFEST = args.tool_definition_manifest
    CONFIG = args.config
    JUDGE_CONFIGS = {'luna': args.luna_config, 'sol': args.sol_config}
    main()
