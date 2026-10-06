"""Offline strict and independent 1–10 reports for current fixed-snapshot runs."""
import argparse
import json
from pathlib import Path
import run as common
import prepare as preparation

contract = common.module('report_strict_contract', Path(__file__).with_name('judge-v2.py'))


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


def write_report(root):
    root = Path(root).resolve()
    manifest = json.loads((root / 'manifest.json').read_text())
    if (manifest['fingerprint'] != common.object_sha(manifest['identity']) or manifest['arms'] != [manifest['identity']['arm']]
            or common.object_sha(manifest['questions']) != manifest['identity']['questionsSha256']
            or common.object_sha(manifest['snapshots']) != manifest['identity']['snapshotsSha256']):
        raise ValueError('Report manifest identity differs')
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
        rows.append({'id': qid, 'subset': question['subset'], 'answer': answer, 'strict': strict, 'grade1to10': scores,
                     'compression': {'reused': True, 'sourceRun': manifest['identity']['snapshotSource']['run'],
                                     'sha256': manifest['snapshots']['pi/' + qid]['sha256']}})
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
    common.write_json(root / 'aggregate.json', report)
    common.write_json(root / 'FINAL.json', {'fingerprint': manifest['fingerprint'], 'state': report['state'], 'strict': strict, 'grade1to10': scores})
    lines = [f"# {report['dataset']} / {arm}", '', f"State: {report['state']}; selected questions: {len(rows)}.",
             'Accuracy and means use scored records only; failures and pending records are unscored, never zero.', '',
             '| Judge | Strict correct / scored | Strict selected / scored / failed / pending | 1–10 mean | 1–10 selected / scored / failed / pending |',
             '|---|---:|---:|---:|---:|']
    for label in preparation.LABELS:
        a, b = strict[label], scores[label]
        lines.append(f"| {label} | {a['correct']} / {a['scored']} | {a['selected']} / {a['scored']} / {a['failed']} / {a['pending']} | {b['meanScore']} | {b['selected']} / {b['scored']} / {b['failed']} / {b['pending']} |")
    (root / 'REPORT.md').write_text('\n'.join(lines) + '\n')
    if (root / 'grade-1to10').is_dir():
        common.write_json(root / 'grade-1to10/aggregate.json', {'fingerprint': manifest['fingerprint'], 'judges': scores, 'perQuestion': rows})
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    write_report(parser.parse_args().run)
