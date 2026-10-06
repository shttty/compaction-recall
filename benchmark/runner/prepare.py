"""One deterministic preparation owner for current source, inputs, and snapshots."""
import json
from pathlib import Path
import shutil
import subprocess
from runner import artifacts as common

DEV = ('778164c6', '51b23612', 'ceb54acb', '577d4d32', '3d86fd0a', '15745da0', 'gpt4_65aabe59', '982b5123')
HARD = ('gpt4_7fce9456', 'gpt4_a1b77f9c', '28dc39ac', 'gpt4_15e38248', '6d550036', '2ce6a0f2', '9d25d4e0', 'gpt4_731e37d7')
ARMS = ('pi-native', 'pi-lite', 'pi-full')
LABELS = ('luna', 'sol')


def frozen_json(path, value):
    if path.exists():
        if json.loads(path.read_text()) != value:
            raise ValueError('Frozen preparation bytes changed: ' + str(path))
    else:
        common.write_json(path, value)
        path.chmod(0o444)


def verify_files(files, label='Frozen input'):
    for filename, digest in files.items():
        if not Path(filename).is_file() or common.sha(Path(filename)) != digest:
            raise ValueError(label + ' changed: ' + filename)


def freeze_candidate(source, output):
    source = source.resolve(strict=True)
    target = output / 'candidate'
    identity_path = output / 'candidate.json'
    node = subprocess.run(['node', '--version'], capture_output=True, text=True, check=True).stdout.strip()
    if identity_path.exists():
        identity = json.loads(identity_path.read_text())
        if identity['sourceRoot'] != str(source) or identity['nodeVersion'] != node:
            raise ValueError('Candidate source/runtime identity changed')
        verify_files({str(target / name): digest for name, digest in identity['filesSha256'].items()}, 'Frozen candidate')
        verify_files({str(source / name): digest for name, digest in identity['filesSha256'].items()}, 'Candidate source')
        actual = {str(path.relative_to(target)) for path in target.rglob('*') if path.is_file()}
        if actual != set(identity['filesSha256']):
            raise ValueError('Frozen candidate file inventory changed')
        return identity
    files = {path.relative_to(source) for path in (source / 'src').rglob('*') if path.is_file()}
    files.update(Path(name) for name in ('package.json', 'package-lock.json'))
    package = json.loads((source / 'package.json').read_text())
    pending = [(source, name, False) for name in sorted(set(package.get('dependencies', {})) | set(package.get('peerDependencies', {})))]
    seen = set()
    while pending:
        owner, name, optional = pending.pop()
        directory = owner
        while not (directory / 'node_modules' / name / 'package.json').is_file():
            if directory == source:
                if optional:
                    break
                raise ValueError('Installed runtime dependency missing: ' + name)
            directory = directory.parent
            if not directory.is_relative_to(source):
                raise ValueError('Runtime dependency escapes source root: ' + name)
        else:
            dependency = directory / 'node_modules' / name
            relative = dependency.relative_to(source)
            if relative in seen:
                continue
            seen.add(relative)
            files.update(path.relative_to(source) for path in dependency.rglob('*') if path.is_file() and '.cache' not in path.parts)
            metadata = json.loads((dependency / 'package.json').read_text())
            optional_names = set(metadata.get('optionalDependencies', {}))
            pending.extend((dependency, child, child in optional_names) for child in sorted(set(metadata.get('dependencies', {})) | optional_names))
    hashes = {str(name): common.sha(source / name) for name in sorted(files)}
    for name, digest in hashes.items():
        destination = target / name
        if destination.exists():
            if common.sha(destination) != digest:
                raise ValueError('Incomplete candidate freeze differs: ' + name)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, destination)
            if common.sha(destination) != digest:
                raise ValueError('Candidate source changed during freezing: ' + name)
        destination.chmod((source / name).stat().st_mode & 0o555 or 0o444)
    git = subprocess.run(['git', '-C', str(source), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    identity = {'sourceRoot': str(source), 'path': str(target), 'entry': 'src/index.ts', 'nodeVersion': node,
                'commit': git.stdout.strip() if git.returncode == 0 else None, 'filesSha256': hashes,
                'sdkPath': str(target / 'node_modules/@earendil-works/pi-coding-agent')}
    frozen_json(identity_path, identity)
    return identity


def model_config(path, candidate, output):
    source = json.loads(path.read_text())
    if set(source) - {'answer', 'judges', 'profiles', 'protocol', 'system_prompt'} or not {'answer', 'judges', 'profiles'} <= set(source):
        raise ValueError('Config requires answer, judges, profiles; optional protocol/system_prompt only')
    if set(source['judges']) != set(LABELS) or set(source['profiles']) != {'answer', *LABELS}:
        raise ValueError('Config requires exactly answer/luna/sol profiles and luna/sol judges')
    selected = {'answer': source['answer'], **source['judges']}
    phases = {}
    for label, model in selected.items():
        if set(model) != {'provider', 'model', 'effort'} or any(not isinstance(v, str) or not v.strip() for v in model.values()):
            raise ValueError('Model requires nonempty provider/model/effort only')
        profile = source['profiles'][label]
        if not isinstance(profile, str) or not profile.strip():
            raise ValueError('Profile must be an explicit path')
        profile = (path.parent / profile).resolve(strict=True)
        if profile == output or profile.is_relative_to(output) or output.is_relative_to(profile):
            raise ValueError('Credential profile and output must be disjoint')
        phases[label] = {**model, 'profile': str(profile)}
    protocol = source.get('protocol', {'reserve_tokens': 16384, 'overhead_tokens': 1024})
    if set(protocol) != {'reserve_tokens', 'overhead_tokens'} or any(type(v) is not int or v < 0 for v in protocol.values()):
        raise ValueError('Invalid explicit protocol budget')
    config = {'sdk_path': candidate['sdkPath'], 'output_dir': str(output),
              'system_prompt': source.get('system_prompt', ''), 'protocol': protocol,
              'answer': phases['answer'], 'judge': phases['luna']}
    frozen_json(output / 'config.json', config)
    configs, paths = {}, {}
    for label in LABELS:
        folder = output / 'judge-v2' / label
        folder.mkdir(parents=True, exist_ok=True)
        configs[label] = {**config, 'judge': phases[label], 'output_dir': str(folder)}
        paths[label] = output / 'judge-v2' / (label + '-config.json')
        frozen_json(paths[label], configs[label])
    return config, configs, paths


def load_questions(data, dataset):
    inputs = {}
    if dataset == 'LME16-English':
        questions = []
        for group, ids in (('dev8', DEV), ('hard8', HARD)):
            for qid in ids:
                directory = data / 'data' / group / qid
                question_path, answer_path = directory / 'question.json', directory / 'answer.json'
                q, reference = json.loads(question_path.read_text()), json.loads(answer_path.read_text())
                if q['question_id'] != qid or reference['question_id'] != qid:
                    raise ValueError('Question/reference ID mismatch')
                questions.append({'id': qid, 'question': q['question'], 'question_date': q['question_date'],
                                  'answer': reference['answer'], 'language': 'en', 'subset': group,
                                  'type': q.get('question_type', 'unknown'), 'split': group, 'caseId': qid, 'overlap': None})
                inputs.update({str(p): common.sha(p) for p in (question_path, answer_path)})
        return questions, inputs
    paths = (data / 'questions.json', data / 'gold.json')
    raw, gold = (json.loads(p.read_text()) for p in paths)
    if len(raw) != 8 or len({q['id'] for q in raw}) != 8 or set(gold) != {q['id'] for q in raw}:
        raise ValueError('SWE-chat requires exactly eight bound questions/references')
    questions = [{**q, 'answer': gold[q['id']]['answer'], 'language': 'en', 'subset': q.get('subset', 'dev8'),
                  'caseId': q['id'], 'type': q.get('type', 'unknown'), 'overlap': None} for q in raw]
    return questions, {str(p): common.sha(p) for p in paths}


def bind_swe_snapshots(data, source, output, questions):
    freeze_path = data / 'freeze.json'
    freeze = json.loads(freeze_path.read_text())
    verify_files(freeze['filesSha256'], 'SWE source freeze')
    files = {str(freeze_path): common.sha(freeze_path), **freeze['filesSha256']}
    snapshots, bindings = {}, {}
    for question in questions:
        session = Path(question['snapshot'])
        if not session.is_absolute():
            session = (source or data) / session
        session = session.resolve(strict=True)
        if source is not None and not session.is_relative_to(source.resolve()):
            raise ValueError('SWE snapshot escapes explicit source')
        if session.is_relative_to(output) or output.is_relative_to(session):
            raise ValueError('SWE snapshot/output overlap')
        rows = common.transcript(session)
        compactions = [row for row in rows if row.get('type') == 'compaction']
        if not compactions or any(not row.get('summary') or not row.get('firstKeptEntryId') or 'blind-simulated' in row.get('id', '') for row in compactions):
            raise ValueError('SWE requires genuine nonempty native snapshot compactions')
        if any(row.get('message', {}).get('role') == 'user' and ''.join(block.get('text', '') for block in row['message'].get('content', []) if isinstance(block, dict)) == question['question'] for row in rows):
            raise ValueError('SWE snapshot already contains evaluation question')
        digest = question['snapshotSha256']
        files[str(session)] = digest
        key = 'pi/' + question['id']
        bindings[key] = {'path': str(session), 'sha256': digest,
                         'nativeCompactions': [{'id': row['id'], 'firstKeptEntryId': row['firstKeptEntryId'],
                             'summarySha256': common.object_sha(row['summary'])} for row in compactions],
                         'modelChanges': [row for row in rows if row.get('type') in ('model_change', 'thinking_level_change')]}
        snapshots[key] = {**bindings[key], 'language': 'en', 'reused': True, 'sourceRun': str(source or data)}
    verify_files(files, 'SWE snapshot source')
    return snapshots, {'run': str(source or data), 'filesSha256': files, 'snapshots': bindings,
                       'fingerprint': common.object_sha(bindings)}


def bind_snapshots(source, output, questions, dataset):
    source = source.resolve(strict=True)
    if source == output or source.is_relative_to(output) or output.is_relative_to(source):
        raise ValueError('Snapshot source and output must be disjoint')
    path = source / 'manifest.json'
    old = json.loads(path.read_text())
    if old.get('state') != 'complete' or old['fingerprint'] != common.object_sha(old['identity']):
        raise ValueError('Snapshot source must be completed and identity-bound')
    compression = old['identity']['config']['compression']
    previous = {q['id']: q for q in old['questions']}
    snapshots, files, bindings = {}, {str(path): common.sha(path)}, {}
    for q in questions:
        prior = previous[q['id']]
        if any(prior.get(k) != q.get(k) for k in ('question', 'question_date')):
            raise ValueError('Snapshot question identity mismatch')
        if prior.get('language', 'en') != 'en':
            raise ValueError('Current flow requires English snapshot inputs')
        key = 'pi/' + q['id']
        entry = old['snapshots'][key]
        session = Path(entry['path'])
        if not session.is_absolute():
            session = source / session
        session = session.resolve(strict=True)
        if not session.is_relative_to(source):
            raise ValueError('Snapshot session escapes source')
        compactions = [row for row in common.transcript(session) if row.get('type') == 'compaction']
        if len(compactions) != 3 or any(not row.get('summary') or 'blind-simulated' in row.get('id', '') for row in compactions):
            raise ValueError('Requires three nonempty native source compactions')
        if any(row.get('message', {}).get('role') == 'user' and ''.join(b.get('text', '') for b in row['message'].get('content', [])) == q['question'] for row in common.transcript(session)):
            raise ValueError('Snapshot already contains evaluation question')
        files[str(session)] = entry['sha256']
        bindings[key] = {'path': str(session), 'sha256': entry['sha256']}
        snapshots[key] = {**entry, **bindings[key], 'language': 'en', 'reused': True,
                          'sourceRun': str(source), 'sourceFingerprint': old['fingerprint']}
    verify_files(files, 'Snapshot source')
    return snapshots, {'run': str(source), 'fingerprint': old['fingerprint'], 'manifestPath': str(path),
                       'manifestSha256': files[str(path)], 'snapshots': bindings, 'filesSha256': files,
                       'compression': {k: compression[k] for k in ('provider', 'model', 'effort')}}


def prepare(args):
    output = args.output.resolve()
    source = args.source_root.resolve(strict=True)
    data = args.data_root.resolve(strict=True)
    if not 1 <= args.workers <= 8 or args.arm not in ARMS:
        raise ValueError('Current arm and 1–8 workers required')
    required_inputs = (source, data, args.config.resolve()) + ((args.snapshot_source.resolve(),) if args.snapshot_source else ())
    for path in required_inputs:
        if output == path or output.is_relative_to(path) or path.is_relative_to(output):
            raise ValueError('Output must be external and disjoint from all inputs')
    shared_output = getattr(args, 'shared_output', output)
    for destination in dict.fromkeys((shared_output, output)):
        if (destination / 'manifest.json').exists():
            previous = json.loads((destination / 'manifest.json').read_text())
            if previous.get('identity', {}).get('schema') != 'current-fixed-snapshot-v1':
                raise ValueError('Historical outputs are immutable; choose a new output')
        elif destination.exists() and any(destination.iterdir()) and not (shared_output / 'candidate.json').is_file():
            raise ValueError('Unknown populated output is immutable; choose a new output')
    dataset = args.dataset
    questions, inputs = load_questions(data, dataset)
    if dataset == 'LME16-English':
        if args.snapshot_source is None:
            raise ValueError('LME16 requires --snapshot-source')
        snapshots, binding = bind_snapshots(args.snapshot_source, output, questions, dataset)
    else:
        snapshots, binding = bind_swe_snapshots(data, args.snapshot_source, output, questions)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    shared_output.mkdir(parents=True, exist_ok=True, mode=0o700)
    candidate = freeze_candidate(source, shared_output)
    config, configs, paths = model_config(args.config.resolve(), candidate, output)
    inputs[str(args.config.resolve())] = common.sha(args.config)
    if args.arm != 'pi-native':
        frozen_json(output / 'recall-config.json', {'mode': args.arm.removeprefix('pi-')})
    sources = [common.ROOT / 'benchmark' / name for name in ('run.py', 'report.py',
        'runner/artifacts.py', 'runner/prepare.py', 'runner/phases.py', 'runner/answer_prompt.py',
        'runner/execution.py', 'runner/cases.py', 'runner/resources.py', 'runner/sdk.py',
        'runner/__init__.py', 'judging/strict.py', 'judging/execute.py', 'judging/score.py',
        'judging/score_contract.py', 'judging/__init__.py', 'sdk/extension.mjs',
        'sdk/tools-evidence.mjs', 'sdk/context-evidence.mjs', 'sdk/answer.mjs', 'sdk/judge.mjs',
        'sdk/session.mjs', 'sdk/observer.py', 'sdk/context-estimate.mjs')]
    identity = {'schema': 'current-fixed-snapshot-v1', 'task': dataset + '-' + args.arm, 'dataset': dataset,
                'arm': args.arm, 'inputs': inputs, 'sources': {str(p): common.sha(p) for p in sorted(sources)},
                'candidate': candidate, 'config': config, 'judgeConfigs': configs,
                'snapshotSource': binding, 'workers': args.workers,
                'questionsSha256': common.object_sha(questions), 'snapshotsSha256': common.object_sha(snapshots),
                'budgetPolicy': {'answerEstimate': 'diagnostic-only', 'actualOutputBudget': 'unchanged',
                                 'capacityRejection': 'stop new cases; no capacity retry; retain in-flight results'},
                'resourcePolicy': {'wholeRunMemoryMaxBytes': 14 * 1024 ** 3, 'wholeRunMemorySwapMaxBytes': 0,
                                   'maxConcurrentSessions': args.workers, 'authorizedSessionCeiling': 8}}
    fingerprint = common.object_sha(identity)
    path = output / 'manifest.json'
    if path.exists():
        manifest = json.loads(path.read_text())
        if (manifest['fingerprint'] != fingerprint or manifest['identity'] != identity
                or manifest['questions'] != questions or manifest['snapshots'] != snapshots
                or manifest['selected'] != [q['id'] for q in questions] or manifest['arms'] != [args.arm]):
            raise ValueError('Frozen current run identity changed; refusing resume')
    else:
        manifest = {'fingerprint': fingerprint, 'identity': identity, 'questions': questions, 'selected': [q['id'] for q in questions],
                    'arms': [args.arm], 'snapshots': snapshots, 'toolEvidence': {}, 'state': 'prepared',
                    'completed': [], 'failures': {}, 'pilot': None}
        common.write_json(path, manifest)
    common.CONFIG, common.CONFIG_PATH = config, output / 'config.json'
    return output, config, {'sqlite': candidate}, manifest, configs, paths
