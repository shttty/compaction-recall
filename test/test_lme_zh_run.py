"""Current preparation, durable resume, gold isolation, and independent verdicts."""
from contextlib import contextmanager, redirect_stdout
from io import StringIO
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1] / 'benchmark/coding-recall/e2e'
sys.path.insert(0, str(HERE))
import run as common
import prepare
spec = importlib.util.spec_from_file_location('current_lme_runner', HERE / 'lme-zh-run.py')
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)
report = common.module('current_report_test', HERE / 'lme-zh-report.py')


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class CurrentFlow(unittest.TestCase):
    def fixture(self, root, swe=False):
        source, data, snapshots, profile, output = [root / name for name in ('source', 'data', 'snapshots', 'profile', 'output')]
        for folder in (source, data, snapshots, profile):
            folder.mkdir()
        save(source / 'package.json', {'dependencies': {}, 'peerDependencies': {'@earendil-works/pi-coding-agent': '*'}})
        save(source / 'package-lock.json', {'lockfileVersion': 3})
        (source / 'src').mkdir()
        (source / 'src/index.ts').write_text('export default function() {}\n')
        (source / 'src/worker.mjs').write_text('export const synthetic = true;\n')
        dependency = source / 'node_modules/@earendil-works/pi-coding-agent'
        save(dependency / 'package.json', {'name': '@earendil-works/pi-coding-agent', 'version': '1.0.0', 'dependencies': {'nested-runtime': '1'}})
        save(dependency / 'node_modules/nested-runtime/package.json', {'name': 'nested-runtime', 'version': '1'})
        (dependency / 'node_modules/nested-runtime/index.js').write_text('export const nested = true;\n')
        model = {'provider': 'synthetic', 'model': 'test-model', 'effort': 'off'}
        config = root / 'model-config.json'
        save(config, {'answer': model, 'judges': {'luna': model, 'sol': model},
                      'profiles': {'answer': str(profile), 'luna': str(profile), 'sol': str(profile)}})
        questions, bound, gold = [], {}, {}
        groups = [('dev8', tuple('swe-' + str(n) for n in range(8)))] if swe else [('dev8', prepare.DEV), ('hard8', prepare.HARD)]
        for group, ids in groups:
            for qid in ids:
                q = {'question_id': qid, 'question': 'Find synthetic evidence ' + qid, 'question_date': '2024/01/01 00:00'}
                session = snapshots / (qid + '.jsonl')
                rows = [{'type': 'session', 'version': 3, 'id': 'synthetic-' + qid},
                        {'type': 'message', 'id': 'retained', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'synthetic history'}]}}]
                rows += [{'type': 'compaction', 'id': 'fixture-compact-' + str(n), 'summary': 'Synthetic history only', 'firstKeptEntryId': 'retained'} for n in range(5 if swe else 3)]
                session.write_text(''.join(json.dumps(row) + '\n' for row in rows))
                current = {'id': qid, 'question': q['question'], 'question_date': q['question_date'], 'language': 'en'}
                questions.append(current)
                bound['pi/' + qid] = {'path': str(session), 'sha256': common.sha(session)}
                if swe:
                    current.update(snapshot=str(session), snapshotSha256=common.sha(session))
                    gold[qid] = {'answer': 'GOLD-MUST-NOT-REACH-SOLVER'}
                else:
                    save(data / 'data' / group / qid / 'question.json', q)
                    save(data / 'data' / group / qid / 'answer.json', {'question_id': qid, 'answer': 'GOLD-MUST-NOT-REACH-SOLVER'})
        identity = {'dataset': 'LME16-English', 'config': {'compression': model}, 'fixtureOnly': True}
        save(snapshots / 'manifest.json', {'identity': identity, 'fingerprint': common.object_sha(identity), 'state': 'complete', 'questions': questions, 'snapshots': bound})
        if swe:
            save(data / 'questions.json', questions)
            save(data / 'gold.json', gold)
            save(data / 'freeze.json', {'filesSha256': {str(p): common.sha(p) for p in (data / 'questions.json', data / 'gold.json')}})
        return SimpleNamespace(source_root=source, data_root=data, snapshot_source=snapshots, config=config,
            output=output, arm='pi-full', workers=1, stage='all', dataset='SWE-chat' if swe else 'LME16-English')

    @contextmanager
    def runtime(self, args, fault=None, fail_pilot=False):
        scope = args.output.parent / 'scope'
        scope.mkdir()
        (scope / 'memory.peak').write_text('4096')
        calls = []
        def serialize(output, config, pins, manifest):
            path = output / 'serialization/tools.json'
            save(path, {'fixtureOnly': True})
            manifest['toolEvidence'] = {args.arm: {'path': str(path), 'sha256': common.sha(path)}}
            manifest['answerDescriptor'] = {'contextWindow': 1000000, 'maxTokens': 1000}
            common.write_json(output / 'manifest.json', manifest)
        def invoke(command, env, folder, *, prompt, **kwargs):
            folder = Path(folder)
            session = Path(command[command.index('--session') + 1])
            phase = command[command.index('--phase') + 1]
            stage = 'answer' if phase == 'answer' else 'numerical' if 'grade-1to10' in folder.parts else 'strict'
            qid = next(qid for qid in (*prepare.DEV, *prepare.HARD) if qid in folder.parts)
            calls.append((stage, qid))
            failing = fault in (stage, 'capacity-' + stage) and (fail_pilot or qid != prepare.DEV[0])
            provider_failure = failing and (stage == 'answer' or fault.startswith('capacity-'))
            if phase == 'answer':
                self.assertNotIn('GOLD-MUST-NOT-REACH-SOLVER', prompt)
                self.assertNotIn('GOLD-MUST-NOT-REACH-SOLVER', session.read_text())
                text = 'Synthetic solver response'
                save(folder / 'tools.json', {'fixtureOnly': True})
                (folder / 'wire-requests.jsonl').write_text(json.dumps({'effort': 'off'}) + '\n')
            else:
                self.assertIn('GOLD-MUST-NOT-REACH-SOLVER', prompt)
                text = '{"score":9,"reason":"independent scoring"}' if stage == 'numerical' else json.dumps({
                    'correct': fault is not None, 'final_answer': 'Synthetic solver response',
                    'guess': False, 'hedged': False, 'reason': 'independent strict judgment'})
                if failing:
                    text = 'invalid verdict'
                save(folder / 'effort-evidence.json', {'effort': 'off', 'source': 'onPayload'})
            assistant = {'role': 'assistant', 'provider': 'synthetic', 'model': 'test-model',
                'thinkingLevel': 'off', 'stopReason': 'error' if provider_failure else 'stop',
                'content': [{'type': 'text', 'text': '' if provider_failure else text}],
                'usage': {'input': 10, 'output': 5, 'cacheRead': 0, 'cacheWrite': 0}}
            if provider_failure:
                assistant['errorMessage'] = 'context_length_exceeded' if fault.startswith('capacity-') else 'synthetic provider failure'
            rows = [{'type': 'message', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': prompt}]}},
                    {'type': 'message', 'message': assistant}]
            with session.open('a') as stream:
                stream.write(''.join(json.dumps(row) + '\n' for row in rows))
            return {'outcome': 'completed', 'rc': 0, 'timing': {}, 'memory': {}}
        actual_subprocess, actual_module = live.subprocess.run, common.module
        def estimate(command, **kwargs):
            if command[0] == 'node' and 'pi-context-estimate.mjs' in command[1]:
                return SimpleNamespace(stdout='{"estimatedTokens":100}', returncode=0)
            return actual_subprocess(command, **kwargs)
        def module(name, path):
            return live if name == 'grade_resource_scope' else actual_module(name, path)
        with patch.object(live, 'whole_scope', return_value=scope), patch.object(live, 'serialization', side_effect=serialize), \
             patch.object(common.rpc, 'run_rpc', side_effect=invoke), patch.object(live.subprocess, 'run', side_effect=estimate), \
             patch.object(common, 'module', side_effect=module), patch.object(live.r2.time, 'sleep'), \
             patch.object(live.r2, 'scoped_rpc', side_effect=invoke):
            yield calls

    def cli(self, args, stage):
        command = [str(HERE / 'lme-zh-run.py'), '--config', str(args.config), '--data-root', str(args.data_root),
            '--snapshot-source', str(args.snapshot_source), '--output', str(args.output), '--source-root', str(args.source_root),
            '--stage', stage, '--workers', '1']
        output = StringIO()
        code = 0
        try:
            with redirect_stdout(output), patch.object(sys, 'argv', command):
                live.main()
        except SystemExit as error:
            code = error.code
        finally:
            lines = output.getvalue().splitlines()
            if lines and lines[-1].startswith('[{'):
                print('OFFLINE_CLI ' + lines[-1])
        return code

    def test_failed_phases_are_partial_and_cli_exits_nonzero(self):
        for fault, stage, fail_pilot in (('answer', 'all', False), ('answer', 'flow', False),
                ('strict', 'all', False), ('strict', 'flow', False),
                ('numerical', 'flow', False), ('numerical', 'flow', True)):
            with self.subTest(fault=fault, stage=stage, fail_pilot=fail_pilot), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                with self.runtime(args, fault, fail_pilot) as calls:
                    self.assertEqual(self.cli(args, 'pilot'), 0)
                    self.assertEqual(self.cli(args, stage), 1)
                    summary = json.loads((args.output / 'aggregate.json').read_text())
                    self.assertEqual(summary['state'], 'failed' if fail_pilot else 'partial')
                    self.assertEqual(len(summary['selected']), 16)
                    result = summary['grade1to10' if fault == 'numerical' else 'judges']['luna']
                    self.assertEqual((result['selected'], result['scored'], result['failed'], result['pending']),
                                     (16, 0, 16, 0) if fail_pilot else (16, 1, 15, 0))
                    if fault == 'numerical':
                        self.assertEqual(result['meanScore'], None if fail_pilot else 9)
                    else:
                        self.assertEqual(result['accuracy'], 1)
                    count = len(calls)
                    self.assertEqual(self.cli(args, stage), 1)
                    self.assertEqual(len(calls), count)

    def test_capacity_reentry_preserves_only_complete_cases_without_provider_replay(self):
        for stage in ('answer', 'strict', 'numerical'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                with self.runtime(args, 'capacity-' + stage) as calls:
                    self.assertEqual(self.cli(args, 'pilot'), 0)
                    self.assertEqual(self.cli(args, 'flow' if stage == 'numerical' else 'all'), 1)
                    path = args.output / ('grade-1to10/manifest.json' if stage == 'numerical' else 'manifest.json')
                    manifest = json.loads(path.read_text())
                    self.assertEqual(manifest['state'], 'capacity-blocked')
                    self.assertEqual(manifest['completed'], [prepare.DEV[0]])
                    self.assertEqual(calls.count((stage, prepare.DEV[1])), 1)
                    count = len(calls)
                    self.assertEqual(count, {'answer': 4, 'strict': 5, 'numerical': 51}[stage])
                    self.assertEqual(self.cli(args, 'flow' if stage == 'numerical' else 'all'), 1)
                    self.assertEqual(len(calls), count)
                    summary = json.loads((args.output / 'aggregate.json').read_text())
                    self.assertEqual(summary['state'], 'capacity-blocked')
                    coverage = summary['grade1to10' if stage == 'numerical' else 'judges']['luna']
                    self.assertEqual((coverage['selected'], coverage['scored'], coverage['failed'], coverage['pending']), (16, 1, 1, 14))
                    sol = summary['grade1to10' if stage == 'numerical' else 'judges']['sol']
                    self.assertEqual((sol['selected'], sol['scored'], sol['failed'], sol['pending']),
                                     (16, 1, 1, 14) if stage == 'answer' else (16, 1, 0, 15))

    def test_cli_prepares_swe_native_shape_and_reuses_identical_freeze(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.fixture(root, swe=True)
            command = [sys.executable, str(HERE / 'lme-zh-run.py'), '--config', str(args.config),
                '--data-root', str(args.data_root), '--output', str(args.output), '--source-root', str(args.source_root),
                '--dataset', 'SWE-chat', '--stage', 'prepare', '--workers', '1']
            subprocess.run(command, check=True, capture_output=True)
            initial = (args.output / 'manifest.json').read_bytes()
            subprocess.run(command, check=True, capture_output=True)
            self.assertEqual((args.output / 'manifest.json').read_bytes(), initial)
            manifest = json.loads(initial)
            self.assertEqual(len(manifest['selected']), 8)
            self.assertTrue(all(len(item['nativeCompactions']) == 5 for item in manifest['snapshots'].values()))
            self.assertNotIn('data_path', json.loads((args.output / 'config.json').read_text()))
            target = args.output / 'candidate/node_modules/@earendil-works/pi-coding-agent/node_modules/nested-runtime/index.js'
            self.assertTrue(target.is_file())
            target.chmod(0o600)
            target.write_text('changed runtime dependency')
            failed = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn('Frozen candidate changed', failed.stderr)

    def test_completed_answer_strict_and_score_resume_without_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            with self.runtime(args) as calls:
                self.assertEqual(self.cli(args, 'flow'), 0)
                result = json.loads((args.output / 'manifest.json').read_text())
                self.assertEqual(result['state'], 'complete')
                count = len(calls)
                self.assertEqual(count, 16 * 5)
                self.assertEqual(self.cli(args, 'flow'), 0)
                self.assertEqual(len(calls), count)
            summary = report.write_report(args.output)
            self.assertEqual(summary['judges']['luna']['accuracy'], 0)
            self.assertEqual(summary['grade1to10']['luna']['meanScore'], 9)
            saved = (args.output / 'manifest.json').read_bytes()
            altered = json.loads(saved)
            altered['questions'][0]['answer'] = 'tampered reference'
            save(args.output / 'manifest.json', altered)
            with self.assertRaisesRegex(ValueError, 'identity changed'):
                live.prepare(args)
            with self.assertRaisesRegex(ValueError, 'manifest identity differs'):
                report.write_report(args.output)


    def test_historical_output_is_not_modified_and_failures_are_not_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            path = args.output / 'manifest.json'
            save(path, {'identity': {'task': 'frozen-history'}, 'fingerprint': 'immutable'})
            original = path.read_bytes()
            with self.assertRaisesRegex(ValueError, 'Historical outputs are immutable'):
                live.prepare(args)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual({p.name for p in args.output.iterdir()}, {'manifest.json'})
        failed = report.summarize([{'status': 'provider-error', 'verdict': None}], score=True)
        self.assertIsNone(failed['meanScore'])
        self.assertEqual(failed['scores'], [])
        self.assertEqual(failed['failed'], 1)
        self.assertEqual(failed['scored'], 0)

    def test_answer_and_judge_resume_require_complete_matching_hash_evidence(self):
        for phase in ('answer', 'judge'):
            for damage in ('missing', 'inflight', 'identity', 'hash'):
                with self.subTest(phase=phase, damage=damage), tempfile.TemporaryDirectory() as directory:
                    args = self.fixture(Path(directory))
                    with self.runtime(args) as calls:
                        self.assertEqual(self.cli(args, 'pilot'), 0)
                        count = len(calls)
                        self.assertEqual(self.cli(args, 'pilot'), 0)
                        self.assertEqual(len(calls), count)
                        output, config, pins, manifest, configs, paths = live.prepare(args)
                        question = manifest['questions'][0]
                        answer = json.loads((output / 'results' / args.arm / question['id'] / 'result.json').read_text())
                        folder = args.output / ('results' if phase == 'answer' else 'judge-v2/luna') / args.arm / prepare.DEV[0]
                        marker, path = folder / 'result-state.json', folder / 'result.json'
                        state = json.loads(marker.read_text())
                        if damage == 'missing':
                            marker.unlink()
                        elif damage == 'inflight':
                            save(marker, {**state, 'state': 'inflight'})
                        elif damage == 'identity':
                            save(marker, {**state, 'identity': 'changed completion identity'})
                        if damage in ('missing', 'hash'):
                            record = json.loads(path.read_text())
                            record['answer' if phase == 'answer' else 'rawVerdict'] = 'tampered body with original identity'
                            save(path, record)
                        with self.assertRaises(ValueError):
                            if phase == 'answer':
                                live.r2.answer_one(output, config, pins, manifest, question, args.arm, command_factory=live.answer_command)
                            else:
                                live.r2.judge_one(output, manifest, paths, configs, question, args.arm, answer, 'luna')
                        with self.assertRaises(ValueError):
                            self.cli(args, 'pilot')
                        self.assertEqual(len(calls), count)

    def test_unknown_inflight_and_changed_completed_transcript_refuse_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            save(path / 'result-state.json', {'identity': 'fixture', 'state': 'inflight'})
            with self.assertRaisesRegex(ValueError, 'Unknown inflight'):
                common.durable_phase(path, 'result', 'fixture', lambda: self.fail('Unknown inflight replay'))
            (path / 'result-state.json').unlink()
            session = path / 'session.jsonl'
            session.write_text('synthetic original')
            common.durable_phase(path, 'result', 'fixture', lambda: {'session': str(session), 'sessionSha256': common.sha(session)})
            session.write_text('tampered transcript')
            with self.assertRaisesRegex(ValueError, 'Saved transcript bytes changed'):
                common.durable_phase(path, 'result', 'fixture', lambda: self.fail('Completed phase replay'))


if __name__ == '__main__':
    unittest.main()
