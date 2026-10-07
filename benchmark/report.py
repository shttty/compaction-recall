"""Offline strict and independent 1–10 reports for current fixed-snapshot runs."""
import argparse
import json
import statistics
from pathlib import Path
from runner import artifacts as common
from runner import prepare as preparation

contract = common.module('report_strict_contract', Path(__file__).parent / 'judging/strict.py')


def read_record(path, identity, *, score=False, answer=''):
    if not path.exists():
        return {'status': 'pending', 'verdict': None}
    record = common.durable_phase(path.parent, 'result', identity, lambda: None)
    if record.get('status') == 'graded':
        parsed = common.scorer.parse_score(record['rawVerdict']) if score else contract.parse_verdict(record['rawVerdict'], answer)
        if parsed != record['verdict']:
            raise ValueError('Raw and parsed judge verdict disagree')
    elif record.get('verdict') is not None:
        raise ValueError('Failure cannot carry a numeric/correct verdict')
    return record


def summarize(rows, score=False):
    graded = [row for row in rows if row.get('status') == 'graded']
    failures = [row for row in rows if row.get('status') not in ('graded', 'pending')]
    if score:
        scores = [row['verdict']['score'] for row in graded]
        return {'selected': len(rows), 'scored': len(graded), 'failed': len(failures), 'pending': len(rows) - len(graded) - len(failures),
                'meanScore': sum(scores) / len(scores) if scores else None,
                'atLeast8': sum(value >= 8 for value in scores), 'scores': scores}
    correct = sum(row['verdict']['correct'] is True for row in graded)
    return {'selected': len(rows), 'scored': len(graded), 'failed': len(failures), 'pending': len(rows) - len(graded) - len(failures),
            'correct': correct, 'accuracy': correct / len(graded) if graded else None}


def distribution(values):
    known = [value for value in values if type(value) in (int, float)]
    return {'count': len(known), 'median': statistics.median(known) if known else None,
            'max': max(known) if known else None}


def performance(compactions, executions, memory):
    return {
        'compactionSeconds': distribution(stage.get('seconds') for stage in compactions),
        'contextBeforeEstimatedTokens': distribution((stage.get('contextBefore') or {}).get('estimatedTokens') for stage in compactions),
        'contextAfterEstimatedTokens': distribution((stage.get('contextAfter') or {}).get('estimatedTokens') for stage in compactions),
        'byStage': {str(name): {
            'seconds': distribution(stage.get('seconds') for stage in compactions if stage.get('stage') == name),
            'contextBeforeEstimatedTokens': distribution((stage.get('contextBefore') or {}).get('estimatedTokens') for stage in compactions if stage.get('stage') == name),
            'contextAfterEstimatedTokens': distribution((stage.get('contextAfter') or {}).get('estimatedTokens') for stage in compactions if stage.get('stage') == name),
        } for name in sorted({stage.get('stage') for stage in compactions}, key=str)},
        'toolCallMilliseconds': distribution(event.get('milliseconds') for event in executions),
        'byTool': {name: distribution(event.get('milliseconds') for event in executions if event.get('name') == name)
                   for name in sorted({event.get('name') for event in executions if event.get('name')})},
        'answerPeakRssKiB': distribution(record.get('peakObservedRssKiB') for record in memory),
    }


def answer_observations(folder, answer):
    attempts = sorted(path for path in (folder / 'attempts').glob('*') if path.is_dir())
    if answer.get('session'):
        session_folder = Path(answer['session']).parent
        if session_folder not in attempts:
            attempts.append(session_folder)
    executions, memory = [], []
    for attempt in attempts:
        path = attempt / 'tool-execution.jsonl'
        if path.is_file():
            executions.extend(json.loads(line) for line in path.read_text().splitlines() if line.strip())
        path = attempt / 'process-memory.json'
        if path.is_file():
            memory.append(json.loads(path.read_text()))
    return executions, memory


def metric(value):
    if value['count'] == 0:
        return '未记录'
    return f"{value['median']:.3f} / {value['max']:.3f} / {value['count']}"


