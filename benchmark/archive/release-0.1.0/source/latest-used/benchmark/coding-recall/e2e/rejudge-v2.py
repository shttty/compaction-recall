"""Rejudge immutable LME16 answers only; two tool-free judges, four sessions."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import subprocess
import time

import run as common

HERE = Path(__file__).resolve().parent
e = common.e
contract = common.module('judge_v2_contract', HERE / 'judge-v2.py')


def load_inputs(output):
    manifest_path = output / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('identity', {}).get('dataset') != 'LME16-English' or manifest.get('state') != 'complete':
        raise ValueError('Requires completed real LME16 original run')
    lme = common.module('rejudge_lme_ids', HERE / 'lme-run.py')
    if set(manifest['selected']) != set(lme.DEV + lme.HARD) or tuple(manifest['arms']) != common.ARMS:
        raise ValueError('Original LME16 matrix differs from authorized 80 answers')
    questions = {question['id']: question for question in manifest['questions']}
    inputs, hashes = [], {str(manifest_path): e.file_sha(manifest_path)}
    for arm in common.ARMS:
        for qid in manifest['selected']:
            source = output / 'results' / arm / qid / 'result.json'
            record = json.loads(source.read_text())
            if record.get('arm') != arm or record.get('question_id') != qid or record.get('outcome') != 'answered' or not isinstance(record.get('answer'), str):
                raise ValueError('Original answer is missing or has unexpected identity')
            for key, digest_key in (('session', 'sessionSha256'), ('judgeSession', 'judgeSessionSha256')):
                filename = Path(record[key])
                if e.file_sha(filename) != record[digest_key]:
                    raise ValueError('Original answer/judge session bytes changed')
                hashes[str(filename)] = record[digest_key]
            hashes[str(source)] = e.file_sha(source)
            question = questions[qid]
            prompt = contract.build_prompt(question['question'], question['answer'], record['answer'], question['question_date'])
            inputs.append({'arm': arm, 'question_id': qid, 'model_answer': record['answer'], 'prompt': prompt,
                           'inputSha256': e.object_sha({'prompt': prompt}), 'originalResultSha256': hashes[str(source)]})
    return manifest, inputs, hashes


def judge_one(item, label, config_path, selected, directory, fingerprint, *, rpc_runner=None, verdict_parser=None):
    directory.mkdir(parents=True, exist_ok=True)
    identity = e.object_sha({'run': fingerprint, 'judgeName': label, 'arm': item['arm'], 'question_id': item['question_id'], 'inputSha256': item['inputSha256']})
    def operation():
        session = directory / 'judge-session.jsonl'
        record = {key: item[key] for key in ('arm', 'question_id', 'inputSha256', 'originalResultSha256')}
        record.update(judgeName=label, status='provider-error', verdict=None, rawVerdict='', failureKind=None)
        start = time.monotonic()
        stage = 'provider'
        try:
            command = ['node', str(HERE / 'judge-pi-rpc.mjs'), '--config', str(config_path), '--phase', 'judge', '--session', str(session)]
            observed = (rpc_runner or e.rpc.run_rpc)(command, e.child_env(), directory, prompt=item['prompt'], timeout=900)
            record['timing'] = observed['timing']
            record['rpcOutcome'] = observed['outcome']
            record['rc'] = observed['rc']
            if observed['outcome'] != 'completed' or observed['rc'] != 0:
                record['failureKind'] = observed['outcome']
                raise RuntimeError('Judge provider did not complete')
            stage = 'evidence'
            rows = common.transcript(session)
            users = [row['message'] for row in rows if row.get('message', {}).get('role') == 'user']
            if len(users) != 1 or ''.join(block.get('text', '') for block in users[0]['content'] if block.get('type') == 'text') != item['prompt']:
                raise ValueError('Judge transcript differs from frozen v2 input')
            assistants, thinking = [], None
            for row in rows:
                if row.get('type') == 'thinking_level_change':
                    thinking = row.get('thinkingLevel')
                message = row.get('message', {})
                if message.get('role') == 'toolResult' or any(block.get('type') == 'toolCall' for block in message.get('content', []) if isinstance(block, dict)):
                    raise ValueError('Judge must not use tools')
                if message.get('role') == 'assistant':
                    assistants.append((message, message.get('thinkingLevel', thinking)))
            if len(assistants) != 1:
                raise ValueError('Judge must return exactly one assistant answer')
            assistant, effort = assistants[0]
            effort_path = directory / 'effort-evidence.json'
            serialized = json.loads(effort_path.read_text())
            if set(serialized) != {'effort', 'source'} or serialized['effort'] != selected['effort'] or serialized['source'] != 'onPayload':
                raise ValueError('Serialized judge effort differs from requested tier')
            if effort is not None and effort != serialized['effort']:
                raise ValueError('Recorded and serialized judge tiers differ')
            effort = serialized['effort']
            record['effortEvidence'] = {'path': str(effort_path), 'sha256': e.file_sha(effort_path), **serialized}
            record['rawVerdict'] = ''.join(block.get('text', '') for block in assistant.get('content', []) if block.get('type') == 'text')
            record['tokens'] = assistant.get('usage')
            record['judgeEvidence'] = {'provider': assistant.get('provider'), 'model': assistant.get('model'), 'effort': effort, 'stopReason': assistant.get('stopReason')}
            if assistant.get('stopReason') == 'error':
                stage = 'provider'; record['failureKind'] = 'model-error'
                raise RuntimeError('Judge provider failed')
            if assistant.get('provider') != selected['provider'] or assistant.get('model') != selected['model'] or effort != selected['effort'] or assistant.get('stopReason') != 'stop':
                raise ValueError('Actual judge provider/model/effort or stop reason differs')
            stage = 'verdict'
            record['verdict'] = (verdict_parser or contract.parse_verdict)(record['rawVerdict'], item['model_answer'])
            record['status'] = 'graded'
        except Exception as error:
            record['status'] = 'provider-error' if stage == 'provider' else 'judge-error'
            record['failureKind'] = record.get('failureKind') or stage
            # Provider text may contain arbitrary credentials. Parser diagnostics
            # never include input values; record only category/type for all errors.
            record['error'] = stage + ': ' + type(error).__name__
        record['seconds'] = time.monotonic() - start
        if session.exists():
            record.update(session=str(session), sessionSha256=e.file_sha(session))
        return record
    saved = common.durable_phase(directory, 'result', identity, operation)
    print(json.dumps({'judge': label, 'arm': item['arm'], 'id': item['question_id'], 'status': saved['status'],
                      'correct': (saved.get('verdict') or {}).get('correct'), 'guess': (saved.get('verdict') or {}).get('guess'),
                      'hedged': (saved.get('verdict') or {}).get('hedged')}), flush=True)
    return saved


def run(args):
    output = args.output.resolve()
    root = output / 'judge-v2'
    root.mkdir(mode=0o700, exist_ok=True)
    original, inputs, hashes = load_inputs(output)
    sources = {'luna': args.luna_config.resolve(), 'sol': args.sol_config.resolve()}
    configs, selected, paths = {}, {}, {}
    for label, source in sources.items():
        config = json.loads(source.read_text())
        config['output_dir'] = str(root / label)
        (root / label).mkdir(mode=0o700, exist_ok=True)
        if label == 'luna':
            config['judge']['effort'] = 'xhigh'
        selected[label] = config['judge']
        configs[label] = config
        paths[label] = root / (label + '-config.json')
        if paths[label].exists() and json.loads(paths[label].read_text()) != config:
            raise ValueError('Existing judge configuration changed')
        if not paths[label].exists():
            e.write_json(paths[label], config)
    if selected['luna']['model'] != 'gpt-6-luna' or selected['luna']['effort'] != 'xhigh':
        raise ValueError('Luna judge must be gpt-6-luna xhigh')
    identity = {'task': 'RSM-E2E-REJUDGE-V2-20261005', 'originalFingerprint': original['fingerprint'],
                'originalInputsSha256': hashes, 'sourceConfigsSha256': {str(path): e.file_sha(path) for path in sources.values()},
                'configs': configs, 'promptSha256': e.object_sha(contract.JUDGE_V2_PROMPT),
                'sourceSha256': {str(path): e.file_sha(path) for path in (Path(__file__), HERE / 'judge-v2.py', HERE / 'run.py', Path(e.__file__), Path(e.rpc.__file__), common.ROOT / 'benchmark/sdk-rpc.mjs', HERE / 'judge-pi-rpc.mjs')},
                'transports': {'luna': 'Pi SDK 1.0.0; generated noncredential model override xhigh=xhigh; onPayload guarded', 'sol': 'Pi SDK 1.0.0; original definition; onPayload guarded'},
                'maxSessions': 4, 'recordsPerJudge': 80, 'inputPolicy': 'original final assistant answer, question, reference, date only; no group or v1 score shown'}
    fingerprint = e.object_sha(identity)
    manifest_path = root / 'manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest.get('fingerprint') != fingerprint:
            raise ValueError('Frozen v2 configuration/data/code changed; refusing resume')
    else:
        manifest = {'fingerprint': fingerprint, 'identity': identity, 'state': 'prepared', 'judges': selected, 'inputs': [{'arm': item['arm'], 'question_id': item['question_id'], 'inputSha256': item['inputSha256']} for item in inputs]}
        e.write_json(manifest_path, manifest)
    # Host-only profile loading. Never substitute or clamp an unsupported tier.
    for label, config_path in paths.items():
        description = subprocess.run(['node', str(HERE / 'judge-pi-rpc.mjs'), '--config', str(config_path), '--phase', 'judge', '--describe'],
                                     env=e.child_env(), capture_output=True, text=True)
        if description.returncode:
            raise RuntimeError('Judge descriptor failed for ' + label + '; provider details not exposed')
        actual = json.loads(description.stdout)
        if any(actual[key] != selected[label][key] for key in ('provider', 'model', 'effort')):
            raise ValueError('Judge descriptor differs from selected configuration')
        manifest.setdefault('descriptors', {})[label] = actual
    manifest['state'] = 'running'; e.write_json(manifest_path, manifest)
    records = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(judge_one, item, label, paths[label], selected[label], root / label / item['arm'] / item['question_id'], fingerprint)
                   for item in inputs for label in ('luna', 'sol')]
        for future in as_completed(futures):
            records.append(future.result())
    # A result is already durable before the run ledger becomes visible.
    e.write_json(root / 'ledger.json', {'fingerprint': fingerprint, 'records': records})
    for filename, digest in hashes.items():
        if e.file_sha(Path(filename)) != digest:
            raise ValueError('Original answers/old judging changed during v2 run')
    manifest['state'] = 'complete'
    manifest['outcomes'] = {label: {status: sum(record['judgeName'] == label and record['status'] == status for record in records)
                                  for status in ('graded', 'judge-error', 'provider-error')} for label in ('luna', 'sol')}
    e.write_json(manifest_path, manifest)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='Completed original lme16-native directory')
    parser.add_argument('--luna-config', type=Path, required=True, help='Explicit existing Luna judge config; requested effort is xhigh')
    parser.add_argument('--sol-config', type=Path, required=True, help='Explicit original Sol judge config')
    run(parser.parse_args())
