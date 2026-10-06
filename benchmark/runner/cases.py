"""Question pipelines and validation of persisted answer/strict completion evidence."""
import json
from pathlib import Path
from runner import artifacts as common
from runner import phases, prepare as preparation, sdk


def execute(resources, config, pins, paths, configs, question):
    output, manifest, arm = resources.output, resources.manifest, resources.arm
    qid = question['id']
    if not resources.enter_question(qid):
        return
    soft_english = manifest['identity'].get('budgetPolicy', {}).get('answerEstimate') == 'diagnostic-only'
    try:
        entry = manifest['snapshots']['pi/' + qid]
        session = Path(entry['path'])
        preparation.verify_files({str(session): entry['sha256']}, 'Native snapshot')
        budget = sdk.context_budget(config, manifest, session, 'answer', output / 'results' / arm / qid)
        if budget['estimatedTokens'] > budget['ceiling']:
            if not soft_english:
                raise ValueError('Answer SDK estimate exceeds context ceiling')
            common.write_json(output / 'results' / arm / qid / 'answer-estimate-warning.json', {**budget, 'action': 'diagnostic-only', 'actualRequestParameters': 'unchanged'})
            print('ANSWER_ESTIMATE_WARNING ' + json.dumps({'id': qid, **budget}), flush=True)
        snapshot_sha = manifest['snapshots']['pi/' + qid]['sha256']
        def checked_command(*values, **options):
            preparation.verify_files({str(session): snapshot_sha, str(values[5]): snapshot_sha}, 'Answer clone/source bytes')
            return sdk.answer_command(*values, **options)
        preparation.verify_files({str(session): snapshot_sha}, 'Native snapshot')
        answer = phases.answer_one(output, config, pins, manifest, question, arm, command_factory=checked_command,
                               stop_retry=resources.stop_capacity_retry if soft_english else None, rpc_runner=resources.measured_rpc)
        preparation.verify_files({str(session): manifest['snapshots']['pi/' + qid]['sha256']}, 'Native snapshot')
        if answer['outcome'] == 'answered':
            wire = Path(answer['session']).parent / 'wire-requests.jsonl'
            rows = [json.loads(line) for line in wire.read_text().split('\n') if line]
            if not rows or any(row['effort'] != config['answer']['effort'] for row in rows):
                raise ValueError('Answer wire evidence missing or changed')
        resources.persist()
        judged = {}
        for label in ('luna', 'sol'):
            if resources.capacity_stop.is_set() and answer['outcome'] == 'answered': break
            judged[label] = phases.judge_one(output, manifest, paths, configs, question, arm, answer, label,
                                       stop_retry=resources.stop_capacity_retry if soft_english else None, rpc_runner=resources.measured_rpc)
            resources.persist()
        failed = {label: row['status'] for label, row in judged.items() if row['status'] != 'graded'}
        with resources.lock:
            if answer['outcome'] != 'answered':
                manifest['failures'][qid] = {'phase': 'answer', 'status': answer['outcome']}
            elif failed:
                manifest['failures'][qid] = {'phase': 'strict', 'judges': failed}
            elif len(judged) == 2 and qid not in manifest['completed']:
                manifest['completed'].append(qid)
        resources.persist()
    except Exception as error:
        with resources.lock:
            manifest['failures'][qid] = {'kind': type(error).__name__, 'message': 'Native case pipeline failed; see persisted phase evidence'}
        resources.persist()
        print(json.dumps({'event': 'case-failure', 'id': qid, 'kind': type(error).__name__}), flush=True)
    finally:
        resources.leave_question()


def validate_cached_results(output, config, pins, manifest, configs, paths):
    arm = manifest['arms'][0]
    def reject_replay(*values, **options):
        raise ValueError('Completed phase refuses provider replay')
    for question in manifest['questions']:
        qid = question['id']
        if qid not in manifest['completed']:
            if manifest['state'] != 'complete' or qid in manifest['failures']:
                continue
            raise ValueError('Completed run lacks terminal question coverage')
        if not (output / 'results' / arm / qid / 'result.json').is_file():
            raise ValueError('Completed answer result missing')
        answer = phases.answer_one(output, config, pins, manifest, question, arm, command_factory=sdk.answer_command, rpc_runner=reject_replay)
        for label in ('luna', 'sol'):
            if not (output / 'judge-v2' / label / arm / qid / 'result.json').is_file():
                raise ValueError('Completed strict result missing')
            phases.judge_one(output, manifest, paths, configs, question, arm, answer, label, rpc_runner=reject_replay)