def write_report(root):
    root = Path(root).resolve()
    manifest = json.loads((root / 'manifest.json').read_text())
    if (manifest['fingerprint'] != common.object_sha(manifest['identity']) or manifest['arms'] != [manifest['identity']['arm']]
            or common.object_sha(manifest['questions']) != manifest['identity']['questionsSha256']):
        raise ValueError('Report manifest identity differs')
    preparation.verify_snapshot_bindings(manifest, root)
    preparation.verify_files(manifest['identity']['inputs'])
    preparation.verify_files(manifest['identity']['snapshotSource']['filesSha256'])
    arm = manifest['arms'][0]
    grade_path = root / 'grade-1to10/manifest.json'
    grade = json.loads(grade_path.read_text()) if grade_path.exists() else None
    grade_inputs = {}
    if grade is not None:
        if grade['fingerprint'] != common.object_sha(grade['identity']) or grade['identity']['originalFingerprint'] != manifest['fingerprint']:
            raise ValueError('Independent grade identity differs')
        grade_inputs = {item['question_id']: item for item in grade['identity']['inputs']}
    rows = []
    compactions, executions, memory = [], [], []
    for question in manifest['questions']:
        qid = question['id']
        answer_path = root / 'results' / arm / qid / 'result.json'
        if answer_path.exists():
            answer_identity = common.object_sha({'run': manifest['fingerprint'], 'tools': manifest['toolEvidence'][arm]['sha256'], 'arm': arm, 'id': qid})
            answer = common.durable_phase(answer_path.parent, 'result', answer_identity, lambda: None)
        else:
            answer = {'outcome': 'pending', 'answer': ''}
        strict = {label: read_record(root / 'judge-v2' / label / arm / qid / 'result.json',
            common.object_sha({'run': manifest['fingerprint'], 'label': label, 'arm': arm, 'id': qid, 'answer': common.object_sha(answer)}),
            answer=answer['answer']) for label in preparation.LABELS}
        scores = {label: {'status': 'pending', 'verdict': None} for label in preparation.LABELS}
        if grade is not None:
            item = grade_inputs[qid]
            if item['originalResultSha256'] != common.sha(answer_path):
                raise ValueError('Independent grade answer binding differs')
            scores = {label: read_record(root / 'grade-1to10/results' / label / qid / 'result.json',
                common.object_sha({'run': grade['fingerprint'], 'judgeName': label, 'arm': arm,
                                   'question_id': qid, 'inputSha256': item['inputSha256']}), score=True)
                for label in preparation.LABELS}
        compression_path = root / 'compression' / qid / 'snapshot.json'
        if compression_path.is_file():
            compression = json.loads(compression_path.read_text())
        else:
            compression = {'reused': True, 'sourceRun': manifest['identity']['snapshotSource']['run'],
                           'sha256': manifest['snapshots'].get('pi/' + qid, {}).get('sha256')}
        stages = compression.get('compactions', [])
        calls, samples = answer_observations(answer_path.parent, answer)
        compactions.extend(stages)
        executions.extend(calls)
        memory.extend(samples)
        rows.append({'id': qid, 'subset': question['subset'], 'answer': answer, 'strict': strict, 'grade1to10': scores,
                     'compression': compression, 'performance': performance(stages, calls, samples)})
    strict = {label: summarize([row['strict'][label] for row in rows]) for label in preparation.LABELS}
    scores = {label: summarize([row['grade1to10'][label] for row in rows], True) for label in preparation.LABELS}
    report = {'fingerprint': manifest['fingerprint'], 'dataset': manifest['identity']['dataset'], 'arm': arm,
              'state': grade['state'] if grade is not None else manifest['state'], 'answerStrictState': manifest['state'],
              'selected': manifest['selected'], 'judges': strict, 'grade1to10': scores,
              'answerOutcomes': {outcome: sum(row['answer']['outcome'] == outcome for row in rows) for outcome in sorted({row['answer']['outcome'] for row in rows})},
              'perQuestion': rows, 'subsets': {subset: {
                  'strict': {label: summarize([row['strict'][label] for row in rows if row['subset'] == subset]) for label in preparation.LABELS},
                  'grade1to10': {label: summarize([row['grade1to10'][label] for row in rows if row['subset'] == subset], True) for label in preparation.LABELS}}
                  for subset in sorted({row['subset'] for row in rows})}}
    report['performance'] = performance(compactions, executions, memory)
    common.write_json(root / 'aggregate.json', report)
    common.write_json(root / 'FINAL.json', {'fingerprint': manifest['fingerprint'], 'state': report['state'], 'strict': strict, 'grade1to10': scores})
    lines = [f"# {report['dataset']} / {arm}", '', f"State: {report['state']}; selected questions: {len(rows)}.",
             'Accuracy and means use scored records only; failures and pending records are unscored, never zero.', '',
             '| Judge | Strict correct / scored | Strict selected / scored / failed / pending | 1–10 mean | 1–10 selected / scored / failed / pending |',
             '|---|---:|---:|---:|---:|']
    for label in preparation.LABELS:
        a, b = strict[label], scores[label]
        lines.append(f"| {label} | {a['correct']} / {a['scored']} | {a['selected']} / {a['scored']} / {a['failed']} / {a['pending']} | {b['meanScore']} | {b['selected']} / {b['scored']} / {b['failed']} / {b['pending']} |")
    observed = report['performance']
    lines.extend(['', '## Recorded performance', '',
                  'Cells show median / max / count of recorded observations; 未记录 means absent, not zero.',
                  'Compaction token values are estimates; tool timings include all recorded answer attempts.', '',
                  '| Metric | Median / max / count |', '|---|---:|'])
    for name in ('compactionSeconds', 'contextBeforeEstimatedTokens', 'contextAfterEstimatedTokens',
                 'toolCallMilliseconds', 'answerPeakRssKiB'):
        lines.append(f"| {name} | {metric(observed[name])} |")
    if observed['byStage']:
        lines.extend(['', '| Compression stage | Seconds | Context before (estimated tokens) | Context after (estimated tokens) |',
                      '|---|---:|---:|---:|'])
        for stage, values in observed['byStage'].items():
            lines.append(f"| {stage} | {metric(values['seconds'])} | {metric(values['contextBeforeEstimatedTokens'])} | {metric(values['contextAfterEstimatedTokens'])} |")
    if observed['byTool']:
        lines.extend(['', '| Tool | Milliseconds (median / max / count) |', '|---|---:|'])
        for name, values in observed['byTool'].items():
            lines.append(f"| {name} | {metric(values)} |")
    (root / 'REPORT.md').write_text('\n'.join(lines) + '\n')
    if (root / 'grade-1to10').is_dir():
        common.write_json(root / 'grade-1to10/aggregate.json', {'fingerprint': manifest['fingerprint'], 'judges': scores, 'perQuestion': rows})
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    write_report(parser.parse_args().run)
