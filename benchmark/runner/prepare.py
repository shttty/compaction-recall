"""One deterministic preparation owner for current source, inputs, and snapshots."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from runner import artifacts as common

DEV = ('778164c6', '51b23612', 'ceb54acb', '577d4d32', '3d86fd0a', '15745da0', 'gpt4_65aabe59', '982b5123')
HARD = ('gpt4_7fce9456', 'gpt4_a1b77f9c', '28dc39ac', 'gpt4_15e38248', '6d550036', '2ce6a0f2', '9d25d4e0', 'gpt4_731e37d7')
NATIVE_ARMS = ('pi-native', 'pi-lite', 'pi-full')
ARMS = (*NATIVE_ARMS, 'package')
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


def package_inventory(root):
    files, links = {}, {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            if not path.resolve(strict=True).is_relative_to(root):
                raise ValueError('Package symlink escapes root: ' + str(path))
            links[str(path.relative_to(root))] = str(path.readlink())
            if path.is_dir():
                raise ValueError('Package directory symlinks must be installed as local directories: ' + str(path))
        if path.is_file():
            files[str(path.relative_to(root))] = common.sha(path)
    return files, links


def freeze_package(source, output, *, index=None):
    source = source.resolve(strict=True)
    metadata = json.loads((source / 'package.json').read_text())
    entries = metadata.get('pi', {}).get('extensions')
    skills = metadata.get('pi', {}).get('skills', [])
    if not isinstance(entries, list) or not entries or any(not isinstance(p, str) or not p for p in entries):
        raise ValueError('Package must explicitly declare nonempty pi.extensions')
    if not isinstance(skills, list) or any(not isinstance(p, str) or not p for p in skills):
        raise ValueError('Package pi.skills must be a path list')
    for entry in entries + skills:
        resolved = (source / entry).resolve(strict=True)
        if not resolved.is_relative_to(source):
            raise ValueError('Declared Pi resource escapes package')
    for name in metadata.get('dependencies', {}):
        if not (source / 'node_modules' / name / 'package.json').is_file():
            raise ValueError('Package dependencies must be installed inside package root: ' + name)
    hashes, links = package_inventory(source)
    target = output / 'package' if index is None else output / 'packages' / str(index)
    identity = {'sourceRoot': str(source), 'path': str(target), 'extensions': entries, 'skills': skills,
                'filesSha256': hashes, 'symlinks': links, 'treeSha256': common.object_sha({'files': hashes, 'symlinks': links})}
    identity_path = output / 'package.json' if index is None else output / 'packages' / (str(index) + '.json')
    if identity_path.exists():
        if json.loads(identity_path.read_text()) != identity:
            raise ValueError('Package source/hash identity changed; refusing resume')
        if package_inventory(target) != (hashes, links):
            raise ValueError('Frozen package hash/inventory changed; refusing resume')
    else:
        if target.exists():
            raise ValueError('Incomplete package freeze refuses resume')
        shutil.copytree(source, target, symlinks=True)
        if package_inventory(target) != (hashes, links):
            raise ValueError('Package source changed during freezing')
        for path in target.rglob('*'):
            if path.is_file() and not path.is_symlink():
                path.chmod(path.stat().st_mode & ~0o222)
        frozen_json(identity_path, identity)
    return identity


def freeze_packages(sources, output):
    if len(sources) == 1:
        if (output / 'packages.json').exists():
            raise ValueError('Package set identity changed; refusing resume')
        return {'package': freeze_package(sources[0], output)}
    if not sources or (output / 'package.json').exists():
        raise ValueError('Package set identity changed; refusing resume')
    packages = [freeze_package(source, output, index=index) for index, source in enumerate(sources, 1)]
    frozen_json(output / 'packages.json', packages)
    return {'packages': packages}


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
    if dataset.startswith('LME16-'):
        questions = []
        for group, ids in (('dev8', DEV), ('hard8', HARD)):
            for qid in ids:
                directory = data / 'data' / group / qid
                question_path = directory / ('question-zh.json' if dataset == 'LME16-Chinese' else 'question.json')
                answer_path = directory / 'answer.json'
                q, reference = json.loads(question_path.read_text()), json.loads(answer_path.read_text())
                if q['question_id'] != qid or reference['question_id'] != qid:
                    raise ValueError('Question/reference ID mismatch')
                questions.append({'id': qid, 'question': q['question'], 'question_date': q['question_date'],
                                  'answer': reference['answer'], 'language': 'zh' if dataset == 'LME16-Chinese' else 'en', 'subset': group,
                                  'type': q.get('question_type', 'unknown'), 'split': group, 'caseId': qid, 'overlap': None})
                inputs.update({str(p): common.sha(p) for p in (question_path, answer_path)})
                if dataset == 'LME16-Chinese':
                    english = directory / 'question.json'
                    questions[-1]['type'] = json.loads(english.read_text()).get('question_type', 'unknown')
                    inputs[str(english)] = common.sha(english)
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
        if prior.get('language', 'en') != q['language']:
            raise ValueError('Snapshot language identity mismatch')
        key = 'pi/' + q['id']
        entry = old['snapshots'][key]
        session = Path(entry['path'])
        absolute_binding = session.is_absolute()
        if not absolute_binding:
            session = source / session
        session = session.resolve(strict=True)
        if not absolute_binding and not session.is_relative_to(source):
            raise ValueError('Relative snapshot session escapes source')
        if session.is_relative_to(output) or output.is_relative_to(session):
            raise ValueError('Snapshot session/output overlap')
        compactions = [row for row in common.transcript(session) if row.get('type') == 'compaction']
        if len(compactions) != 3 or any(not row.get('summary') or 'blind-simulated' in row.get('id', '') for row in compactions):
            raise ValueError('Requires three nonempty native source compactions')
        if any(row.get('message', {}).get('role') == 'user' and ''.join(b.get('text', '') for b in row['message'].get('content', [])) == q['question'] for row in common.transcript(session)):
            raise ValueError('Snapshot already contains evaluation question')
        files[str(session)] = entry['sha256']
        bindings[key] = {'path': str(session), 'sha256': entry['sha256']}
        snapshots[key] = {**entry, **bindings[key], 'language': q['language'], 'reused': True,
                          'sourceRun': str(source), 'sourceFingerprint': old['fingerprint']}
    verify_files(files, 'Snapshot source')
    return snapshots, {'run': str(source), 'fingerprint': old['fingerprint'], 'manifestPath': str(path),
                       'manifestSha256': files[str(path)], 'snapshots': bindings, 'filesSha256': files,
                       'compression': {k: compression[k] for k in ('provider', 'model', 'effort')}}


def verify_snapshot_bindings(manifest, output, native=None):
    identity = manifest['identity']
    if identity.get('compressionMode') != 'package':
        if common.object_sha(manifest['snapshots']) != identity['snapshotsSha256']:
            raise ValueError('Frozen snapshot manifest identity differs')
        return
    from runner import compression
    if native is None:
        native, _ = bind_snapshots(Path(identity['snapshotSource']['run']), output, manifest['questions'], identity['dataset'])
    if common.object_sha(native) != identity['snapshotsSha256'] or set(native) != set(manifest['snapshots']):
        raise ValueError('Frozen native snapshot manifest identity differs')
    for key, original in native.items():
        generated = manifest['snapshots'][key]
        folder = output / 'compression' / key.removeprefix('pi/')
        if generated == original and not (folder / 'snapshot.json').exists():
            continue
        source, session = folder / 'source.jsonl', folder / 'session.jsonl'
        if not all(path.is_file() for path in (source, session, folder / 'snapshot.json', folder / 'snapshot-state.json')):
            raise ValueError('Package snapshot completion evidence missing')
        cuts, count = [0], 0
        for row in common.transcript(Path(original['path'])):
            if row.get('type') == 'message':
                count += 1
            elif row.get('type') == 'compaction':
                cuts.append(count)
        cuts.append(count)
        phase_identity = common.object_sha({'run': manifest['fingerprint'], 'qid': key.removeprefix('pi/'),
                                           'source': common.sha(source), 'cuts': cuts})
        record = common.durable_phase(folder, 'snapshot', phase_identity, lambda: None)
        if record != generated or record['path'] != str(session) or record['sourcePath'] != str(source) or record['cuts'] != cuts:
            raise ValueError('Package snapshot completion identity differs')
        verify_files({str(session): record['sha256'], str(source): record['sourceSha256']}, 'Package snapshot')
        compression.validate_compactions(common.transcript(session), common.transcript(folder / 'compaction-events.jsonl'))


def bind_baseline(source, output, questions, config):
    source = source.resolve(strict=True)
    path = source / 'manifest.json'
    baseline = json.loads(path.read_text())
    if baseline.get('state') != 'complete' or baseline['fingerprint'] != common.object_sha(baseline['identity']):
        raise ValueError('Baseline must be completed and identity-bound')
    if baseline['identity']['config']['system_prompt'] != config['system_prompt']:
        raise ValueError('Baseline configured system prompt differs')
    strict = common.module('baseline_strict', common.ROOT / 'benchmark/judging/strict.py')
    prompt = strict.JUDGE_V2_PROMPT
    if baseline['identity'].get('judgePromptSha256') not in (common.object_sha(prompt), hashlib.sha256(prompt.encode()).hexdigest()):
        raise ValueError('Baseline strict judge prompt differs')
    score_path = source / 'grade-1to10/manifest.json'
    score = json.loads(score_path.read_text())
    if score['identity']['promptSha256'] != hashlib.sha256(common.scorer.JUDGE_PROMPT.encode()).hexdigest():
        raise ValueError('Baseline score prompt differs')
    prior = {q['id']: q for q in baseline['questions']}
    files = {str(p): common.sha(p) for p in (path, score_path)}
    bindings = {}
    for question in questions:
        old = prior[question['id']]
        if any(old.get(k) != question.get(k) for k in ('question', 'question_date', 'language')):
            raise ValueError('Baseline question/language differs')
        question['answer'] = old['answer']
        arm = baseline['arms'][0]
        append = source / 'results' / arm / question['id'] / 'attempts/01/answer-system.txt'
        if append.read_text() != common.answer_system_prompt(question):
            raise ValueError('Baseline answer-system prompt differs')
        files[str(append)] = common.sha(append)
        bindings[question['id']] = {'answerSystemSha256': files[str(append)],
                                    'referenceValueSha256': common.object_sha(old['answer'])}
    evidence = {'run': str(source), 'filesSha256': files, 'questions': bindings,
                'baseSystemSha256': hashlib.sha256(config['system_prompt'].encode()).hexdigest(),
                'answerTemplateSha256': hashlib.sha256(common.b.ASK.encode()).hexdigest(),
                'strictPromptSha256': hashlib.sha256(prompt.encode()).hexdigest(),
                'strictPromptCanonicalSha256': common.object_sha(prompt),
                'scorePromptSha256': hashlib.sha256(common.scorer.JUDGE_PROMPT.encode()).hexdigest()}
    frozen_json(output / 'baseline.json', evidence)
    return evidence


def prepare(args):
    output = args.output.resolve()
    source = args.source_root.resolve(strict=True)
    data = args.data_root.resolve(strict=True)
    if not 1 <= args.workers <= 8 or args.arm not in ARMS:
        raise ValueError('Current arm and 1–8 workers required')
    package_roots = getattr(args, 'package_root', None) or []
    required_inputs = (source, data, args.config.resolve(), *[p.resolve() for p in package_roots]) + tuple(p.resolve() for p in (
        args.snapshot_source, getattr(args, 'baseline_source', None)) if p is not None)
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
    selected = getattr(args, 'question_id', None)
    if selected:
        if args.stage not in ('prepare', 'preflight') or len(set(selected)) != len(selected) or not set(selected) <= {q['id'] for q in questions}:
            raise ValueError('Offline question IDs must be distinct known IDs; paid stages use the full dataset')
        questions = [q for q in questions if q['id'] in selected]
    if dataset.startswith('LME16-'):
        if args.snapshot_source is None:
            raise ValueError('LME16 requires --snapshot-source')
        snapshots, binding = bind_snapshots(args.snapshot_source, output, questions, dataset)
    else:
        snapshots, binding = bind_swe_snapshots(data, args.snapshot_source, output, questions)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    shared_output.mkdir(parents=True, exist_ok=True, mode=0o700)
    candidate = freeze_candidate(source, shared_output)
    config, configs, paths = model_config(args.config.resolve(), candidate, output)
    package = freeze_packages(package_roots, shared_output) if args.arm == 'package' else None
    compression = getattr(args, 'compression', 'native')
    if compression == 'package' and (package is None or not dataset.startswith('LME16-')):
        raise ValueError('Package compression requires --arm package and an LME16 dataset')
    baseline_source = getattr(args, 'baseline_source', None)
    if dataset == 'LME16-Chinese' and baseline_source is None:
        raise ValueError('Chinese requires the historical --baseline-source reference/prompt binding')
    baseline = bind_baseline(baseline_source, output, questions, config) if baseline_source else None
    if baseline:
        inputs.update(baseline['filesSha256'])
    if compression == 'package':
        for question in questions:
            corpus = data / 'data' / question['subset'] / question['id'] / ('corpus-zh.json' if question['language'] == 'zh' else 'corpus.json')
            inputs[str(corpus)] = common.sha(corpus)
    inputs[str(args.config.resolve())] = common.sha(args.config)
    if args.arm in ('pi-lite', 'pi-full'):
        frozen_json(output / 'recall-config.json', {'mode': args.arm.removeprefix('pi-')})
    sources = [common.ROOT / 'benchmark' / name for name in ('run.py', 'report.py',
        'runner/artifacts.py', 'runner/prepare.py', 'runner/phases.py', 'runner/answer_prompt.py',
        'runner/execution.py', 'runner/cases.py', 'runner/resources.py', 'runner/sdk.py',
        'runner/__init__.py', 'judging/strict.py', 'judging/execute.py', 'judging/score.py',
        'judging/score_contract.py', 'judging/__init__.py', 'sdk/extension.mjs',
        'sdk/tools-evidence.mjs', 'sdk/context-evidence.mjs', 'sdk/answer.mjs', 'sdk/judge.mjs',
        'sdk/session.mjs', 'sdk/observer.py', 'sdk/context-estimate.mjs')]
    if package:
        sources.extend(common.ROOT / 'benchmark' / name for name in ('runner/compression.py', 'sdk/package.mjs', 'sdk/no-network.mjs'))
    identity = {'schema': 'current-fixed-snapshot-v1', 'task': dataset + '-' + args.arm, 'dataset': dataset,
                'arm': args.arm, 'inputs': inputs, 'sources': {str(p): common.sha(p) for p in sorted(sources)},
                'candidate': candidate, 'config': config, 'judgeConfigs': configs,
                'snapshotSource': binding, 'workers': args.workers,
                'questionsSha256': common.object_sha(questions), 'snapshotsSha256': common.object_sha(snapshots),
                'budgetPolicy': {'answerEstimate': 'diagnostic-only', 'actualOutputBudget': 'unchanged',
                                 'capacityRejection': 'stop new cases; no capacity retry; retain in-flight results'},
                'resourcePolicy': {'wholeRunMemoryMaxBytes': 14 * 1024 ** 3, 'wholeRunMemorySwapMaxBytes': 0,
                                   'maxConcurrentSessions': args.workers, 'authorizedSessionCeiling': 8}}
    if package:
        identity.update(**package, compressionMode=compression)
    if baseline:
        identity['baselineSource'] = baseline
    fingerprint = common.object_sha(identity)
    path = output / 'manifest.json'
    if path.exists():
        manifest = json.loads(path.read_text())
        if compression == 'package':
            verify_snapshot_bindings(manifest, output, native=snapshots)
            snapshots = manifest['snapshots']
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
    return output, config, {'sqlite': candidate, **(package or {})}, manifest, configs, paths
