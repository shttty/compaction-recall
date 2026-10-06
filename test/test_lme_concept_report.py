"""Shared candidate reports: source costs, partial denominators and real tool-event order."""
import importlib.util
import json
from pathlib import Path
import sys
import threading
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1] / 'benchmark/coding-recall/e2e'

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

report = module('concept_report', 'lme-grade-report.py')
native = report.old_report
with patch.dict(sys.modules, {'run': report.common}):
    runner = module('concept_grader', 'lme-grade-run.py')
ARM = 'pi-concepts'


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False) + '\n')
    return path


def fixture(base, failure=False, arm=ARM, english=False):
    ARM = arm
    source, current = base / 'source', base / 'concepts'
    source.mkdir(); current.mkdir()
    ids = [f'q{i:02d}' for i in range(16)]
    questions, inputs, snapshots = [], {}, {}
    tokens = {'input': 7, 'output': 2, 'cacheRead': 1, 'cacheWrite': 0}
    for index, qid in enumerate(ids):
        subset = 'dev8' if index < 8 else 'hard8'
        question = {'id': qid, 'subset': subset, 'question': ('Question ' if english else '问题') + qid,
                    'answer': '参考' + qid, 'question_date': '2026-01-01'}
        questions.append(question)
        sources = [('question.json', {'question': 'Question ' + qid}), ('answer.json', {'answer': question['answer']})]
        if not english:
            sources.append(('question-zh.json', {'question': question['question'], 'question_en': 'Question ' + qid}))
        for name, value in sources:
            path = save(base / 'data' / subset / qid / name, value)
            inputs[str(path)] = report.sha(path)
        build = {'state': 'complete', 'compactions': [{'success': True, 'seconds': 3,
                 'response': {'data': {'usage': tokens}}}] * 3}
        folder = source / 'compression/pi' / qid
        snapshot = save(folder / 'session.jsonl', {'syntheticSnapshot': qid})
        save(folder / 'progress.json', build)
        for stage in ('01', '02', '03'):
            attempt = folder / 'stages' / stage / 'attempts/01'
            save(attempt / 'result.json', build['compactions'][0])
            save(attempt / 'wire-requests.jsonl', {'phase': 'compression'})
            save(attempt / 'wire-results.jsonl', {'phase': 'compression', 'usage': tokens})
        snapshots['pi/' + qid] = {'path': str(snapshot), 'sha256': report.sha(snapshot), 'language': 'en' if english else 'zh', 'build': build}
    old_identity = {'dataset': 'LME16-English' if english else 'LME16-Chinese', 'inputs': inputs}
    old_fingerprint = report.common.e.object_sha(old_identity)
    old_manifest = save(source / 'manifest.json', {'identity': old_identity, 'fingerprint': old_fingerprint,
        'arms': ['pi-rawfts'], 'selected': ids, 'questions': questions, 'snapshots': snapshots, 'state': 'complete'})
    source_files = {**inputs, str(old_manifest): report.sha(old_manifest)}
    source_files.update({s['path']: s['sha256'] for s in snapshots.values()})
    binding = {'run': str(source), 'fingerprint': old_fingerprint, 'manifestPath': str(old_manifest),
               'manifestSha256': report.sha(old_manifest), 'filesSha256': source_files,
               'snapshots': {key: {k: s[k] for k in ('path', 'sha256')} for key, s in snapshots.items()}}
    identity = {'task': 'RSM-LME16-CURRENT-THREE-ARMS-20261006' if arm in native.CURRENT_ARMS else 'RSM-ZH16-RESTORED-GREP-E2E-20261006' if ARM == 'pi-restored-grep' else 'RSM-ZH16-CONCEPT-E2E-20261005', 'arm': ARM, 'dataset': old_identity['dataset'],
                'inputs': inputs, 'snapshotSource': binding, 'resourcePolicy': {'maxConcurrentSessions': 8,
                    'authorizedSessionCeiling': 8, 'wholeRunMemoryMaxBytes': 14 * 1024 ** 3,
                    'wholeRunMemorySwapMaxBytes': 0}}
    fingerprint = report.common.e.object_sha(identity)
    reused = {key: dict(s, reused=True, sourceRun=str(source), sourceFingerprint=old_fingerprint) for key, s in snapshots.items()}
    save(current / 'manifest.json', {'identity': identity, 'fingerprint': fingerprint, 'arms': [ARM],
        'selected': ids, 'questions': questions, 'snapshots': reused, 'state': 'complete'})
    for question in questions:
        qid = question['id']; failed = failure and qid == ids[-1]
        directory = current / 'results' / ARM / qid
        session = directory / 'session.jsonl'; directory.mkdir(parents=True)
        answer_text = '' if failed else '答案' + qid
        session.write_text(''.join(json.dumps({'message': message}, ensure_ascii=False) + '\n' for message in
            ({'role': 'user', 'content': question['question']}, {'role': 'assistant', 'content': [{'type': 'text', 'text': answer_text}], 'usage': tokens})))
        answer = {'arm': ARM, 'question_id': qid, 'outcome': 'model-error' if failed else 'answered',
            'answer': answer_text, 'session': str(session), 'sessionSha256': report.sha(session),
            'answerWallMs': 1000, 'tokens': tokens, 'modelCalls': 1, 'attempts': [{'attempt': 1, 'outcome': 'model-error' if failed else 'answered'}]}
        save(directory / 'attempts/01/answer.json', {k: v for k, v in answer.items() if k != 'attempts'})
        result = save(directory / 'result.json', answer)
        save(directory / 'attempts/01/context-0001.json', {'source': 'before_provider_request',
            'nativeLocators': [{'content': 'synthetic locator'}], 'serializedLocatorCount': 1})
        for label in report.JUDGES:
            verdict = None if failed else {'correct': label == 'sol', 'final_answer': answer_text,
                'guess': False, 'hedged': False, 'reason': '独立严格判分'}
            strict = {'arm': ARM, 'question_id': qid, 'judgeName': label, 'verdict': verdict,
                'status': 'answer-failure' if failed else 'graded', 'attempts': [],
                'rawVerdict': None if failed else json.dumps(verdict, ensure_ascii=False),
                'identity': report.common.e.object_sha({'run': fingerprint, 'label': label, 'arm': ARM, 'id': qid,
                                                      'answer': report.common.e.object_sha(answer)})}
            if not failed:
                prompt = report.strict.build_prompt(question['question'], question['answer'], answer_text, question['question_date'])
                strict.update(inputSha256=report.common.e.object_sha({'prompt': prompt}), originalResultSha256=report.sha(result))
            save(current / 'judge-v2' / label / ARM / qid / 'result.json', strict)
    for label, model, effort in (('luna', 'gpt-6-luna', 'xhigh'), ('sol', 'gpt-6.1-sol', 'medium')):
        save(current / 'judge-v2' / (label + '-config.json'), {'judge': {'provider': 'clp', 'model': model,
            'effort': effort, 'profile': str(base / 'forbidden-profile')}})
    native.write_report(current)
    for name in ('FINAL.json', 'answer-ledger.json', 'resource.json'):
        save(current / name, {'state': 'complete', 'questionWorkers': 8, 'workers': 8,
            'maxConcurrentSessions': 8, 'peakActiveRpcSessions': 6, 'peakActiveQuestions': 5,
            'activeRpcSessions': 0, 'activeQuestions': 0, 'memoryMaxBytes': 14 * 1024 ** 3,
            'swapMaxBytes': 0, 'memoryPeakBytes': 12345})
    scope = base / 'scope'; scope.mkdir(); (scope / 'memory.peak').write_text('12345')
    return current, source, scope


