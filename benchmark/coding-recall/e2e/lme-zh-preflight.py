"""Read-only LME16 Chinese audit. No SDK loading, compression or provider calls."""
import argparse
import hashlib
import json
from pathlib import Path

import run as common

HERE = Path(__file__).resolve().parent
lme = common.module('zh_preflight_ids', HERE / 'lme-run.py')


def load_case(root, key, language='zh'):
    """Keep compressor/solver projection separate from judge-only reference data."""
    directory = root / 'data' / key
    names = ('question.json', 'corpus.json', 'answer.json', 'judge.json') if language == 'en' else ('question-zh.json', 'question.json', 'corpus-zh.json', 'corpus.json', 'answer.json')
    paths = {name: directory / name for name in names}
    data, hashes = {}, {}
    for name, path in paths.items():
        raw = path.read_bytes()
        data[name] = json.loads(raw)
        hashes[str(path)] = hashlib.sha256(raw).hexdigest()
    if language == 'en':
        question, original = data['question.json'], data['corpus.json']
        qid = key.split('/')[1]
        if question['question_id'] != qid or data['answer.json']['question_id'] != qid:
            raise ValueError('English question/reference ID mismatch: ' + key)
        solver = common.e.serializable_question({**original, 'question_id': qid, 'question_type': question.get('question_type'),
                   'question': question['question'], 'question_date': question['question_date']})
        judge = {'id': qid, 'question': question['question'], 'question_date': question['question_date'],
                 'answer': data['answer.json']['answer'], 'language': 'en', 'subset': key.split('/')[0]}
        return solver, judge, hashes
    question, english = data['question-zh.json'], data['question.json']
    translated, original = data['corpus-zh.json'], data['corpus.json']
    qid = key.split('/')[1]
    if question['question_id'] != qid or english['question_id'] != qid or data['answer.json']['question_id'] != qid:
        raise ValueError('Question/reference ID mismatch: ' + key)
    if not question['question'] or question['question_date'] != english['question_date']:
        raise ValueError('Missing Chinese question or changed date: ' + key)
    if translated['haystack_dates'] != original['haystack_dates'] or len(translated['haystack_sessions']) != len(original['haystack_sessions']):
        raise ValueError('Chinese session/date alignment changed: ' + key)
    for zh, en in zip(translated['haystack_sessions'], original['haystack_sessions']):
        if len(zh) != len(en) or any(a['role'] != b['role'] for a, b in zip(zh, en)):
            raise ValueError('Chinese turn/role alignment changed: ' + key)
        if any(turn['role'] not in ('user', 'assistant') or not isinstance(turn['content'], str) for turn in zh):
            raise ValueError('Unsupported Chinese turn: ' + key)
    if len(translated['haystack_dates']) != len(translated['haystack_sessions']):
        raise ValueError('Chinese dates do not cover sessions: ' + key)
    solver = common.e.serializable_question({**translated, 'question_id': qid,
               'question_type': english.get('question_type'), 'question': question['question'],
               'question_date': question['question_date']})
    judge = {'id': qid, 'question': question['question'], 'question_date': question['question_date'],
             'answer': data['answer.json']['answer'], 'language': 'zh', 'subset': key.split('/')[0]}
    return solver, judge, hashes


def snapshot_info(path):
    # Physical LF only: U+2028/U+2029 are legal characters inside JSON strings.
    with path.open('rb') as stream:
        compactions = [row for line in stream if (row := json.loads(line)).get('type') == 'compaction']
    simulated = any('blind-simulated' in row.get('id', '') for row in compactions)
    native_shape = len(compactions) == 3 and not simulated and all(row.get('summary') for row in compactions)
    return {'path': str(path), 'sha256': common.sha(path), 'compactions': len(compactions),
            'emptySummaries': sum(not row.get('summary') for row in compactions),
            'simulated': simulated, 'nativeShape': bool(native_shape)}


