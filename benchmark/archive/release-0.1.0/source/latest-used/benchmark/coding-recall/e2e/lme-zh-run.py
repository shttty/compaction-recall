"""Authorized Chinese LME16: one pinned arm, native snapshots, durable pilot/resume."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
import re
from pathlib import Path
import shutil
import subprocess
import threading
import time

import run as common

HERE = Path(__file__).resolve().parent
e = common.e
lme = common.module('zh_live_native', HERE / 'lme-run.py')
r2 = common.module('zh_live_round2', HERE / 'round2-run.py')
zh = common.module('zh_live_inputs', HERE / 'lme-zh-preflight.py')
ARM = 'pi-rawfts'
MEMORY_MAX = 14 * 1024 ** 3
FIXED_ENV = {'COMPACTION_RECALL_SQLITE_ARM': 'porter', 'COMPACTION_RECALL_SQLITE_BIGRAM_ONLY': 'porter',
             'COMPACTION_RECALL_SQLITE_HAN_PHRASE_TRIAL': 'off', 'COMPACTION_RECALL_AUTO_GATE': '280',
             'COMPACTION_RECALL_SNIPPET_BUDGET': '240', 'COMPACTION_RECALL_QUERY_TIMEOUT_MS': '5000'}


def whole_scope():
    relative = next(line.split('::', 1)[1] for line in Path('/proc/self/cgroup').read_text().split('\n') if line.startswith('0::'))
    directory = Path('/sys/fs/cgroup') / relative.lstrip('/')
    if int((directory / 'memory.max').read_text()) != MEMORY_MAX or int((directory / 'memory.swap.max').read_text()) != 0:
        raise ValueError('Entire runner must inherit one MemoryMax=14G / MemorySwapMax=0 scope')
    return directory


def plain_rpc(command, env, directory, **kwargs):
    observed = e.rpc.run_rpc(command, env, directory, collect_memory=True, **kwargs)
    e.write_json(Path(directory) / 'process-memory.json', observed.get('memory'))
    return observed


def answer_command(output, config, pins, arm, folder, session, evidence, expected=None, stop=False):
    directory = folder / 'wrapper'
    directory.mkdir(parents=True, exist_ok=True)
    pin = pins['sqlite']
    settings = {'entry': str(Path(pin['path']) / pin['entry']), 'sdkPath': config['sdk_path'], 'sqlite': False}
    options = {'evidencePath': str(evidence), 'expectedPath': str(expected) if expected else None, 'stopAfterSerialization': stop}
    if arm == 'pi-grep-fallback':
        options['expectedTools'] = ['history_expand', 'history_recall']
    context = {'directory': str(folder), 'toolsOnly': False}
    content = (f"import {{ registerPinned }} from {json.dumps(str(HERE / 'plugin.mjs'))};\n"
               f"import {{ withToolEvidence }} from {json.dumps(str(HERE / 'round2-tools.mjs'))};\n"
               f"import {{ withContextEvidence }} from {json.dumps(str(HERE / 'round3-context.mjs'))};\n"
               f"export default async pi => {{ Object.assign(process.env, {json.dumps(pin.get('configuration', FIXED_ENV))}); "
               f"await registerPinned(withContextEvidence(withToolEvidence(pi, {json.dumps(options)}), {json.dumps(context)}), {json.dumps(settings)}); }};\n")
    entry = directory / 'entry.mjs'
    if entry.exists() and entry.read_text() != content:
        raise ValueError('Frozen Chinese answer wrapper changed')
    if not entry.exists():
        entry.write_text(content)
    r2.frozen_json(directory / 'package.json', {'type': 'module', 'pi': {'extensions': ['./entry.mjs']}})
    entry.chmod(0o444); (directory / 'package.json').chmod(0o444)
    command = ['node', str(HERE / 'lme-zh-rpc.mjs'), '--config', str(output / 'config.json'), '--phase', 'answer',
               '--session', str(session), '--arm', 'production', '--plugin-dir', str(directory),
               '--timing-file', str(folder / 'timing.jsonl'), '--append-system-prompt', str(folder / 'answer-system.txt')]
    if arm in ('pi-grep-fallback', 'pi-restored-grep'):
        command.extend(['--recall-config', str(output / 'recall-config.json')])
    return command


def verify_files(files, label):
    for filename, digest in files.items():
        if common.sha(Path(filename)) != digest:
            raise ValueError(label + ' changed: ' + filename)


def reused_snapshots(source, output, approved, preflight_path, questions, inputs, config):
    source = source.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise ValueError('Snapshot source and new output must be separate runs')
    path = source / 'manifest.json'
    old = json.loads(path.read_text())
    identity = old['identity']
    selected = [q['id'] for q in questions]
    if questions[0]['language'] == 'en':
        if (old['state'] != 'complete' or identity.get('dataset') != 'LME16-English'
                or old['selected'] != selected or old['fingerprint'] != e.object_sha(identity)):
            raise ValueError('Snapshot source is not the completed English16 native run')
        previous = {q['id']: q for q in old['questions']}
        for question in questions:
            original = previous[question['id']]
            if any(original.get(k) != question.get(k) for k in ('question', 'question_date', 'language', 'subset', 'type')):
                raise ValueError('English question/snapshot identity changed')
            if original['answer'] != question['answer'] and question['id'] != approved['identity']['referenceRevision']['id']:
                raise ValueError('Unapproved English reference change')
        for phase in ('compression', 'answer'):
            if {k: identity['config'][phase][k] for k in ('provider', 'model', 'effort')} != approved['identity']['models'][phase]:
                raise ValueError('English source model tier changed')
        files = {str(path): common.sha(path)}
        snapshots, bindings = {}, {}
        for qid in selected:
            key = 'pi/' + qid
            entry = old['snapshots'][key]
            session = Path(entry['path'])
            summaries = [row for row in common.transcript(session) if row.get('type') == 'compaction']
            if len(summaries) != 3 or any(not row.get('summary') or 'blind-simulated' in row.get('id', '') for row in summaries):
                raise ValueError('English snapshot requires three genuine native compactions')
            bindings[key] = {'path': str(session), 'sha256': entry['sha256']}
            files[str(session)] = entry['sha256']
            snapshots[key] = {**entry, 'language': 'en', 'reused': True, 'sourceRun': str(source), 'sourceFingerprint': old['fingerprint']}
        verify_files(files, 'English native snapshot source')
        return snapshots, {'run': str(source), 'fingerprint': old['fingerprint'], 'manifestPath': str(path),
                           'manifestSha256': files[str(path)], 'snapshots': bindings, 'filesSha256': files}
    if (old['state'] != 'complete' or old['failures'] or old['arms'] != [ARM]
            or old['selected'] != selected or set(old['completed']) != set(selected)
            or len(old['completed']) != 16 or identity['task'] != 'RSM-ZH16-NATIVE-LIVE-20261005'
            or old['questions'] != questions or identity['dataset'] != 'LME16-Chinese'
            or old['fingerprint'] != e.object_sha(identity)):
        raise ValueError('Snapshot source is not the completed original Chinese16 run')
    policies = {
        'questionPolicy': 'raw Chinese question only; original ASK/date appended to system; oracle-free chronology',
        'compressionPolicy': 'original chrono/four cuts/three native compactions; keepRecent SDK default; final segment retained',
        'candidateEnvironment': FIXED_ENV,
    }
    if any(identity.get(key) != value for key, value in policies.items()):
        raise ValueError('Snapshot source chronology/configuration policy changed')
    if identity['config']['data_path'] != config['data_path'] or identity['config']['protocol'] != config['protocol']:
        raise ValueError('Snapshot source data/protocol changed')
    for phase in ('compression', 'answer'):
        if {key: identity['config'][phase][key] for key in ('provider', 'model', 'effort')} != approved['identity']['models'][phase]:
            raise ValueError('Snapshot source model tier changed')
    for label in ('luna', 'sol'):
        if {key: identity['judgeConfigs'][label]['judge'][key] for key in ('provider', 'model', 'effort')} != approved['identity']['models']['judges'][label]:
            raise ValueError('Snapshot source judge tier changed')
    if any(identity['inputs'].get(filename) != digest for filename, digest in inputs.items()):
        raise ValueError('Snapshot source question/corpus/gold bytes changed')
    if identity['inputs'].get(str(preflight_path)) != common.sha(preflight_path):
        raise ValueError('Snapshot source approved preflight changed')
    files = {**identity['inputs'], str(path): common.sha(path)}
    snapshots, bindings = {}, {}
    if set(old['snapshots']) != {'pi/' + qid for qid in selected}:
        raise ValueError('Snapshot source IDs changed')
    for key, entry in old['snapshots'].items():
        session = Path(entry['path'])
        if source not in session.resolve().parents or entry['language'] != 'zh':
            raise ValueError('Original Chinese snapshot path/language changed')
        build = entry['build']
        summaries = [row for row in common.transcript(session) if row.get('type') == 'compaction']
        if (len(summaries) != 3 or any(not row.get('summary') for row in summaries)
                or build['state'] != 'complete' or build['fingerprint'] != old['fingerprint']
                or len(build['compactions']) != 3 or any(not row['success'] for row in build['compactions'])):
            raise ValueError('Only three genuine nonempty original compactions qualify')
        bindings[key] = {'path': str(session), 'sha256': entry['sha256']}
        files[str(session)] = entry['sha256']
        snapshots[key] = {**bindings[key], 'language': 'zh', 'reused': True,
                          'sourceRun': str(source), 'sourceFingerprint': old['fingerprint'], 'build': build}
    verify_files(files, 'Snapshot source bytes')
    return snapshots, {'run': str(source), 'fingerprint': old['fingerprint'], 'manifestPath': str(path),
                       'manifestSha256': files[str(path)], 'snapshots': bindings, 'filesSha256': files}


def prepare(args):
    arm = getattr(args, 'arm', ARM)
    source = getattr(args, 'snapshot_source', None)
    if arm not in (ARM, 'pi-concepts', 'pi-grep-fallback', 'pi-restored-grep') or not 1 <= args.workers <= 8:
        raise ValueError('Unsupported Chinese arm/worker ceiling (maximum eight)')
    concepts = arm in ('pi-concepts', 'pi-grep-fallback', 'pi-restored-grep')
    language = getattr(args, 'language', 'zh')
    if language == 'en' and not concepts:
        raise ValueError('English requires frozen native snapshot reuse; new compression is not authorized')
    if concepts and (args.workers != 8 or source is None):
        raise ValueError('Concepts requires --workers 8 and --snapshot-source')
    if not concepts and source is not None:
        raise ValueError('RawFTS must build its original native snapshots')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    base = json.loads(args.config.read_text())
    approved = json.loads(args.preflight.read_text())
    candidate = json.loads(args.candidate.read_text())
    pins = json.loads(args.pins.read_text())
    pin = pins['sqlite']
    commit, archive_sha = args.commit, args.archive_sha256
    candidate_environment = {**FIXED_ENV, 'COMPACTION_RECALL_SQLITE_HAN_PHRASE_TRIAL': getattr(args, 'han_phrase_trial', 'off')}
    pin['configuration'] = candidate_environment
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(r'[0-9a-f]{64}', archive_sha) or not args.task:
        raise ValueError('Explicit full candidate commit/archive hash and task identity required')
    if candidate['snapshotCommit'] != commit or candidate['archiveSha256'] != archive_sha or candidate['configuration'] != candidate_environment:
        raise ValueError('Candidate differs from explicit commit/archive/configuration')
    if (common.sha(Path(candidate['archivePath'])) != archive_sha or pin['commit'] != commit
            or pin['archiveSha256'] != archive_sha or Path(pin['path']).resolve() != Path(candidate['snapshotRepo']).resolve()
            or pin['entry'] not in candidate['files'] or not pin['runtimeClosureSha256']):
        raise ValueError('Candidate archive/pin/source mismatch')
    for relative, digest in pin['runtimeClosureSha256'].items():
        if common.sha(Path(pin['path']) / relative) != digest:
            raise ValueError('Runtime import closure changed: ' + relative)
    for relative, digest in candidate['files'].items():
        if common.sha(Path(pin['path']) / relative) != digest:
            raise ValueError('Fixed candidate file bytes changed: ' + relative)
    version = subprocess.run(['node', '--version'], capture_output=True, text=True, check=True).stdout.strip()
    if version != pin['nodeVersion']:
        raise ValueError('Pinned Node runtime version changed')
    for filename, digest in approved['identity']['inputs'].items():
        if common.sha(Path(filename)) != digest:
            raise ValueError('Approved Chinese preflight input changed')
    config = {**base, 'sdk_path': pin.get('sdkPath', str(Path(pin['path']) / 'node_modules/@earendil-works/pi-coding-agent')),
              'candidate_repo': str(Path(candidate['snapshotRepo'])), 'data_path': str(args.data_root / 'data/index.json'),
              'output_dir': str(output), 'protocol': {**base['protocol'], 'reserve_tokens': 16384}}
    for phase in ('compression', 'answer'):
        if {key: config[phase][key] for key in ('provider', 'model', 'effort')} != approved['identity']['models'][phase]:
            raise ValueError('Native phase differs from approved model/effort')
    answer_model = getattr(args, 'answer_model', None)
    if answer_model is not None:
        if language != 'en':
            raise ValueError('Answer model override requires English native snapshot reuse')
        config['answer'] = {**config['answer'], 'model': answer_model}
    e.CONFIG, e.CONFIG_PATH = config, output / 'config.json'
    e.b = e.configuration.load_helper(Path(config['helper_path']), config)
    r2.frozen_json(e.CONFIG_PATH, config)
    configs, paths = {}, {}
    for label, config_source in (('luna', args.luna_config), ('sol', args.sol_config)):
        selected = json.loads(config_source.read_text())['judge']
        if {key: selected[key] for key in ('provider', 'model', 'effort')} != approved['identity']['models']['judges'][label]:
            raise ValueError('Judge differs from approved model/effort')
        root = output / 'judge-v2' / label
        root.mkdir(parents=True, exist_ok=True)
        configs[label] = {**config, 'judge': selected, 'output_dir': str(root)}
        paths[label] = output / 'judge-v2' / (label + '-config.json')
        r2.frozen_json(paths[label], configs[label])
    questions, inputs = [], {}
    for key in approved['identity']['selected']:
        solver, question, hashes = zh.load_case(args.data_root, key, language)
        question.update(type=solver.get('question_type') or 'unknown', split=question['subset'], caseId=question['id'], overlap=None)
        questions.append(question); inputs.update(hashes)
    if tuple(q['id'] for q in questions) != lme.DEV + lme.HARD:
        raise ValueError('Chinese 16 question selection/order changed')
    snapshots, binding = reused_snapshots(source, output, approved, args.preflight, questions, inputs, config) if concepts else ({}, None)
    inputs.update({str(path): common.sha(path) for path in (args.config, args.luna_config, args.sol_config, args.preflight, args.candidate, args.pins)})
    if arm in ('pi-grep-fallback', 'pi-restored-grep'):
        recall_config = output / 'recall-config.json'
        r2.frozen_json(recall_config, {'mode': 'full', 'trace': True, 'autoGate': 280,
                                     'snippetBudget': 240, 'recallTimeoutMs': 5000})
        inputs[str(recall_config)] = common.sha(recall_config)
    sources = (Path(__file__), HERE / 'lme-zh-rpc.mjs', HERE / 'lme-zh-preflight.py', HERE / 'lme-run.py',
               HERE / 'lme-zh-report.py', HERE / 'lme-grade-run.py', HERE / 'lme-grade-report.py', HERE / 'lme-zh-smoke.mjs',
               HERE / 'run.py', HERE / 'round2-run.py', HERE / 'rejudge-v2.py', HERE / 'judge-v2.py', HERE / 'judge-pi-rpc.mjs',
               HERE / 'plugin.mjs', HERE / 'round2-tools.mjs', HERE / 'round3-context.mjs',
               common.ROOT / 'benchmark/sdk-rpc.mjs', common.ROOT / 'benchmark/retrieval-score-answers.py', Path(e.__file__), Path(e.rpc.__file__),
               common.ROOT / 'benchmark/evaluation-config.py', common.ROOT / 'benchmark/pi-context-estimate.mjs', Path(config['helper_path']))
    identity = {'task': args.task, 'dataset': 'LME16-English' if language == 'en' else 'LME16-Chinese', 'inputs': inputs,
                'sources': {str(path): common.sha(path) for path in sources}, 'pins': pins, 'config': config,
                'candidate': {'commit': commit, 'archiveSha256': archive_sha, 'filesSha256': candidate['files']},
                'judgeConfigs': configs, 'candidateEnvironment': candidate_environment, 'ranking': candidate.get('ranking'),
                'retrievalSemantics': candidate.get('retrievalSemantics'),
                'questionPolicy': 'raw original English question only; original ASK/date appended to system; oracle-free chronology' if language == 'en' else 'raw Chinese question only; original ASK/date appended to system; oracle-free chronology',
                'compressionPolicy': 'original chrono/four cuts/three native compactions; keepRecent SDK default; final segment retained',
                'resourcePolicy': {'wholeRunMemoryMaxBytes': MEMORY_MAX, 'wholeRunMemorySwapMaxBytes': 0,
                                   'maxConcurrentSessions': args.workers, 'authorizedSessionCeiling': 8, 'nestedScopes': False},
                'retryPolicy': 'provider errors only; maximum3; delays2/4; preserve attempts; no query repair/replay',
                'judgePromptSha256': e.object_sha(r2.judge.contract.JUDGE_V2_PROMPT)}
    if concepts:
        identity.update(arm=arm, snapshotSource=binding)
    if language == 'en':
        identity['referenceRevision'] = approved['identity']['referenceRevision']
        identity['budgetPolicy'] = {'answerEstimate': 'diagnostic-only' if getattr(args, 'english_answer_soft_estimate', False) else 'hard',
                                   'actualOutputBudget': 'unchanged', 'capacityRejection': 'stop new cases; no capacity retry; retain in-flight results'}
    fingerprint = e.object_sha(identity)
    path = output / 'manifest.json'
    if path.exists():
        manifest = json.loads(path.read_text())
        if manifest['fingerprint'] != fingerprint:
            raise ValueError('Frozen Chinese run data/config/code changed; refusing resume')
        for snapshot in manifest['snapshots'].values():
            if common.sha(Path(snapshot['path'])) != snapshot['sha256']:
                raise ValueError('Native Chinese snapshot changed')
    else:
        manifest = {'fingerprint': fingerprint, 'identity': identity, 'questions': questions, 'selected': [q['id'] for q in questions],
                    'arms': [arm], 'snapshots': snapshots, 'preflight': {}, 'state': 'prepared', 'completed': [], 'failures': {}, 'pilot': None}
        if language == 'en' and getattr(args, 'english_answer_soft_estimate', False):
            prior_path = output / 'blocked-before-soft-estimate/manifest-active-before-reinitialize.json'
            if prior_path.exists():
                prior = json.loads(prior_path.read_text())
                if (prior['state'] != 'pilot-blocked' or prior['completed'] or
                        any((output / 'results').rglob('*state.json')) or any((output / 'results').rglob('wire-requests.jsonl')) or
                        any(prior['identity'].get(k) != identity.get(k) for k in ('inputs', 'config', 'candidate', 'candidateEnvironment', 'snapshotSource', 'referenceRevision'))):
                    raise ValueError('Only unchanged zero-request blocked initialization may reuse serialization')
                for key in ('preflight', 'answerDescriptor', 'descriptors'):
                    manifest[key] = prior[key]
        e.write_json(path, manifest)
    return output, config, pins, manifest, configs, paths


def serialization(output, config, pins, manifest):
    arm = manifest['arms'][0]
    if manifest['preflight']:
        if set(manifest['preflight']) != {arm}:
            raise ValueError('Incomplete serialized tool evidence')
        for evidence in manifest['preflight'].values():
            if common.sha(Path(evidence['path'])) != evidence['sha256']:
                raise ValueError('Serialized tool evidence changed')
        return
    # Synthetic fixture is isolated under offline/, never registered as a native snapshot.
    folder = output / 'offline'
    folder.mkdir(exist_ok=True)
    own = {**config, 'output_dir': str(folder)}
    r2.frozen_json(folder / 'config.json', own)
    if arm in ('pi-grep-fallback', 'pi-restored-grep'):
        r2.frozen_json(folder / 'recall-config.json', json.loads((output / 'recall-config.json').read_text()))
    source = folder / 'synthetic.jsonl'
    if not source.exists():
        source.write_text(json.dumps({'type': 'session', 'version': 3, 'id': 'offline-synthetic'}) + '\n')
    question = {'id': 'offline-synthetic', 'question': 'Inspect only synthetic tool serialization.', 'question_date': '2024/01/01 00:00'}
    probe = {'fingerprint': manifest['fingerprint'], 'questions': [question], 'preflight': {},
             'snapshots': {'pi/offline-synthetic': {'path': str(source)}}}
    r2.preflight(folder, own, pins, probe, arms=(arm,), command_factory=answer_command,
                 expected_tool_count=2 if arm == 'pi-grep-fallback' else 3)
    manifest['preflight'] = probe['preflight']
    manifest['answerDescriptor'] = probe['answerDescriptor']
    descriptors = {} if 'snapshotSource' in manifest['identity'] else {'compression': (HERE / 'lme-zh-rpc.mjs', output / 'config.json')}
    descriptors.update({label: (HERE / 'judge-pi-rpc.mjs', path) for label, path in
                        ((label, output / 'judge-v2' / (label + '-config.json')) for label in ('luna', 'sol'))})
    manifest['descriptors'] = {}
    for label, (script, path) in descriptors.items():
        phase = 'compression' if label == 'compression' else 'judge'
        process = subprocess.run(['node', str(script), '--config', str(path), '--phase', phase, '--describe'],
                                 env=e.child_env(), capture_output=True, text=True)
        if process.returncode:
            raise RuntimeError('Native model descriptor failed: ' + label)
        manifest['descriptors'][label] = json.loads(process.stdout)
    manifest['state'] = 'preflight-complete'
    e.write_json(output / 'manifest.json', manifest)


def run(args):
    scope = whole_scope()
    output, config, pins, manifest, configs, paths = prepare(args)
    arm = manifest['arms'][0]
    reused = 'snapshotSource' in manifest['identity']
    soft_english = manifest['identity'].get('budgetPolicy', {}).get('answerEstimate') == 'diagnostic-only'
    capacity_stop = threading.Event()
    lock = threading.RLock()
    previous = json.loads((output / 'resource.json').read_text()) if (output / 'resource.json').exists() else {}
    gauges = {'activeQuestions': 0, 'peakActiveQuestions': previous.get('peakActiveQuestions', 0),
              'activeRpcSessions': 0, 'peakActiveRpcSessions': previous.get('peakActiveRpcSessions', 0),
              'phaseCounts': dict(previous.get('phaseCounts', {})), 'phaseActive': {},
              'phasePeaks': dict(previous.get('phasePeaks', {}))}
    slots = threading.BoundedSemaphore(args.workers)
    old_rpc, old_scope, old_env, original_compact = r2.scoped_rpc, r2.scope_command, r2.scope_env, common.compact_rpc
    def persist():
        with lock:
            e.write_json(output / 'manifest.json', manifest)
            answers, judges = [], []
            for qid in manifest['selected']:
                path = output / 'results' / arm / qid / 'result.json'
                if path.exists(): answers.append(json.loads(path.read_text()))
                for label in ('luna', 'sol'):
                    path = output / 'judge-v2' / label / arm / qid / 'result.json'
                    if path.exists(): judges.append(json.loads(path.read_text()))
            e.write_json(output / 'answer-ledger.json', {'fingerprint': manifest['fingerprint'], 'records': answers})
            e.write_json(output / 'judge-v2/ledger.json', {'fingerprint': manifest['fingerprint'], 'records': judges})
            launch_path = output / 'launch.json'
            launch = json.loads(launch_path.read_text()) if launch_path.is_file() else None
            resource = {'cgroupPath': str(scope), 'scopeName': scope.name,
                        'memoryMaxBytes': MEMORY_MAX, 'swapMaxBytes': 0, 'memoryPeakBytes': int((scope / 'memory.peak').read_text()),
                        'workers': args.workers, 'maxConcurrentSessions': args.workers, 'state': manifest['state'], **gauges,
                        'launch': launch, 'launchPath': str(launch_path), 'launchKnown': launch is not None,
                        'measurementSources': {'memoryPeakBytes': str(scope / 'memory.peak'),
                                              'activeQuestions': 'case entry/finally', 'activeRpcSessions': 'shared scoped_rpc entry/finally',
                                              'launch': str(launch_path) + ' (parent-authored; unknown until present)'}}
            e.write_json(output / 'resource.json', resource)
            e.write_json(output / 'progress.json', {**resource, 'fingerprint': manifest['fingerprint'],
                         'completed': list(manifest['completed']), 'failures': dict(manifest['failures'])})
    def stop_capacity_retry(record):
        message = common.capacity_error(record)
        if message is None:
            return False
        with lock:
            manifest.setdefault('capacityRejection', {'id': record['question_id'], 'message': e.safe_error(message),
                                                     'rawSession': record.get('session'), 'sessionSha256': record.get('sessionSha256')})
            capacity_stop.set()
            persist()
        return True


    def measured_rpc(command, env, directory, **kwargs):
        phase = command[command.index('--phase') + 1]
        if Path(directory).parent.name == 'probe': phase = 'serialization'
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
    r2.scoped_rpc, r2.scope_command, r2.scope_env = measured_rpc, lambda command: command, e.child_env
    def context_budget(session, phase, destination=None):
        process = subprocess.run(['node', str(common.ROOT / 'benchmark/pi-context-estimate.mjs'), '--sdk-path', config['sdk_path'], '--session', str(session)],
                                 capture_output=True, text=True, check=True, env=e.child_env())
        estimated = json.loads(process.stdout)
        descriptor = manifest['descriptors']['compression'] if phase == 'compression' else manifest['answerDescriptor']
        generation = min(math.floor(0.8 * config['protocol']['reserve_tokens']), descriptor['maxTokens']) if phase == 'compression' else descriptor['maxTokens']
        ceiling = descriptor['contextWindow'] - generation - config['protocol']['overhead_tokens']
        result = {'estimatedTokens': estimated['estimatedTokens'], 'generationReserve': generation, 'ceiling': ceiling,
                  'estimator': 'installed SDK chars/4; not provider token usage', 'phase': phase}
        target = session.parent if destination is None else destination
        target.mkdir(parents=True, exist_ok=True)
        e.write_json(target / (phase + '-context-budget.json'), result)
        return result

    def compression(command, directory):
        session = Path(command[command.index('--session') + 1])
        stage = sum(row.get('type') == 'compaction' for row in common.transcript(session)) + 1
        prefix_sha = common.sha(session)
        attempts = []
        for number in range(1, 4):
            folder = Path(directory) / 'stages' / f'{stage:02d}' / 'attempts' / f'{number:02d}'
            folder.mkdir(parents=True, exist_ok=True)
            identity = e.object_sha({'run': manifest['fingerprint'], 'stage': stage, 'source': prefix_sha, 'attempt': number})
            def operation():
                clone = folder / 'session.jsonl'
                shutil.copyfile(session, clone)
                invocation = list(command); invocation[invocation.index('--session') + 1] = str(clone)
                budget = context_budget(clone, 'compression')
                if budget['estimatedTokens'] > budget['ceiling']:
                    observed = {'success': False, 'seconds': 0, 'rc': None, 'response': None, 'failureKind': 'local-context-preflight'}
                else:
                    observed = original_compact(invocation, folder)
                observed['contextBudget'] = budget
                observed.update(session=str(clone), sessionSha256=common.sha(clone), inputSha256=prefix_sha,
                                providerError=not observed['success'] and (folder / 'wire-requests.jsonl').is_file())
                if observed['success']:
                    summaries = [row for row in common.transcript(clone) if row.get('type') == 'compaction']
                    wire = folder / 'wire-requests.jsonl'
                    if len(summaries) != stage or not summaries[-1].get('summary') or not wire.is_file():
                        raise ValueError('Native compaction/wire evidence missing')
                    rows = [json.loads(line) for line in wire.read_text().split('\n') if line]
                    if not rows or any(row['effort'] != config['compression']['effort'] for row in rows):
                        raise ValueError('Native compression wire tier changed')
                return observed
            observed = common.durable_phase(folder, 'result', identity, operation)
            attempts.append(observed)
            if observed['success']:
                shutil.copyfile(Path(observed['session']), session)
                break
            if not observed['providerError']: break
            if number < 3: time.sleep(2 ** number)
        return {**attempts[-1], 'attempts': [{'path': str(Path(value['session']).parent / 'result.json'), 'success': value['success'], 'seconds': value['seconds']} for value in attempts],
                'seconds': sum(value['seconds'] for value in attempts)}
    common.compact_rpc = compression
    def case(question):
        qid = question['id']
        if qid in manifest['failures'] or qid in manifest['completed']: return
        with lock:
            if capacity_stop.is_set(): return
            gauges['activeQuestions'] += 1
            gauges['peakActiveQuestions'] = max(gauges['peakActiveQuestions'], gauges['activeQuestions'])
            persist()
        try:
            if reused:
                entry = manifest['snapshots']['pi/' + qid]
                session = Path(entry['path'])
                verify_files({str(session): entry['sha256']}, 'Native Chinese snapshot')
            else:
                solver, _, _ = zh.load_case(args.data_root, question['subset'] + '/' + qid)
                def boundary(phase, session, mode):
                    return ['node', str(HERE / 'lme-zh-rpc.mjs'), '--config', str(output / 'config.json'), '--phase', phase, '--session', str(session)]
                session, progress = lme.build_native(qid, solver, 'pi', output, manifest['fingerprint'], boundary)
                summaries = [row for row in common.transcript(session) if row.get('type') == 'compaction']
                if len(summaries) != 3 or any(not row.get('summary') for row in summaries):
                    raise ValueError('Only three genuine native compactions qualify')
                manifest['snapshots']['pi/' + qid] = {'path': str(session), 'sha256': common.sha(session), 'build': progress, 'language': 'zh'}
                persist()
            budget = context_budget(session, 'answer', output / 'results' / arm / qid if reused else None)
            if budget['estimatedTokens'] > budget['ceiling']:
                if not soft_english:
                    raise ValueError('Answer SDK estimate exceeds context ceiling')
                e.write_json(output / 'results' / arm / qid / 'answer-estimate-warning.json', {**budget, 'action': 'diagnostic-only', 'actualRequestParameters': 'unchanged'})
                print('EN16_ESTIMATE_WARNING ' + json.dumps({'id': qid, **budget}), flush=True)
            snapshot_sha = manifest['snapshots']['pi/' + qid]['sha256']
            def checked_command(*values, **options):
                verify_files({str(session): snapshot_sha, str(values[5]): snapshot_sha}, 'Answer clone/source bytes')
                return answer_command(*values, **options)
            verify_files({str(session): snapshot_sha}, 'Native Chinese snapshot')
            answer = r2.answer_one(output, config, pins, manifest, question, arm, command_factory=checked_command,
                                   stop_retry=stop_capacity_retry if soft_english else None)
            verify_files({str(session): manifest['snapshots']['pi/' + qid]['sha256']}, 'Native Chinese snapshot')
            if answer['outcome'] == 'answered':
                wire = Path(answer['session']).parent / 'wire-requests.jsonl'
                rows = [json.loads(line) for line in wire.read_text().split('\n') if line]
                if not rows or any(row['effort'] != config['answer']['effort'] for row in rows):
                    raise ValueError('Answer wire evidence missing or changed')
            persist()
            for label in ('luna', 'sol'):
                if capacity_stop.is_set(): break
                r2.judge_one(output, manifest, paths, configs, question, arm, answer, label,
                             stop_retry=stop_capacity_retry if soft_english else None)
                persist()
            with lock:
                if qid not in manifest['completed']: manifest['completed'].append(qid)
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
                    if manifest['state'] not in ('complete', 'complete-with-failures') or qid in manifest['failures']:
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
        if manifest['state'] in ('complete', 'complete-with-failures'):
            serialization(output, config, pins, manifest)
            return manifest
        serialization(output, config, pins, manifest)
        persist()
        print('ZH16_SCOPE_READY ' + json.dumps({'manifest': str(output / 'manifest.json'), 'scope': scope.name, 'stage': args.stage}), flush=True)
        if args.stage == 'preflight': return manifest
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
        verify_files({str(Path(pins['sqlite']['path']) / relative): digest for relative, digest in pins['sqlite']['runtimeClosureSha256'].items()}, 'Runtime import closure')
        candidate = json.loads(args.candidate.read_text())
        verify_files({str(Path(pins['sqlite']['path']) / relative): digest for relative, digest in candidate['files'].items()}, 'Fixed candidate bytes')
        verify_files({candidate['archivePath']: pins['sqlite']['archiveSha256']}, 'Candidate archive')
        if reused: verify_files(manifest['identity']['snapshotSource']['filesSha256'], 'Snapshot source bytes')
        manifest['state'] = 'capacity-blocked' if capacity_stop.is_set() else 'complete-with-failures' if manifest['failures'] else 'complete'
        persist()
        return manifest
    finally:
        r2.scoped_rpc, r2.scope_command, r2.scope_env, common.compact_rpc = old_rpc, old_scope, old_env, original_compact


def flow(args):
    """One native answer/strict phase, then immutable grading and its report."""
    manifest = run(args)
    if manifest['state'] != 'complete':
        raise ValueError('Native phase is not complete; preserving evidence without further calls')
    output = args.output.resolve()
    if not (output / 'grade-1to10/manifest.json').exists():
        reporter = common.module('zh_flow_report', HERE / 'lme-zh-report.py')
        report = reporter.write_report(output)
        r2.frozen_json(output / 'FINAL.json', {'task': manifest['identity']['task'], 'fingerprint': manifest['fingerprint'],
                       'state': manifest['state'], 'completedCases': len(manifest['completed']),
                       'failures': manifest['failures'], 'strict': report['judges']})
    grader = common.module('zh_flow_grade', HERE / 'lme-grade-run.py')
    graded = grader.run(output, workers=args.workers)
    if not (output / 'grade-1to10/aggregate.json').exists():
        reporter = common.module('zh_flow_grade_report', HERE / 'lme-grade-report.py')
        reporter.write_report(output / 'grade-1to10')
    verify_files(manifest['identity']['sources'], 'Execution source')
    return graded


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, fromfile_prefix_chars='@')
    for name in ('output', 'data-root', 'config', 'luna-config', 'sol-config', 'candidate', 'pins', 'preflight'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--commit', required=True, help='Authorized full candidate commit; never inferred from an arm')
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--task', required=True)
    parser.add_argument('--workers', type=int, choices=range(1, 9), default=8)
    parser.add_argument('--arm', choices=(ARM, 'pi-concepts', 'pi-grep-fallback', 'pi-restored-grep'), default='pi-restored-grep')
    parser.add_argument('--snapshot-source', type=Path)
    parser.add_argument('--han-phrase-trial', choices=('off', 'jieba'), default='off', help='Explicit candidate Han phrase configuration; bound into manifest and SDK wrapper')
    parser.add_argument('--language', choices=('zh', 'en'), default='zh', help='Original question/history language; English requires compatible native snapshot reuse')
    parser.add_argument('--english-answer-soft-estimate', action='store_true', help='Authorized English answer-only diagnostic estimate; provider capacity errors stop new cases without retry')
    parser.add_argument('--answer-model', help='Answer-only model override for English; preserve provider, effort and native compression identity')
    parser.add_argument('--stage', choices=('preflight', 'pilot', 'all', 'flow'), default='flow')
    args = parser.parse_args()
    value = flow(args) if args.stage == 'flow' else run(args)
    print(json.dumps({'state': value['state'], 'completed': len(value.get('completed', [])), 'failures': len(value.get('failures', {}))}), flush=True)
    if value['state'] == 'pilot-blocked': raise SystemExit(1)