def boundary(command, env, directory, prompt, **kwargs):
    folder = Path(directory)
    selected = json.loads(Path(command[command.index('--config') + 1]).read_text())['judge']
    session = Path(command[command.index('--session') + 1])
    verdict = {'score': 9, 'reason': '细分不等于严格正确'}
    session.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in (
        {'type': 'thinking_level_change', 'thinkingLevel': selected['effort']},
        {'message': {'role': 'user', 'content': [{'type': 'text', 'text': prompt}]}},
        {'message': {'role': 'assistant', 'provider': selected['provider'], 'model': selected['model'],
         'stopReason': 'stop', 'content': [{'type': 'text', 'text': json.dumps(verdict, ensure_ascii=False)}],
         'usage': {'input': 11, 'output': 3, 'cacheRead': 1, 'cacheWrite': 0}}})))
    save(folder / 'effort-evidence.json', {'effort': selected['effort'], 'source': 'onPayload'})
    return {'outcome': 'completed', 'rc': 0, 'timing': {}, 'memory': {'peakObservedRssKiB': 12}}


class ConceptReportTest(unittest.TestCase):

    def test_current_arms_reuse_english_and_keep_independent_score_denominators(self):
        for arm in native.CURRENT_ARMS:
            with self.subTest(arm=arm), tempfile.TemporaryDirectory() as tmp:
                current, source, scope = fixture(Path(tmp), failure=True, arm=arm, english=True)
                with self.assertRaisesRegex(ValueError, 'eight'):
                    runner.prepare(current, workers=7)
                output, manifest, items, configs, judges = runner.prepare(current, workers=8)
                runner.grade_one(items[0], 'luna', configs['luna'], judges['luna'], output, manifest['fingerprint'], boundary)
                runner.grade_one(items[-1], 'luna', configs['luna'], judges['luna'], output, manifest['fingerprint'],
                                 lambda *a, **k: self.fail('Failed answer invoked provider'))
                data = report.load_report(output)
                self.assertEqual(data['arm'], arm)
                self.assertEqual(items[0]['question_zh'], '')
                self.assertEqual(data['scores']['luna']['total']['mean'], 9)
                self.assertEqual(data['scores']['luna']['total']['missing'], 14)
                self.assertEqual(data['scores']['luna']['total']['failed'], 1)
                self.assertEqual(data['strict']['luna']['total']['correct'], 0)
                self.assertIsNone(data['scores']['sol']['total']['mean'])
                self.assertEqual(data['resources']['phases']['SOURCE historical compression']['calls']['sum'], 48)
                snapshot = Path(next(iter(runner.read_json(current / 'manifest.json')['snapshots'].values()))['path'])
                snapshot.write_text('changed')
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    native.load_report(current)

    def test_capacity_stops_scheduling_without_retry_and_preserves_inflight_scores(self):
        with tempfile.TemporaryDirectory() as tmp:
            current, source, scope = fixture(Path(tmp), arm='pi-full', english=True)
            barrier = threading.Barrier(8)
            blocked = threading.Event()
            calls = []
            grade_one = runner.grade_one
            def grade(*args, **kwargs):
                args = list(args)
                stop = args[-1]
                def capacity_stop(*details):
                    stop(*details)
                    blocked.set()
                args[-1] = capacity_stop
                return grade_one(*args, **kwargs)
            def rpc(command, env, directory, prompt, **kwargs):
                qid = Path(directory).parents[1].name
                calls.append(qid)
                barrier.wait(timeout=10)
                observed = boundary(command, env, directory, prompt, **kwargs)
                if qid == 'q00':
                    session = Path(command[command.index('--session') + 1])
                    rows = [json.loads(line) for line in session.read_text().splitlines()]
                    rows[-1]['message'].update(stopReason='error', errorMessage='maximum context length exceeded')
                    session.write_text(''.join(json.dumps(row) + '\n' for row in rows))
                else:
                    if not blocked.wait(10):
                        raise AssertionError('Capacity error was not observed')
                return observed
            with patch.object(runner, 'grade_one', grade), patch.object(runner.time, 'sleep', side_effect=AssertionError('Capacity retried')):
                manifest = runner.run(current, workers=8, scope=scope, rpc_runner=rpc, descriptor=lambda config, expected: expected)
            self.assertEqual(manifest['state'], 'capacity-blocked')
            self.assertEqual(sorted(calls), [f'q{i:02d}' for i in range(8)])
            data = report.load_report(current / 'grade-1to10')
            self.assertEqual(data['state'], 'capacity-blocked')
            self.assertEqual(data['scores']['luna']['total']['scored'], 7)
            self.assertEqual(data['scores']['luna']['total']['failed'], 1)
            self.assertEqual(data['scores']['luna']['total']['missing'], 8)
            self.assertEqual(data['scores']['luna']['total']['totalScore'], 63)
            self.assertIsNone(data['scores']['sol']['total']['totalScore'])
            resumed = runner.run(current, workers=8, scope=scope,
                                 rpc_runner=lambda *a, **k: self.fail('Blocked resume invoked provider'),
                                 descriptor=lambda *a: self.fail('Blocked resume described provider'))
            self.assertEqual(resumed['state'], 'capacity-blocked')

    def test_ordinary_provider_errors_keep_three_attempt_retry_policy(self):
        with tempfile.TemporaryDirectory() as tmp:
            current, source, scope = fixture(Path(tmp), arm='pi-lite', english=True)
            output, manifest, items, configs, judges = runner.prepare(current, workers=8)
            calls = []
            def rpc(command, env, directory, prompt, **kwargs):
                calls.append(directory)
                return {'outcome': 'process-error', 'rc': 1, 'timing': {}}
            with patch.object(runner.time, 'sleep') as sleep:
                result = runner.grade_one(items[0], 'luna', configs['luna'], judges['luna'], output, manifest['fingerprint'], rpc)
            self.assertEqual(len(calls), 3)
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [2, 4])
            self.assertEqual(result['status'], 'provider-error')
            self.assertIsNone(result['verdict'])

    def test_terminal_failed_answer_no_rpc_and_valid_missing_failure_denominators(self):
        with tempfile.TemporaryDirectory() as tmp:
            current, source, scope = fixture(Path(tmp), failure=True)
            with self.assertRaisesRegex(ValueError, 'eight'):
                runner.prepare(current)
            output, manifest, items, configs, judges = runner.prepare(current, workers=8)
            failed = items[-1]
            for label in report.JUDGES:
                saved = runner.grade_one(failed, label, configs[label], judges[label], output, manifest['fingerprint'],
                    lambda *a, **k: self.fail('Failed answer invoked judge'))
                self.assertEqual(saved['status'], 'answer-failure-not-scored')
                self.assertIsNone(saved['verdict'])
            runner.grade_one(items[0], 'luna', configs['luna'], judges['luna'], output, manifest['fingerprint'], boundary)
            data = report.write_report(output)
            summary = data['scores']['luna']['total']
            self.assertEqual((summary['selected'], summary['scored'], summary['failed'], summary['missing']), (16, 1, 1, 14))
            self.assertEqual((summary['totalScore'], summary['effectiveMax'], summary['mean']), (9, 10, 9))
            self.assertEqual(data['strict']['luna']['total']['accuracyDenominator'], 15)
            self.assertEqual(summary['failureKinds']['answer-failure-not-scored'], 1)
            self.assertEqual(data['resources']['newCompressionCalls'], 0)
            self.assertEqual(data['resources']['phases']['SOURCE historical compression']['calls']['sum'], 48)
            self.assertEqual(data['resources']['phases']['SOURCE historical compression']['taskSeconds']['sum'], 144)
            resource_path = current / 'resource.json'
            resource = runner.read_json(resource_path)
            for key, invalid in (('workers', 7), ('peakActiveRpcSessions', 9), ('memoryMaxBytes', 13 * 1024 ** 3), ('swapMaxBytes', 1)):
                with self.subTest(resource=key):
                    save(resource_path, dict(resource, **{key: invalid}))
                    with self.assertRaisesRegex(ValueError, 'ceiling'):
                        native.load_report(current)
            save(resource_path, resource)
            self.assertIsNone(data['scores']['sol']['total']['mean'])
            counts = report.quality([{'status': s, 'verdict': None} for s in ('judge-error', 'provider-error', 'missing')], True)
            self.assertEqual((counts['failed'], counts['missing']), (2, 1))
            self.assertEqual(counts['failureKinds']['judge-error'], 1)
            self.assertIsNone(counts['totalScore'])
            bad = runner.read_json(current / 'manifest.json'); bad['arms'] = ['pi-other']; save(current / 'manifest.json', bad)
            with self.assertRaises(ValueError): native.load_report(current)

    def test_structured_raw_fields_warning_order_and_parameter_changes(self):
        first = {'concepts': ['GPU', '显存'], 'match': 'all', 'exclude': ['低端']}
        next_args = {'concepts': ['GPU', '显存'], 'match': 'any', 'exclude': []}
        call = lambda cid, args: {'role': 'assistant', 'content': [{'type': 'toolCall', 'id': cid, 'name': 'history_recall', 'arguments': args}]}
        warning = {'role': 'toolResult', 'toolCallId': 'first', 'toolName': 'history_recall', 'isError': False,
                   'arguments': first, 'details': {'total': 0}, 'content': 'warning: zero'}
        messages = [call('first', first), call('queued', first), warning, call('next', next_args)]
        value = native.retrieval({'outcome': 'answered', 'toolResults': [warning]}, messages, {'zeroWarningPrefixes': ['warning: zero']})
        observed = value['diagnostics'][0]
        self.assertEqual((observed['rawConcepts'], observed['rawMatch'], observed['rawExclude']), (first['concepts'], 'all', ['低端']))
        self.assertEqual(observed['nextCall']['id'], 'next')
        self.assertFalse(observed['modelConceptsChanged'])
        self.assertTrue(observed['modelMatchChanged']); self.assertTrue(observed['modelExcludeChanged'])
        self.assertEqual(observed['nextAction'], 'changes-concept-parameters')
        self.assertIsNone(observed['harnessArgumentRewrite'])
        self.assertIsNone(observed['modelQueryChanged'])
        error = dict(warning, isError=True, content='TOKENIZATION_LOSS')
        grep = call('regex', {'pattern': r'GPU.*显存'})
        grep['content'][0]['name'] = 'history_grep'
        value = native.retrieval({'toolResults': [error]}, [call('first', first), error, grep], {})
        self.assertEqual(value['diagnostics'][0]['kind'], 'tokenization-loss')
        self.assertEqual(value['diagnostics'][0]['nextAction'], 'switches-grep')
        self.assertIsNone(value['diagnostics'][0]['modelExcludeChanged'])
        self.assertIsNone(value['calls'][0]['input_identical'])
        fallback = {'surfaces': ['C++'], 'scannedDocuments': 23, 'ranking': 'rarity'}
        historical = dict(warning, details={'total': 0, 'fallback': fallback})
        value = native.retrieval({'toolResults': [historical]}, [call('first', first), historical], {})
        self.assertEqual(value['calls'][0]['details']['fallback'], fallback)


if __name__ == '__main__':
    unittest.main()
