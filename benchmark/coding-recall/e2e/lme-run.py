"""Real LME16: reuse native Pi baselines, supplement missing cases, no pilot gate."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import queue
import threading
import subprocess

import run as common

HERE = Path(__file__).resolve().parent
ROOT = common.ROOT
e = common.e
DEV = ('778164c6', '51b23612', 'ceb54acb', '577d4d32', '3d86fd0a', '15745da0', 'gpt4_65aabe59', '982b5123')
HARD = ('gpt4_7fce9456', 'gpt4_a1b77f9c', '28dc39ac', 'gpt4_15e38248', '6d550036', '2ce6a0f2', '9d25d4e0', 'gpt4_731e37d7')
ARMS = common.ARMS


def prepare(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    config = json.loads(args.config.read_text())
    config['judge'] = json.loads(args.judge_config.read_text())['judge']
    config['output_dir'] = str(output)
    # The original lme-bench native CLI uses SDK defaults, not coding keepRecent=0.
    config['protocol']['reserve_tokens'] = 16384
    e.CONFIG = config
    e.CONFIG_PATH = output / 'config.json'
    e.write_json(e.CONFIG_PATH, config)
    e.b = e.configuration.load_helper(Path(config['helper_path']), config)
    pins = json.loads(args.pins.read_text())
    wrappers = {}
    prompts = str(Path(pins['mainline']['path']) / 'archive/doc/SOFT_MATCH_PROMPTS.md')
    for name, commit in common.COMMITS.items():
        pin = pins[name]
        if pin['commit'] != commit or any(e.file_sha(Path(pin['path']) / path) != digest for path, digest in pin['runtimeClosureSha256'].items()):
            raise ValueError('Pinned plugin archive changed')
        folder = output / 'wrappers' / name
        folder.mkdir(parents=True, exist_ok=True)
        settings = {'entry': str(Path(pin['path']) / pin['entry']), 'sdkPath': config['sdk_path'], 'promptsPath': prompts, 'sqlite': name == 'sqlite'}
        entry = folder / 'entry.mjs'
        source = f"import {{ registerPinned }} from {json.dumps(str(HERE / 'plugin.mjs'))};\nexport default pi => registerPinned(pi, {json.dumps(settings)});\n"
        if entry.exists() and entry.read_text() != source:
            raise ValueError('Existing wrapper changed')
        if not entry.exists():
            entry.write_text(source)
        e.write_json(folder / 'package.json', {'type': 'module', 'pi': {'extensions': ['./entry.mjs']}})
        entry.chmod(0o444); (folder / 'package.json').chmod(0o444)
        wrappers[name] = folder
    e.write_json(output / 'omp-config.json', {**config, 'prompts_path': prompts})
    cases = [c for c in json.loads((args.s5_run / 'cases.json').read_text()) if c['language'] == 'en']
    if {c['questionId'] for c in cases} != set(DEV + HARD) or len(cases) != 16:
        raise ValueError('Expected exact S5 English DEV8 and harder8 IDs')
    questions, inputs = {}, {}
    for case in cases:
        qid = case['questionId']
        directory = args.data_root / 'data' / case['key']
        question_path, reference_path = directory / 'question.json', directory / 'answer.json'
        source = json.loads(question_path.read_text())
        reference = json.loads(reference_path.read_text())['answer']
        if source['question'] != case['question']:
            raise ValueError('S5 and frozen English question differ')
        questions[qid] = {'id': qid, 'question': case['question'], 'question_date': case['questionDate'], 'answer': reference,
                          'type': source.get('question_type', 'unknown'), 'language': 'en', 'subset': case['key'].split('/')[0],
                          'split': case['key'].split('/')[0], 'caseId': qid, 'overlap': None}
        inputs.update({str(path): e.file_sha(path) for path in (question_path, reference_path)})
    inputs.update({str(path): e.file_sha(path) for path in (args.config, args.judge_config, args.s5_run / 'cases.json', args.pins)})
    identity = {'task': 'RSM-E2E-RUN16-20261005', 'dataset': 'LME16-English', 'inputs': inputs, 'config': config,
                'plugins': {name: pins[name] for name in common.COMMITS}, 'questionProtocol': 'raw original question only; date and original ASK requirements appended to system',
                'sources': {str(path): e.file_sha(path) for path in (Path(__file__), HERE / 'run.py', HERE / 'plugin.mjs', HERE / 'pi-rpc.mjs', ROOT / 'benchmark/sdk-rpc.mjs', Path(config['helper_path']))},
                'judgePromptSha256': hashlib.sha256(common.scorer.JUDGE_PROMPT.encode()).hexdigest(), 'accuracy': 'score >=8, S5 atLeast8 descriptive bucket'}
    fingerprint = e.object_sha(identity)
    manifest_path = output / 'manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest['fingerprint'] != fingerprint:
            raise ValueError('Manifest/config/data/code changed; refusing implicit rerun')
    else:
        manifest = {'fingerprint': fingerprint, 'identity': identity, 'selected': list(DEV + HARD), 'questions': list(questions.values()),
                    'arms': list(ARMS), 'state': 'running', 'snapshots': {}, 'errors': [], 'hostStates': {}}
        e.write_json(manifest_path, manifest)
    lock = threading.Lock()
    def register_snapshot(qid, mode, filename, metadata):
        rows = common.transcript(filename)
        compactions = [row for row in rows if row['type'] == 'compaction']
        if len(compactions) != 3 or any(not row.get('summary') for row in compactions):
            raise ValueError('Only genuine three-compaction native snapshots are allowed')
        if any(row.get('message', {}).get('role') == 'user' and ''.join(block.get('text', '') for block in row['message'].get('content', []) if block.get('type') == 'text') in (questions[qid]['question'], e.b.ASK.format(questions[qid]['question_date'], questions[qid]['question'])) for row in rows):
            raise ValueError('Snapshot already contains the evaluation question')
        value = {'path': str(filename), 'sha256': e.file_sha(filename), 'compactions': len(compactions), **metadata}
        with lock:
            saved = manifest['snapshots'].get(f'{mode}/{qid}')
            if saved and saved['sha256'] != value['sha256']:
                raise ValueError('Saved snapshot bytes changed')
            manifest['snapshots'][f'{mode}/{qid}'] = value
            e.write_json(manifest_path, manifest)
        return filename
    def boundary(phase, session, mode, arm=None):
        if mode == 'omp':
            command = ['python3', str(HERE / 'omp-rpc.py'), '--config', str(output / 'omp-config.json'), '--phase', phase, '--session', str(session), '--replay-policy', 'lme-native']
            if arm == 'omp-sqlite':
                command += ['--plugin-entry', str(Path(pins['sqlite']['path']) / pins['sqlite']['entry']), '--timing-file', str(session.parent / 'timing.jsonl')]
        else:
            script = HERE / 'pi-rpc.mjs' if phase == 'answer' else ROOT / 'benchmark/sdk-rpc.mjs'
            command = ['node', str(script), '--config', str(e.CONFIG_PATH), '--phase', phase, '--session', str(session)]
            if phase == 'answer':
                command += ['--arm', 'native' if arm == 'pi-native' else 'production']
                if arm != 'pi-native':
                    command += ['--plugin-dir', str(wrappers['mainline' if arm == 'pi-mainline' else 'sqlite']), '--timing-file', str(session.parent / 'timing.jsonl')]
        if phase == 'answer':
            command += ['--append-system-prompt', str(session.parent / 'answer-system.txt')]
        return command
    return output, config, questions, manifest, fingerprint, lock, register_snapshot, boundary


def build_native(qid, raw, mode, output, fingerprint, boundary):
    folder = output / 'compression' / mode / qid
    folder.mkdir(parents=True, exist_ok=True)
    session, progress_path = folder / 'session.jsonl', folder / 'progress.json'
    if progress_path.exists():
        saved = json.loads(progress_path.read_text())
        if saved.get('state') == 'complete' and saved.get('fingerprint') == fingerprint and saved['sha256'] == e.file_sha(session):
            return session, saved
        raise ValueError('Prior incomplete/failed compression needs an explicit disposition, never implicit retry')
    source = folder / 'source.jsonl'
    e.b.build_session(raw, source, pi=mode == 'pi')
    lines = e.b.jsonl_lines(source)
    header = 1 if mode == 'pi' else 2
    messages = lines[header:]
    cuts = [0, *e.b.chunk_cuts(messages, 4), len(messages)]
    if len(cuts) != 5:
        raise ValueError('Original lme-bench four-segment cuts unavailable')
    saved = {'fingerprint': fingerprint, 'state': 'inflight', 'cuts': cuts, 'sourceSha256': e.file_sha(source), 'compactions': []}
    session.write_text('\n'.join(lines[:header] + messages[:cuts[1]]) + '\n')
    e.write_json(progress_path, saved)
    for stage in range(3):
        result = common.compact_rpc(boundary('compression', session, mode), folder)
        saved['compactions'].append(result)
        saved['sha256'] = e.file_sha(session)
        if not result['success']:
            saved['state'] = 'failed'; e.write_json(progress_path, saved)
            raise RuntimeError(f'Native compaction failed at stage {stage + 1}; see {progress_path}')
        if stage < 2:
            e.b.append_entries(session, messages[cuts[stage + 1]:cuts[stage + 2]])
        else:
            e.b.append_entries(session, messages[cuts[3]:])
        e.write_json(progress_path, saved)
    saved.update(state='complete', sha256=e.file_sha(session))
    e.write_json(progress_path, saved)
    return session, saved


def run(args):
    output, config, questions, manifest, fingerprint, lock, register, boundary = prepare(args)
    active_arms = ARMS[:3] if args.host == 'pi' else ARMS[3:]
    jobs = queue.PriorityQueue()
    sequence = 0
    errors = []
    records = []
    def error_record(qid, arm, error):
        record = {'question_id': qid, 'arm': arm, 'outcome': 'snapshot-error', 'answer': '', 'tool_calls': [], 'tokens': None,
                  'error': e.safe_error(error), 'metadata': questions[qid], 'judge': {'correct': None, 'status': 'snapshot-error'}}
        folder = output / 'results' / arm / qid
        folder.mkdir(parents=True, exist_ok=True)
        e.write_json(folder / 'result.json', record)
        with lock:
            records.append(record); errors.append({'qid': qid, 'arm': arm, 'error': record['error']})
    def enqueue(qid, filename, priority):
        nonlocal sequence
        for arm in active_arms:
            sequence += 1
            jobs.put((priority, sequence, qid, arm, filename))
    def worker():
        while True:
            item = jobs.get()
            if item[2] is None:
                jobs.task_done(); return
            _, _, qid, arm, filename = item
            try:
                if e.file_sha(filename) != manifest['snapshots'][f'{args.host}/{qid}']['sha256']:
                    raise ValueError('Snapshot changed after launch checks')
                record = common.answer_one(questions[qid], arm, filename, output, fingerprint, boundary)
                with lock:
                    records.append(record)
            except Exception as error:
                error_record(qid, arm, error)
            finally:
                jobs.task_done()
    # Reserve one of four session slots for supplementing native snapshots.
    workers = [threading.Thread(target=worker) for _ in range(3)]
    for worker_thread in workers:
        worker_thread.start()
    missing = []
    for qid in DEV + HARD:
        filename = args.pi_snapshots / f'{qid}.jsonl'
        if args.host == 'pi' and filename.is_file():
            try:
                enqueue(qid, register(qid, 'pi', filename, {'reused': True, 'source': 'lme-bench frozen pi-compacted baseline'}), 1)
            except Exception as error:
                for arm in active_arms:
                    error_record(qid, arm, error)
        else:
            missing.append(qid)
    # Streaming original M; no full-source load and no personal profile access.
    if missing:
        wanted = set(missing)
        try:
            for raw in e.records(Path(config['data_path'])):
                qid = raw.get('question_id')
                if qid not in wanted:
                    continue
                wanted.remove(qid)
                try:
                    session, provenance = build_native(qid, e.serializable_question(raw), args.host, output, fingerprint, boundary)
                    enqueue(qid, register(qid, args.host, session, {'reused': False, 'source': 'original lme-bench build/chunk/append helpers', 'build': provenance}), 0)
                except Exception as error:
                    for arm in active_arms:
                        error_record(qid, arm, error)
                if not wanted:
                    break
        except Exception as error:
            for qid in wanted:
                for arm in active_arms:
                    error_record(qid, arm, error)
            wanted.clear()
        for qid in wanted:
            for arm in active_arms:
                error_record(qid, arm, 'Missing original M question')
    jobs.join()
    for index in range(len(workers)):
        jobs.put((99, sequence + index + 1, None, None, None))
    for worker_thread in workers:
        worker_thread.join()
    e.write_json(output / f'{args.host}-ledger.json', {'fingerprint': fingerprint, 'records': records})
    manifest['hostStates'][args.host] = 'complete'
    manifest['errors'].extend(errors)
    manifest['state'] = 'complete' if all(manifest['hostStates'].get(host) == 'complete' for host in ('pi', 'omp')) else args.host + '-complete'
    e.write_json(output / 'manifest.json', manifest)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('config', 'judge-config', 's5-run', 'data-root', 'pins', 'pi-snapshots', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--host', choices=('pi', 'omp'), default='pi')
    run(parser.parse_args())