def audit(args):
    index_path, gold_path = args.data_root / 'data/index.json', args.data_root / 'gold.json'
    index, gold = json.loads(index_path.read_text()), json.loads(gold_path.read_text())['gold']
    expected = [('dev8', qid) for qid in lme.DEV] + [('hard8', qid) for qid in lme.HARD]
    if [(row['split'], row['question_id']) for row in index['questions']] != expected:
        raise ValueError('Chinese selection differs from frozen DEV8/harder8 IDs/order')
    selected = [split + '/' + qid for split, qid in expected]
    if set(gold) != set(selected):
        raise ValueError('Gold does not cover exact Chinese selection')
    inputs = {str(path): common.sha(path) for path in (index_path, gold_path)}
    cases = []
    for key in selected:
        solver, judge, hashes = load_case(args.data_root, key)
        inputs.update(hashes)
        turns = [turn for session in solver['haystack_sessions'] for turn in session]
        if not gold[key] or not judge['answer']:
            raise ValueError('Missing gold/reference: ' + key)
        for location in gold[key]:
            turn = solver['haystack_sessions'][location['session']][location['turn']]
            if turn['role'] != location['role'] or not turn['content']:
                raise ValueError('Gold location/role missing: ' + key)
        cases.append({'key': key, 'sessions': len(solver['haystack_sessions']), 'turns': len(turns),
                      'goldTurns': len(gold[key]), 'turnsWithHan': sum(any('\u3400' <= c <= '\u9fff' for c in turn['content']) for turn in turns),
                      'solverSha256': common.e.object_sha(solver), 'referenceSha256': common.e.object_sha(judge)})
    old_cases_path = args.s5_run / 'cases.json'
    old_cases = [row for row in json.loads(old_cases_path.read_text()) if row['language'] == 'zh']
    if len(old_cases) != 16 or {row['key'] for row in old_cases} != set(selected):
        raise ValueError('Historical Chinese case set differs')
    inputs[str(old_cases_path)] = common.sha(old_cases_path)
    archived, historical_answers = [], []
    for case in old_cases:
        info = snapshot_info(Path(case['snapshot']))
        info['key'] = case['key']
        archived.append(info)
        answer_path = Path(case['directory']) / 'answer.json'
        answer = json.loads(answer_path.read_text())
        historical_answers.append({'key': case['key'], 'outcome': answer['outcome'], 'path': str(answer_path), 'sha256': common.sha(answer_path)})
    previous_path = args.previous / 'manifest.json'
    previous = json.loads(previous_path.read_text())
    if len(previous['questions']) != 16 or {row['id'] for row in previous['questions']} != set(lme.DEV + lme.HARD) or any(row['language'] != 'en' for row in previous['questions']):
        raise ValueError('Expected exact previous English LME16 provenance, not a Chinese snapshot source')
    inputs[str(previous_path)] = common.sha(previous_path)
    native = []
    for key, record in previous['snapshots'].items():
        info = snapshot_info(Path(record['path']))
        if info['sha256'] != record['sha256']:
            raise ValueError('Previous snapshot bytes changed')
        qid = key.split('/')[1]
        language = next(row['language'] for row in previous['questions'] if row['id'] == qid)
        native.append({**info, 'key': key, 'language': language, 'reusableForChinese': False})
    descriptor = lambda phase: {key: phase[key] for key in ('provider', 'model', 'effort')}
    models = {phase: descriptor(previous['identity']['config'][phase]) for phase in ('compression', 'answer')}
    models['judges'] = {label: descriptor(config['judge']) for label, config in previous['identity']['judgeConfigs'].items()}
    sources = {str(path): common.sha(path) for path in (Path(__file__), HERE / 'lme-run.py', HERE / 'run.py',
               HERE / 'round2-run.py', HERE / 'judge-v2.py', common.ROOT / 'benchmark/evaluate.py')}
    identity = {'task': 'RSM-ZH16-RAWFTS-PREFLIGHT-20261005', 'selected': selected, 'inputs': inputs,
                'archiveSnapshots': archived, 'previousSnapshots': native, 'historicalAnswers': historical_answers,
                'models': models, 'sources': sources}
    result = {'state': 'offline-prepared-awaiting-candidate-and-native-zh-snapshots',
              'fingerprint': common.e.object_sha(identity), 'identity': identity, 'cases': cases,
              'providerCalls': 0, 'candidateRead': False, 'profileRead': False,
              'candidate': None, 'validatedNativeChineseSnapshots': 0,
              'historicalChineseBaselineReusable': False,
              'blockers': ['Hermes independently verified immutable candidate/closure/configuration',
                           '16 Chinese native snapshots: historical S5 fixtures are simulated; prior native snapshots are English'],
              'plannedExecution': {'host': 'pi', 'arms': 1, 'pilotCountsInTotal': True, 'answerSessions': 16,
                                  'judgeSessions': 32, 'compressionCallsIfNoReusableSnapshots': 48,
                                  'maxConcurrentSessions': 16, 'maxProviderAttempts': 3,
                                  'toolErrorsDoNotTriggerHarnessRetry': True}}
    args.output.mkdir(parents=True, exist_ok=True)
    path = args.output / 'manifest.json'
    if path.exists() and json.loads(path.read_text()) != result:
        raise ValueError('Preflight inputs/evidence/code changed; use a new output directory')
    if not path.exists():
        common.write_json(path, result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('data-root', 's5-run', 'previous', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    result = audit(parser.parse_args())
    print(json.dumps({'state': result['state'], 'cases': len(result['cases']), 'providerCalls': 0}, ensure_ascii=False))
