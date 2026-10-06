"""Durable current answer and strict-judge operations."""


import json


from pathlib import Path


import re


import shutil


import subprocess


import time


from runner import artifacts as common


HERE = Path(__file__).resolve().parent



judge = common.module('current_judge', HERE.parent / 'judging/execute.py')


MAX_ATTEMPTS = 3


TIMEOUT_TEXT = re.compile(r'timeout|timed out', re.I)






def source_snapshot(manifest, arm, qid):
    return Path(manifest['snapshots']['pi/' + qid]['path'])


def tool_timeouts(record):
    if not record.get('session'):
        return 0
    path = Path(record['session'])
    snapshot = Path(record.get('snapshotPath', ''))
    if not path.is_file() or not snapshot.is_file():
        return 0
    suffix = path.read_bytes()[len(snapshot.read_bytes()):]
    rows = [json.loads(line) for line in suffix.decode().split('\n') if line]
    return sum(bool(row.get('message', {}).get('isError')) and bool(TIMEOUT_TEXT.search(json.dumps(row['message'].get('content', []))))
               for row in rows if row.get('message', {}).get('role') == 'toolResult')


def answer_attempt(output, config, pins, manifest, question, arm, folder, *, command_factory, rpc_runner=None):
    folder.mkdir(parents=True, exist_ok=True)
    snapshot = source_snapshot(manifest, arm, question['id'])
    identity = common.object_sha({'run': manifest['fingerprint'], 'tools': manifest['toolEvidence'][arm]['sha256'], 'arm': arm, 'id': question['id'], 'attempt': folder.name})
    def operation():
        session = folder / 'session.jsonl'
        shutil.copyfile(snapshot, session)
        (folder / 'answer-system.txt').write_text(common.answer_system_prompt(question))
        expected = Path(manifest['toolEvidence'][arm]['path'])
        command = command_factory(output, config, pins, arm, folder, session, folder / 'tools.json', expected)
        start = time.monotonic()
        try:
            observed = (rpc_runner or common.rpc.run_rpc)(command, common.child_env(), folder, prompt=question['question'], timeout=900)
        except Exception as error:
            observed = {'outcome': 'provider-exception', 'rc': -1, 'timing': {}, 'stderr': ''}
        elapsed = (time.monotonic() - start) * 1000
        try:
            record = common.extract_answer(session, snapshot, observed, question, arm, elapsed)
        except Exception:
            record = {'arm': arm, 'question_id': question['id'], 'outcome': 'chain-error', 'answer': '', 'tool_calls': [], 'toolResults': [], 'tokens': None,
                      'session': str(session), 'sessionSha256': common.sha(session), 'snapshotSha256': common.sha(snapshot), 'answerWallMs': elapsed,
                      'metadata': {key: question.get(key) for key in ('caseId', 'subset', 'language', 'type', 'overlap')}}
        record.update(snapshotPath=str(snapshot), providerTimeout='timeout' in observed['outcome'], rpcOutcome=observed['outcome'], rc=observed['rc'])
        record['toolTimeoutErrors'] = tool_timeouts(record)
        evidence = folder / 'tools.json'
        if evidence.exists():
            record['toolsEvidence'] = {'path': str(evidence), 'sha256': common.sha(evidence)}
        elif record['outcome'] == 'answered':
            record['outcome'] = 'chain-error'
        return record
    return common.durable_phase(folder, 'answer', identity, operation)


def answer_one(output, config, pins, manifest, question, arm, *, command_factory, stop_retry=None, rpc_runner=None):
    directory = output / 'results' / arm / question['id']
    directory.mkdir(parents=True, exist_ok=True)
    identity = common.object_sha({'run': manifest['fingerprint'], 'tools': manifest['toolEvidence'][arm]['sha256'], 'arm': arm, 'id': question['id']})
    def operation():
        attempts = []
        for number in range(1, MAX_ATTEMPTS + 1):
            saved = answer_attempt(output, config, pins, manifest, question, arm, directory / 'attempts' / f'{number:02d}', command_factory=command_factory, rpc_runner=rpc_runner)
            attempts.append(saved)
            if (stop_retry is not None and stop_retry(saved)) or saved['outcome'] != 'model-error' or number == MAX_ATTEMPTS:
                break
            time.sleep(2 ** number)
        record = dict(attempts[-1])
        record['attempts'] = [{**{key: value.get(key) for key in ('outcome', 'providerTimeout', 'toolTimeoutErrors', 'rc', 'session', 'sessionSha256', 'answerWallMs', 'tokens')},
                               'attempt': number + 1} for number, value in enumerate(attempts)]
        record['totalAttemptWallMs'] = sum(value['answerWallMs'] for value in attempts)
        record['totalAttemptTokens'] = {key: sum(value['tokens'][key] for value in attempts)
                                        if all(isinstance(value.get('tokens'), dict) and isinstance(value['tokens'].get(key), (int, float)) for value in attempts) else None
                                        for key in ('input', 'output', 'cacheRead', 'cacheWrite')}
        record['timeoutErrors'] = {'tool': sum(value['toolTimeoutErrors'] for value in attempts), 'provider': sum(value['providerTimeout'] for value in attempts)}
        record['recoveredProviderRetries'] = len(attempts) - 1 if record['outcome'] == 'answered' else 0
        return record
    record = common.durable_phase(directory, 'result', identity, operation)
    print(json.dumps({'arm': arm, 'id': question['id'], 'outcome': record['outcome'], 'attempts': len(record['attempts'])}), flush=True)
    return record


def judge_one(output, manifest, config_paths, configs, question, arm, answer, label, *, stop_retry=None, rpc_runner=None):
    directory = output / 'judge-v2' / label / arm / question['id']
    directory.mkdir(parents=True, exist_ok=True)
    identity = common.object_sha({'run': manifest['fingerprint'], 'label': label, 'arm': arm, 'id': question['id'], 'answer': common.object_sha(answer)})
    def operation():
        if answer['outcome'] != 'answered':
            return {'question_id': question['id'], 'arm': arm, 'judgeName': label, 'status': 'answer-failure', 'verdict': None, 'answerOutcome': answer['outcome'], 'attempts': []}
        prompt = judge.contract.build_prompt(question['question'], question['answer'], answer['answer'], question['question_date'])
        item = {'question_id': question['id'], 'arm': arm, 'model_answer': answer['answer'], 'prompt': prompt,
                'inputSha256': common.object_sha({'prompt': prompt}), 'originalResultSha256': common.sha(output / 'results' / arm / question['id'] / 'result.json')}
        attempts = []
        for number in range(1, MAX_ATTEMPTS + 1):
            saved = judge.judge_one(item, label, config_paths[label], configs[label]['judge'], directory / 'attempts' / f'{number:02d}',
                                    manifest['fingerprint'] + '/' + str(number), rpc_runner=rpc_runner or common.rpc.run_rpc)
            attempts.append(saved)
            if (stop_retry is not None and stop_retry(saved)) or saved['status'] != 'provider-error' or number == MAX_ATTEMPTS:
                break
            time.sleep(2 ** number)
        result = dict(attempts[-1])
        result['attempts'] = [{'attempt': number + 1, **{key: value.get(key) for key in ('status', 'failureKind', 'session', 'sessionSha256', 'seconds')}} for number, value in enumerate(attempts)]
        return result
    return common.durable_phase(directory, 'result', identity, operation)


