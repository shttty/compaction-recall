"""Generate English LME16 snapshots with the locked Pi SDK's native automatic compaction."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import time
import uuid

from runner import artifacts as common
from runner import compression, prepare, resources


WORKER = Path(__file__).resolve().parent / 'sdk/native-snapshot.mjs'


def source_rows(corpus, model, cwd):
    """Render only corpus messages; usage is unknown, not fabricated provider usage."""
    rows = [{'type': 'session', 'version': 3, 'id': str(uuid.uuid4()),
             'timestamp': datetime.now(timezone.utc).isoformat(), 'cwd': str(cwd)}]
    parent = None
    for entry_id, role, content, timestamp in compression.corpus_projection(corpus):
        if role not in ('user', 'assistant'):
            raise ValueError('Corpus contains a non-conversation role')
        message = {'role': role, 'content': content, 'timestamp': timestamp}
        if role == 'assistant':
            message.update(api='openai-responses', provider=model['provider'], model=model['model'],
                           stopReason='stop', usage={
                               'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 0,
                               'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}})
        rows.append({'type': 'message', 'id': entry_id, 'parentId': parent,
                     'timestamp': datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat(),
                     'message': message})
        parent = entry_id
    return rows


def run_worker(command, folder):
    # Provider diagnostics are untrusted and may echo credentials. Keep only fixed
    # local failure labels; the SDK worker persists selected non-secret evidence.
    process = subprocess.run(command, env=common.child_env(), capture_output=True, text=True)
    if process.returncode:
        raise RuntimeError('Native snapshot worker failed; inspect selected worker evidence')


def generate_question(output, config, fingerprint, question, corpus_path, *, worker_runner=None):
    qid = question['id']
    folder = output / 'questions' / qid
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    source, session, result_path = (folder / name for name in ('source.jsonl', 'session.jsonl', 'worker-result.json'))
    corpus = json.loads(corpus_path.read_text())
    if source.exists():
        rows = common.transcript(source)
        if [compression.projection(row) for row in rows[1:]] != compression.corpus_projection(corpus):
            raise ValueError('Frozen source corpus projection changed')
    else:
        rows = source_rows(corpus, config['answer'], output / 'cwd')
        source.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
        source.chmod(0o400)
    identity = common.object_sha({'run': fingerprint, 'qid': qid, 'sourceSha256': common.sha(source)})

    def operation():
        started = time.monotonic()
        command = ['node', str(WORKER), '--config', str(output / 'config.json'),
                   '--source', str(source), '--session', str(session), '--result', str(result_path)]
        (worker_runner or run_worker)(command, folder)
        observed = json.loads(result_path.read_text())
        _, messages, cuts = compression.source_history(session, corpus)
        actual_cuts = prepare.native_compaction_cuts(common.transcript(session))
        if [row['cut'] for row in observed['compactions']] != actual_cuts:
            raise ValueError('Native worker compaction cuts differ from session')
        if observed['messageCount'] != len(messages) or observed['sdkVersion'] != '1.4.0':
            raise ValueError('Native worker source count or SDK version differs')
        if any(row['message']['role'] == 'user' and ''.join(block.get('text', '') for block in row['message']['content']) == question['question']
               for row in messages):
            raise ValueError('Snapshot contains evaluation question')
        return {'path': str(session), 'sha256': common.sha(session), 'sourcePath': str(source),
                'sourceSha256': common.sha(source), 'workerResultPath': str(result_path),
                'workerResultSha256': common.sha(result_path), 'messageCount': len(messages), 'cuts': cuts,
                'compactions': observed['compactions'], 'sdkVersion': observed['sdkVersion'],
                'elapsedSeconds': time.monotonic() - started}

    saved = common.durable_phase(folder, 'snapshot', identity, operation)
    prepare.verify_files({saved['path']: saved['sha256'], saved['sourcePath']: saved['sourceSha256'],
                          saved['workerResultPath']: saved['workerResultSha256']}, 'Native snapshot')
    return saved


def generate(args):
    source, data, output = (path.resolve() for path in (args.source_root, args.data_root, args.output))
    if output == source or output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError('Snapshot output and source root must be disjoint')
    if output == data or output.is_relative_to(data) or data.is_relative_to(output):
        raise ValueError('Snapshot output and data root must be disjoint')
    scope = resources.whole_scope()
    questions, inputs = prepare.load_questions(data, 'LME16-English')
    corpora = {q['id']: data / 'data' / q['subset'] / q['id'] / 'corpus.json' for q in questions}
    inputs.update({str(path): common.sha(path) for path in corpora.values()})
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    candidate = prepare.freeze_candidate(source, output)
    config, _, _ = prepare.model_config(args.config.resolve(), candidate, output)
    sources = [Path(__file__).resolve(), WORKER, *(Path(module.__file__).resolve() for module in (compression, prepare, common))]
    identity = {'schema': 'lme16-native-auto-snapshots-v1', 'dataset': 'LME16-English',
                'config': {'compression': {key: config['answer'][key] for key in ('provider', 'model', 'effort')},
                           'sdkConfig': config}, 'inputs': inputs, 'candidate': candidate,
                'sources': {str(path): common.sha(path) for path in sources},
                'questionsSha256': common.object_sha(questions),
                'policy': {'automaticCompaction': True, 'contextWindow': 200000, 'sdkVersion': '1.4.0',
                           'workers': args.workers, 'noUnknownInflightReplay': True}}
    fingerprint = common.object_sha(identity)
    manifest_path = output / 'manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest['identity'] != identity or manifest['fingerprint'] != fingerprint or manifest['questions'] != questions:
            raise ValueError('Native snapshot identity changed; refusing resume')
    else:
        manifest = {'identity': identity, 'fingerprint': fingerprint, 'questions': questions,
                    'state': 'prepared', 'snapshots': {}, 'failures': {}, 'startedAt': datetime.now(timezone.utc).isoformat()}
        common.write_json(manifest_path, manifest)
    prepare.verify_files(inputs, 'Native snapshot input')
    prepare.verify_files(identity['sources'], 'Native snapshot generator')
    if manifest['state'] == 'complete':
        def no_replay(command, folder):
            raise ValueError('Completed snapshot source refuses model replay')
        for question in questions:
            saved = generate_question(output, config, fingerprint, question, corpora[question['id']], worker_runner=no_replay)
            if saved != manifest['snapshots']['pi/' + question['id']]:
                raise ValueError('Completed native snapshot binding changed')
        prepare.bind_snapshots(output, output.with_name(output.name + '-binding-check'), questions, 'LME16-English')
        return manifest
    manifest['state'] = 'running'
    common.write_json(manifest_path, manifest)

    def question_job(question):
        return generate_question(output, config, fingerprint, question, corpora[question['id']])

    # One worker owns one SDK session; no per-question nested model concurrency.
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(question_job, question): question for question in questions
                if question['id'] not in manifest['failures']}
        for job in as_completed(jobs):
            qid = jobs[job]['id']
            try:
                saved = job.result()
                manifest['snapshots']['pi/' + qid] = saved
                print(json.dumps({'id': qid, 'state': 'complete', 'cuts': saved['cuts'],
                                  'seconds': saved['elapsedSeconds']}), flush=True)
            except Exception as error:
                manifest['failures'][qid] = {'state': 'failed', 'error': common.safe_error(error),
                                             'phaseState': str(output / 'questions' / qid / 'snapshot-state.json')}
                print(json.dumps({'id': qid, 'state': 'failed', 'error': common.safe_error(error)}), flush=True)
            common.write_json(manifest_path, manifest)
    prepare.verify_files(inputs, 'Native snapshot input')
    prepare.verify_files(identity['sources'], 'Native snapshot generator')
    manifest['state'] = 'complete' if len(manifest['snapshots']) == len(questions) and not manifest['failures'] else 'partial' if manifest['snapshots'] else 'failed'
    manifest['finishedAt'] = datetime.now(timezone.utc).isoformat()
    manifest['resources'] = {'cgroupPath': str(scope), 'memoryMaxBytes': resources.MEMORY_MAX,
                             'memorySwapMaxBytes': 0, 'memoryPeakBytes': int((scope / 'memory.peak').read_text())}
    common.write_json(manifest_path, manifest)
    if manifest['state'] == 'complete':
        prepare.bind_snapshots(output, output.with_name(output.name + '-binding-check'), questions, 'LME16-English')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('config', 'data-root', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--source-root', type=Path, default=common.ROOT)
    parser.add_argument('--workers', type=int, choices=range(1, 9), default=8)
    args = parser.parse_args()
    manifest = generate(args)
    print(json.dumps({'state': manifest['state'], 'completed': len(manifest['snapshots']), 'failures': len(manifest['failures'])}), flush=True)
    if manifest['state'] != 'complete':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
