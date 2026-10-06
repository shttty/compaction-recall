"""Current English LME16 fixed-snapshot native/lite/full answer, grade, report and resume."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import subprocess
import threading
import run as common
import phases as r2
import prepare as preparation
HERE = Path(__file__).resolve().parent
CURRENT_ARMS = preparation.ARMS
MEMORY_MAX = 14 * 1024 ** 3
prepare = preparation.prepare
verify_files = preparation.verify_files


def whole_scope():
    relative = next(line.split('::', 1)[1] for line in Path('/proc/self/cgroup').read_text().split('\n') if line.startswith('0::'))
    directory = Path('/sys/fs/cgroup') / relative.lstrip('/')
    if int((directory / 'memory.max').read_text()) != MEMORY_MAX or int((directory / 'memory.swap.max').read_text()) != 0:
        raise ValueError('Entire runner must inherit one MemoryMax=14G / MemorySwapMax=0 scope')
    return directory


def plain_rpc(command, env, directory, **kwargs):
    observed = common.rpc.run_rpc(command, env, directory, collect_memory=True, **kwargs)
    common.write_json(Path(directory) / 'process-memory.json', observed.get('memory'))
    return observed


def answer_command(output, config, pins, arm, folder, session, evidence, expected=None, stop=False):
    command = ['node', str(HERE / 'lme-zh-rpc.mjs'), '--config', str(output / 'config.json'), '--phase', 'answer',
               '--session', str(session), '--append-system-prompt', str(folder / 'answer-system.txt')]
    if arm == 'pi-native':
        command.extend(['--arm', 'native', '--tool-evidence', str(evidence)])
        if expected:
            command.extend(['--expected-tools', str(expected)])
        if stop:
            command.append('--stop-after-serialization')
        return command
    directory = folder / 'wrapper'
    directory.mkdir(parents=True, exist_ok=True)
    pin = pins['sqlite']
    settings = {'entry': str(Path(pin['path']) / pin['entry']), 'sdkPath': config['sdk_path'],
                'runtimeEvidencePath': str(folder / 'sdk-registration.json')}
    options = {'evidencePath': str(evidence), 'expectedPath': str(expected) if expected else None, 'stopAfterSerialization': stop}
    if arm == 'pi-lite':
        options['expectedTools'] = ['history_expand', 'history_grep']
    context = {'directory': str(folder), 'toolsOnly': arm == 'pi-lite'}
    content = (f"import {{ registerPinned }} from {json.dumps(str(HERE / 'plugin.mjs'))};\n"
               f"import {{ withToolEvidence }} from {json.dumps(str(HERE / 'round2-tools.mjs'))};\n"
               f"import {{ withContextEvidence }} from {json.dumps(str(HERE / 'round3-context.mjs'))};\n"
               f"export default async pi => {{ "
               f"await registerPinned(withToolEvidence(withContextEvidence(pi, {json.dumps(context)}), {json.dumps(options)}), {json.dumps(settings)}); }};\n")
    entry = directory / 'entry.mjs'
    if entry.exists() and entry.read_text() != content:
        raise ValueError('Frozen answer wrapper changed')
    if not entry.exists():
        entry.write_text(content)
    preparation.frozen_json(directory / 'package.json', {'type': 'module', 'pi': {'extensions': ['./entry.mjs']}})
    entry.chmod(0o444); (directory / 'package.json').chmod(0o444)
    command.extend(['--arm', 'production', '--plugin-dir', str(directory), '--timing-file', str(folder / 'timing.jsonl')])
    if arm in ('pi-lite', 'pi-full'):
        command.extend(['--recall-config', str(output / 'recall-config.json')])
    return command


def serialization(output, config, pins, manifest):
    arm = manifest['arms'][0]
    folder = output / 'serialization'
    folder.mkdir(exist_ok=True)
    identity = common.object_sha({'run': manifest['fingerprint'], 'arm': arm})
    def operation():
        source = folder / 'session.jsonl'
        source.write_text(json.dumps({'type': 'session', 'version': 3, 'id': 'offline-synthetic'}) + '\n')
        (folder / 'answer-system.txt').write_text('Inspect synthetic tool serialization only.')
        evidence = folder / 'tools.json'
        descriptors = {}
        for label, path, script, phase in (
            ('answer', output / 'config.json', common.ROOT / 'benchmark/sdk-rpc.mjs', 'answer'),
            *[(label, output / 'judge-v2' / (label + '-config.json'), HERE / 'judge-pi-rpc.mjs', 'judge') for label in preparation.LABELS]):
            process = subprocess.run(['node', str(script), '--config', str(path), '--phase', phase, '--describe'],
                                     env=common.child_env(), capture_output=True, text=True)
            if process.returncode:
                raise RuntimeError('Explicit model descriptor failed: ' + label)
            descriptors[label] = json.loads(process.stdout)
        command = answer_command(output, config, pins, arm, folder, source, evidence, stop=True)
        observed = r2.scoped_rpc(command, common.child_env(), folder, prompt='Inspect synthetic tool serialization only.', timeout=120)
        if observed['rc'] != 2 or not evidence.is_file():
            raise RuntimeError('Actual SDK serialization must stop before network')
        actual = json.loads(evidence.read_text())
        expected = [] if arm == 'pi-native' else ['history_expand', 'history_grep'] if arm == 'pi-lite' else ['history_expand', 'history_grep', 'history_recall']
        if actual.get('source') != 'before_provider_request' or actual.get('descriptionsPreserved') is not True or [tool['name'] for tool in actual.get('serialized', [])] != expected:
            raise ValueError('Actual SDK serialized tools differ from current mode')
        return {'path': str(evidence), 'sha256': common.sha(evidence), 'modelCalls': 0,
                'stoppedBeforeNetwork': True, 'descriptors': descriptors}
    result = common.durable_phase(folder, 'result', identity, operation)
    verify_files({result['path']: result['sha256']}, 'Serialized native tools')
    manifest['toolEvidence'] = {arm: {k: result[k] for k in ('path', 'sha256', 'modelCalls', 'stoppedBeforeNetwork')}}
    manifest['answerDescriptor'] = result['descriptors']['answer']
    manifest['descriptors'] = {label: result['descriptors'][label] for label in preparation.LABELS}
    if manifest['state'] == 'prepared':
        manifest['state'] = 'serialization-complete'
    common.write_json(output / 'manifest.json', manifest)



def run(args):
    output, config, pins, manifest, configs, paths = prepare(args)
    if args.stage == 'prepare':
        return manifest
    scope = whole_scope()
    arm = manifest['arms'][0]
    soft_english = manifest['identity'].get('budgetPolicy', {}).get('answerEstimate') == 'diagnostic-only'
    capacity_stop = threading.Event()
    if manifest.get('capacityRejection'):
        capacity_stop.set()
    lock = threading.RLock()
    previous = json.loads((output / 'resource.json').read_text()) if (output / 'resource.json').exists() else {}
    gauges = {'activeQuestions': 0, 'peakActiveQuestions': previous.get('peakActiveQuestions', 0),
              'activeRpcSessions': 0, 'peakActiveRpcSessions': previous.get('peakActiveRpcSessions', 0),
              'phaseCounts': dict(previous.get('phaseCounts', {})), 'phaseActive': {},
              'phasePeaks': dict(previous.get('phasePeaks', {}))}
    slots = threading.BoundedSemaphore(args.workers)
    old_rpc = r2.scoped_rpc
    def persist():
        with lock:
            common.write_json(output / 'manifest.json', manifest)
            answers, judges = [], []
            for qid in manifest['selected']:
                path = output / 'results' / arm / qid / 'result.json'
                if path.exists(): answers.append(json.loads(path.read_text()))
                for label in ('luna', 'sol'):
                    path = output / 'judge-v2' / label / arm / qid / 'result.json'
                    if path.exists(): judges.append(json.loads(path.read_text()))
            common.write_json(output / 'answer-ledger.json', {'fingerprint': manifest['fingerprint'], 'records': answers})
            common.write_json(output / 'judge-v2/ledger.json', {'fingerprint': manifest['fingerprint'], 'records': judges})
            launch_path = output / 'launch.json'
            launch = json.loads(launch_path.read_text()) if launch_path.is_file() else None
            resource = {'cgroupPath': str(scope), 'scopeName': scope.name,
                        'memoryMaxBytes': MEMORY_MAX, 'swapMaxBytes': 0, 'memoryPeakBytes': int((scope / 'memory.peak').read_text()),
                        'workers': args.workers, 'maxConcurrentSessions': args.workers, 'state': manifest['state'], **gauges,
                        'launch': launch, 'launchPath': str(launch_path), 'launchKnown': launch is not None,
                        'measurementSources': {'memoryPeakBytes': str(scope / 'memory.peak'),
                                              'activeQuestions': 'case entry/finally', 'activeRpcSessions': 'shared scoped_rpc entry/finally',
                                              'launch': str(launch_path) + ' (parent-authored; unknown until present)'}}
            common.write_json(output / 'resource.json', resource)
            common.write_json(output / 'progress.json', {**resource, 'fingerprint': manifest['fingerprint'],
                         'completed': list(manifest['completed']), 'failures': dict(manifest['failures'])})
    def stop_capacity_retry(record):
        message = common.capacity_error(record)
        if message is None:
            return False
        with lock:
            manifest.setdefault('capacityRejection', {'id': record['question_id'], 'message': common.safe_error(message),
                                                     'rawSession': record.get('session'), 'sessionSha256': record.get('sessionSha256')})
            capacity_stop.set()
            persist()
        return True


    def measured_rpc(command, env, directory, **kwargs):
        phase = command[command.index('--phase') + 1]
        if Path(directory).name == 'serialization': phase = 'serialization'
        with slots:
            with lock:
                gauges['activeRpcSessions'] += 1
                gauges['peakActiveRpcSessions'] = max(gauges['peakActiveRpcSessions'], gauges['activeRpcSessions'])
                gauges['phaseCounts'][phase] = gauges['phaseCounts'].get(phase, 0) + 1
                gauges['phaseActive'][phase] = gauges['phaseActive'].get(phase, 0) + 1
                gauges['phasePeaks'][phase] = max(gauges['phasePeaks'].get(phase, 0), gauges['phaseActive'][phase])
                persist()
            try:
                return plain_rpc(command, env, directory, **kwargs)
            finally:
                with lock:
                    gauges['activeRpcSessions'] -= 1
                    gauges['phaseActive'][phase] -= 1
                    persist()
    r2.scoped_rpc = measured_rpc
    def context_budget(session, phase, destination=None):
        process = subprocess.run(['node', str(common.ROOT / 'benchmark/pi-context-estimate.mjs'), '--sdk-path', config['sdk_path'], '--session', str(session)],
                                 capture_output=True, text=True, check=True, env=common.child_env())
        estimated = json.loads(process.stdout)
        descriptor = manifest['answerDescriptor']
        generation = descriptor['maxTokens']
        ceiling = descriptor['contextWindow'] - generation - config['protocol']['overhead_tokens']
        result = {'estimatedTokens': estimated['estimatedTokens'], 'generationReserve': generation, 'ceiling': ceiling,
                  'estimator': 'installed SDK chars/4; not provider token usage', 'phase': phase}
        target = session.parent if destination is None else destination
        target.mkdir(parents=True, exist_ok=True)
        common.write_json(target / (phase + '-context-budget.json'), result)
        return result

    def case(question):
        qid = question['id']
        if qid in manifest['failures'] or qid in manifest['completed']: return
        with lock:
            if capacity_stop.is_set(): return
            gauges['activeQuestions'] += 1
            gauges['peakActiveQuestions'] = max(gauges['peakActiveQuestions'], gauges['activeQuestions'])
            persist()
        try:
            entry = manifest['snapshots']['pi/' + qid]
            session = Path(entry['path'])
            verify_files({str(session): entry['sha256']}, 'Native snapshot')
            budget = context_budget(session, 'answer', output / 'results' / arm / qid)
            if budget['estimatedTokens'] > budget['ceiling']:
                if not soft_english:
                    raise ValueError('Answer SDK estimate exceeds context ceiling')
                common.write_json(output / 'results' / arm / qid / 'answer-estimate-warning.json', {**budget, 'action': 'diagnostic-only', 'actualRequestParameters': 'unchanged'})
                print('ANSWER_ESTIMATE_WARNING ' + json.dumps({'id': qid, **budget}), flush=True)
            snapshot_sha = manifest['snapshots']['pi/' + qid]['sha256']
            def checked_command(*values, **options):
                verify_files({str(session): snapshot_sha, str(values[5]): snapshot_sha}, 'Answer clone/source bytes')
                return answer_command(*values, **options)
            verify_files({str(session): snapshot_sha}, 'Native snapshot')
            answer = r2.answer_one(output, config, pins, manifest, question, arm, command_factory=checked_command,
                                   stop_retry=stop_capacity_retry if soft_english else None)
            verify_files({str(session): manifest['snapshots']['pi/' + qid]['sha256']}, 'Native snapshot')
            if answer['outcome'] == 'answered':
                wire = Path(answer['session']).parent / 'wire-requests.jsonl'
                rows = [json.loads(line) for line in wire.read_text().split('\n') if line]
                if not rows or any(row['effort'] != config['answer']['effort'] for row in rows):
                    raise ValueError('Answer wire evidence missing or changed')
            persist()
            judged = {}
            for label in ('luna', 'sol'):
                if capacity_stop.is_set() and answer['outcome'] == 'answered': break
                judged[label] = r2.judge_one(output, manifest, paths, configs, question, arm, answer, label,
                                           stop_retry=stop_capacity_retry if soft_english else None)
                persist()
            failed = {label: row['status'] for label, row in judged.items() if row['status'] != 'graded'}
            with lock:
                if answer['outcome'] != 'answered':
                    manifest['failures'][qid] = {'phase': 'answer', 'status': answer['outcome']}
                elif failed:
                    manifest['failures'][qid] = {'phase': 'strict', 'judges': failed}
                elif len(judged) == 2 and qid not in manifest['completed']:
                    manifest['completed'].append(qid)
            persist()
        except Exception as error:
            with lock:
                manifest['failures'][qid] = {'kind': type(error).__name__, 'message': 'Native case pipeline failed; see persisted phase evidence'}
            persist()
            print(json.dumps({'event': 'case-failure', 'id': qid, 'kind': type(error).__name__}), flush=True)
        finally:
            with lock:
                gauges['activeQuestions'] -= 1
                persist()
    def validate_cached_results():
        previous_rpc = r2.scoped_rpc
        def reject_replay(*values, **options):
            raise ValueError('Completed phase refuses provider replay')
        r2.scoped_rpc = reject_replay
        try:
            for question in manifest['questions']:
                qid = question['id']
                if qid not in manifest['completed']:
                    if manifest['state'] != 'complete' or qid in manifest['failures']:
                        continue
                    raise ValueError('Completed run lacks terminal question coverage')
                if not (output / 'results' / arm / qid / 'result.json').is_file():
                    raise ValueError('Completed answer result missing')
                answer = r2.answer_one(output, config, pins, manifest, question, arm, command_factory=answer_command)
                for label in ('luna', 'sol'):
                    if not (output / 'judge-v2' / label / arm / qid / 'result.json').is_file():
                        raise ValueError('Completed strict result missing')
                    r2.judge_one(output, manifest, paths, configs, question, arm, answer, label)
        finally:
            r2.scoped_rpc = previous_rpc
    try:
        validate_cached_results()
        if manifest['state'] in ('complete', 'partial', 'failed', 'capacity-blocked'):
            serialization(output, config, pins, manifest)
            return manifest
        serialization(output, config, pins, manifest)
        persist()
        print('CURRENT_SCOPE_READY ' + json.dumps({'manifest': str(output / 'manifest.json'), 'scope': scope.name, 'stage': args.stage}), flush=True)
        pilot = manifest['questions'][0]
        case(pilot)
        if capacity_stop.is_set():
            manifest['state'] = 'capacity-blocked'; persist(); return manifest
        if pilot['id'] in manifest['failures']:
            manifest['state'] = 'pilot-blocked'; persist(); return manifest
        answer = json.loads((output / 'results' / arm / pilot['id'] / 'result.json').read_text())
        judged = {label: json.loads((output / 'judge-v2' / label / arm / pilot['id'] / 'result.json').read_text()) for label in ('luna', 'sol')}
        valid = answer['outcome'] == 'answered' and all(row['status'] == 'graded' for row in judged.values())
        manifest['pilot'] = {'id': pilot['id'], 'valid': valid, 'countsIn16': True,
                             'correct': {label: (row.get('verdict') or {}).get('correct') for label, row in judged.items()}}
        manifest['state'] = 'pilot-valid' if valid else 'pilot-blocked'; persist()
        if not valid or args.stage == 'pilot': return manifest
        manifest['state'] = 'running'; persist()
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            jobs = [pool.submit(case, question) for question in manifest['questions'][1:]]
            for job in as_completed(jobs): job.result()
        verify_files(manifest['identity']['inputs'], 'Frozen run input')
        verify_files({str(Path(pins['sqlite']['path']) / name): digest for name, digest in pins['sqlite']['filesSha256'].items()}, 'Frozen candidate')
        verify_files(manifest['identity']['snapshotSource']['filesSha256'], 'Snapshot source bytes')
        manifest['state'] = ('capacity-blocked' if capacity_stop.is_set() else 'complete' if len(manifest['completed']) == len(manifest['selected'])
                             else 'partial' if manifest['completed'] else 'failed')
        persist()
        return manifest
    finally:
        r2.scoped_rpc = old_rpc


def flow(args):
    manifest = run(args)
    output = args.output.resolve()
    reporter = common.module('current_report', HERE / 'lme-zh-report.py')
    reporter.write_report(output)
    if manifest['state'] != 'complete':
        return manifest
    grader = common.module('current_grade', HERE / 'lme-grade-run.py')
    graded = grader.run(output, workers=args.workers)
    reporter.write_report(output)
    verify_files(manifest['identity']['sources'], 'Execution source')
    return graded


def parser(dataset='LME16-English'):
    value = argparse.ArgumentParser(description=__doc__ if dataset == 'LME16-English' else 'Current SWE-chat fixed-snapshot full-production flow.')
    for name in ('config', 'data-root', 'output'):
        value.add_argument('--' + name, type=Path, required=True)
    value.add_argument('--snapshot-source', type=Path, help='Required for LME16; SWE defaults to question-bound snapshot paths')
    value.add_argument('--dataset', choices=('LME16-English', 'SWE-chat'), default=dataset)
    value.add_argument('--source-root', type=Path, default=common.ROOT)
    value.add_argument('--arm', choices=(*CURRENT_ARMS, 'all'), default='pi-full')
    value.add_argument('--workers', type=int, choices=range(1, 9), default=8)
    value.add_argument('--stage', choices=('prepare', 'pilot', 'all', 'flow'), default='flow')
    return value


def main(dataset='LME16-English'):
    arguments = parser(dataset)
    args = arguments.parse_args()
    if not args.config.is_file():
        arguments.error('missing external input --config: ' + str(args.config))
    if not args.data_root.is_dir():
        arguments.error('missing external input --data-root: ' + str(args.data_root))
    if not args.source_root.is_dir():
        arguments.error('missing source root --source-root: ' + str(args.source_root))
    if args.dataset == 'LME16-English' and args.snapshot_source is None:
        arguments.error('LME16-English requires --snapshot-source')
    if args.snapshot_source is not None and not args.snapshot_source.is_dir():
        arguments.error('missing external input --snapshot-source: ' + str(args.snapshot_source))
    original_output, selected_arm = args.output.resolve(), args.arm
    args.shared_output = original_output
    arms = CURRENT_ARMS if selected_arm == 'all' else (selected_arm,)
    results = []
    for arm in arms:
        args.arm = arm
        args.output = original_output / arm if selected_arm == 'all' else original_output
        result = flow(args) if args.stage == 'flow' else run(args)
        if args.stage in ('pilot', 'all'):
            reporter = common.module('current_phase_report', HERE / 'lme-zh-report.py')
            reporter.write_report(args.output)
        results.append({'arm': arm, 'state': result['state'], 'completed': len(result.get('completed', [])), 'failures': len(result.get('failures', {}))})
        if result['state'] not in ('prepared', 'serialization-complete', 'pilot-valid', 'complete'):
            break
    print(json.dumps(results), flush=True)
    if any(row['state'] not in ('prepared', 'serialization-complete', 'pilot-valid', 'complete') for row in results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
