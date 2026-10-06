"""Actual SDK judge transcript, effort, and verdict validation."""
import json
from pathlib import Path
import time
from runner import artifacts as common
HERE = Path(__file__).resolve().parent
contract = common.module('strict_judge_contract', HERE / 'strict.py')

def judge_one(item, label, config_path, selected, directory, fingerprint, *, rpc_runner=None, verdict_parser=None):
    directory.mkdir(parents=True, exist_ok=True)
    identity = common.object_sha({'run': fingerprint, 'judgeName': label, 'arm': item['arm'], 'question_id': item['question_id'], 'inputSha256': item['inputSha256']})
    def operation():
        session = directory / 'judge-session.jsonl'
        record = {key: item[key] for key in ('arm', 'question_id', 'inputSha256', 'originalResultSha256')}
        record.update(judgeName=label, status='provider-error', verdict=None, rawVerdict='', failureKind=None)
        start = time.monotonic()
        stage = 'provider'
        try:
            command = ['node', str(HERE.parent / 'sdk/judge.mjs'), '--config', str(config_path), '--phase', 'judge', '--session', str(session)]
            observed = (rpc_runner or common.rpc.run_rpc)(command, common.child_env(), directory, prompt=item['prompt'], timeout=900)
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
            record['effortEvidence'] = {'path': str(effort_path), 'sha256': common.sha(effort_path), **serialized}
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
            record.update(session=str(session), sessionSha256=common.sha(session))
        return record
    saved = common.durable_phase(directory, 'result', identity, operation)
    print(json.dumps({'judge': label, 'arm': item['arm'], 'id': item['question_id'], 'status': saved['status'],
                      'correct': (saved.get('verdict') or {}).get('correct'), 'guess': (saved.get('verdict') or {}).get('guess'),
                      'hedged': (saved.get('verdict') or {}).get('hedged')}), flush=True)
    return saved
