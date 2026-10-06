"""Shared candidate orchestration guards; SDK/process boundaries only are replaced."""
import argparse
from contextlib import ExitStack, contextmanager, redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from test_lme_zh_run import common, fixtures, runner


@contextmanager
def concept_fixture(test, *, exhausted=False, barrier=False, arm='pi-concepts'):
    with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
        home = Path(directory)
        old, output, data = home / 'old', home / 'concepts', home / 'data'
        old.mkdir(); (data / 'data').mkdir(parents=True)
        helper = home / 'helper.py'; helper.write_text(fixtures.HELPER)
        config = {'sdk_path': str(home / 'sdk'), 'helper_path': str(helper), 'data_path': str(data),
                  'output_dir': str(old), 'candidate_repo': str(home / 'raw-runtime'), 'system_prompt': 'Isolated fixture',
                  'protocol': {'segments': 4, 'reserve_tokens': 16384, 'overhead_tokens': 1}}
        phase = {'provider': 'clp', 'model': 'gpt-6-luna', 'effort': 'high', 'profile': str(home / 'forbidden-profile')}
        config.update(compression=phase, answer=phase, judge=phase)
        common.write_json(home / 'config.json', config)
        models = {key: {k: phase[k] for k in ('provider', 'model', 'effort')} for key in ('compression', 'answer')}
        models['judges'] = {}
        for label, model, effort in (('luna', 'gpt-6-luna', 'xhigh'), ('sol', 'gpt-6.1-sol', 'medium')):
            selected = {**phase, 'model': model, 'effort': effort}
            common.write_json(home / (label + '.json'), {**config, 'judge': selected})
            models['judges'][label] = {k: selected[k] for k in ('provider', 'model', 'effort')}
        selected = ['dev8/' + qid for qid in runner.lme.DEV] + ['hard8/' + qid for qid in runner.lme.HARD]
        for key in selected:
            qid = key.split('/')[1]
            question = {'question_id': qid, 'question': '中文原题-' + qid, 'question_date': '2024/01/02 00:00'}
            question['question_en'] = question['question']
            corpus = {'haystack_dates': ['2024/01/01 00:00'], 'haystack_sessions': [[
                {'role': 'user', 'content': '合成证据', 'has_answer': True} for _ in range(16)]]}
            for name, value in (('question-zh.json', question), ('question.json', question), ('corpus-zh.json', corpus),
                                ('corpus.json', corpus), ('answer.json', {'question_id': qid, 'answer': '四'})):
                common.write_json(data / 'data' / key / name, value)
        common.write_json(home / 'approved.json', {'identity': {'models': models, 'selected': selected, 'inputs': {}}})
        def candidate(root, commit):
            runtime = root / 'runtime'; runtime.mkdir(parents=True)
            entry = runtime / 'entry.mjs'; entry.write_text('export default () => {};\n')
            archive = root / 'archive.tar'; archive.write_bytes(commit.encode())
            pin = {'commit': commit, 'path': str(runtime), 'entry': 'entry.mjs', 'archiveSha256': common.sha(archive),
                   'runtimeClosureSha256': {'entry.mjs': common.sha(entry)}, 'nodeVersion': 'fixture-node', 'sdkPath': str(home / 'sdk')}
            common.write_json(root / 'pins.json', {'sqlite': pin})
            common.write_json(root / 'candidate.json', {'snapshotCommit': commit, 'archiveSha256': common.sha(archive),
                'archivePath': str(archive), 'snapshotRepo': str(runtime), 'configuration': runner.FIXED_ENV,
                'files': {'entry.mjs': common.sha(entry)}})
            return archive
        archive = candidate(old, '0' * 40)
        args = argparse.Namespace(output=old, data_root=data, config=home / 'config.json', luna_config=home / 'luna.json',
            sol_config=home / 'sol.json', preflight=home / 'approved.json', candidate=old / 'candidate.json',
            pins=old / 'pins.json', workers=4, stage='all', commit='0' * 40,
            archive_sha256=common.sha(archive), task='RSM-ZH16-NATIVE-LIVE-20261005')
        processes, calls = [], []
        def process(command, **kwargs):
            processes.append(list(command))
            test.assertNotIn('systemd-run', command)
            if command == ['node', '--version']:
                return subprocess.CompletedProcess(command, 0, 'fixture-node\n', '')
            if str(command[1]).endswith('pi-context-estimate.mjs'):
                return subprocess.CompletedProcess(command, 0, json.dumps({'estimatedTokens': 100}), '')
            test.assertIn('--describe', command)
            cfg = json.loads(Path(command[command.index('--config') + 1]).read_text())
            value = {k: cfg[command[command.index('--phase') + 1]][k] for k in ('provider', 'model', 'effort')}
            value.update(contextWindow=372000, maxTokens=128000)
            return subprocess.CompletedProcess(command, 0, json.dumps(value), '')
        stack.enter_context(patch.object(runner.subprocess, 'run', side_effect=process))
        _, _, _, manifest, _, _ = runner.prepare(args)
        for qid in manifest['selected']:
            session = old / 'compression/pi' / qid / 'session.jsonl'; session.parent.mkdir(parents=True)
            session.write_text(json.dumps({'type': 'session', 'version': 3, 'id': qid}) + '\n' + ''.join(
                json.dumps({'type': 'compaction', 'id': 'c' + str(i), 'summary': '合成原始摘要'}) + '\n' for i in range(3)))
            manifest['snapshots']['pi/' + qid] = {'path': str(session), 'sha256': common.sha(session), 'language': 'zh',
                'build': {'fingerprint': manifest['fingerprint'], 'state': 'complete', 'cuts': [0, 4, 8, 12, 16],
                          'compactions': [{'success': True, 'seconds': 1} for _ in range(3)]}}
        manifest.update(state='complete', completed=list(manifest['selected']))
        common.write_json(old / 'manifest.json', manifest)
        (old / 'REPORT.md').write_text('Original immutable report\n')
        output.mkdir()
        archive = candidate(output, '1' * 40)
        args = argparse.Namespace(**{**vars(args), 'output': output, 'candidate': output / 'candidate.json',
            'pins': output / 'pins.json', 'arm': arm, 'snapshot_source': old, 'workers': 8,
            'commit': '1' * 40, 'archive_sha256': common.sha(archive), 'task': 'synthetic-candidate'})
        scope = home / 'fixture.scope'; scope.mkdir(); (scope / 'memory.peak').write_text('4096')
        stack.enter_context(patch.object(runner, 'whole_scope', return_value=scope))
        stack.enter_context(patch.dict(sys.modules, {'run': common}))
        original_module = common.module
        def load_module(name, path):
            value = original_module(name, path)
            if name == 'zh_flow_grade':
                stack.enter_context(patch.object(value, 'scope_directory', return_value=scope))
            return value
        stack.enter_context(patch.object(common, 'module', side_effect=load_module))
        stack.enter_context(patch.object(runner.lme, 'build_native', side_effect=AssertionError('Cannot rebuild source')))
        stack.enter_context(patch.object(common, 'compact_rpc', side_effect=AssertionError('Cannot compact')))
        stack.enter_context(patch.object(runner.subprocess, 'Popen', side_effect=AssertionError('No live processes')))
        stack.enter_context(patch.object(runner.time, 'sleep', return_value=None))
        stack.enter_context(redirect_stdout(io.StringIO()))
        rpc_lock = threading.Lock()
        rendezvous = threading.Barrier(8)
        counts = {}
        def rpc(command, env, folder, prompt, **kwargs):
            folder = Path(folder)
            session = Path(command[command.index('--session') + 1])
            cfg = json.loads(Path(command[command.index('--config') + 1]).read_text())
            label = command[command.index('--phase') + 1]
            actual = cfg[label]
            if label == 'judge' and 'grade-1to10' in folder.parts:
                label = 'score'
            test.assertNotIn('systemd-run', command)
            if folder.parent.name == 'probe':
                tools = [{'name': name, 'description': 'Frozen native description', 'parameters': {}} for name in
                         (('history_expand', 'history_recall') if arm == 'pi-grep-fallback' else ('history_expand', 'history_grep', 'history_recall'))]
                tools[-1]['parameters'] = {'properties': {'concepts': {'type': 'array'}, 'match': {'enum': ['any', 'all']},
                    'exclude': {'type': 'array'}, 'limit': {'type': 'integer'}, 'offset': {'type': 'integer'}}, 'required': ['concepts']}
                if arm == 'pi-restored-grep':
                    tools[1]['parameters'] = {'properties': {'pattern': {'type': 'string'}, 'limit': {'type': 'integer'}, 'offset': {'type': 'integer'}}, 'required': ['pattern']}
                common.write_json(output / 'offline/tool-definitions' / (arm + '.json'),
                    {'source': 'before_provider_request', 'descriptionsPreserved': True, 'registered': tools, 'serialized': tools})
                return {'outcome': 'incomplete', 'rc': 2, 'timing': {}, 'stderr': ''}
            qid = next(qid for qid in manifest['selected'] if qid in str(folder))
            with rpc_lock:
                calls.append((label, qid, actual['effort']))
                counts[label, qid] = counts.get((label, qid), 0) + 1
                number = counts[label, qid]
            fail = label == 'answer' and qid == manifest['selected'][1] and (exhausted or number == 1)
            if barrier and label == 'answer' and qid in manifest['selected'][1:9] and not fail:
                rendezvous.wait(timeout=20)
            is_judge = label in ('judge', 'score')
            rows = [{'type': 'thinking_level_change', 'thinkingLevel': actual['effort']},
                    {'type': 'message', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': prompt}]}}]
            if is_judge:
                text = json.dumps({'score': 9, 'reason': 'Independent graded answer'}) if label == 'score' else json.dumps({
                    'correct': qid != manifest['selected'][0], 'final_answer': '四',
                    'hedged': False, 'guess': False, 'reason': 'Offline wrong pilot'})
                common.write_json(folder / 'effort-evidence.json', {'effort': actual['effort'], 'source': 'onPayload'})
            else:
                text = '' if fail else '四'
                test.assertEqual(command[command.index('--arm') + 1], 'production')
                if arm == 'pi-restored-grep':
                    test.assertEqual(command[command.index('--recall-config') + 1], str(output / 'recall-config.json'))
                    test.assertEqual(json.loads((output / 'recall-config.json').read_text()),
                        {'mode': 'full', 'trace': True, 'autoGate': 280, 'snippetBudget': 240, 'recallTimeoutMs': 5000})
                common.write_json(folder / 'tools.json', {'matched': True})
                (folder / 'wire-requests.jsonl').write_text(json.dumps({'effort': 'high'}) + '\n')
                if qid == manifest['selected'][2]:
                    rows.extend([{'type': 'message', 'message': {'role': 'assistant', 'provider': 'clp', 'model': 'gpt-6-luna',
                        'content': [{'type': 'toolCall', 'id': 't1', 'name': 'history_recall',
                                     'arguments': {'concepts': ['词'], 'match': 'all', 'exclude': ['排除'], 'limit': 2, 'offset': 0}}]}},
                        {'type': 'message', 'message': {'role': 'toolResult', 'toolCallId': 't1', 'toolName': 'history_recall',
                         'isError': True, 'content': [{'type': 'text', 'text': 'tool timeout'}]}}])
            rows.append({'type': 'message', 'message': {'role': 'assistant', 'provider': actual['provider'], 'model': actual['model'],
                'stopReason': 'error' if fail else 'stop', 'content': [{'type': 'text', 'text': text}],
                'usage': {'input': 10, 'output': 2, 'cacheRead': 3, 'cacheWrite': 0}}})
            with session.open('w' if is_judge else 'a') as stream:
                stream.write(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
            return {'outcome': 'completed', 'rc': 0, 'timing': {}, 'stderr': '', 'memory': {'peakObservedRssKiB': 100}}
        stack.enter_context(patch.object(common.e.rpc, 'run_rpc', side_effect=rpc))
        original_open = io.open
        def no_profile(path, *values, **kwargs):
            if isinstance(path, (str, Path)) and 'forbidden-profile' in Path(path).parts:
                raise AssertionError('Profiles remain opaque')
            return original_open(path, *values, **kwargs)
        stack.enter_context(patch.object(io, 'open', side_effect=no_profile))
        protected = {str(path): common.sha(path) for path in old.rglob('*') if path.is_file()}
        processes.clear()
        yield args, protected, processes, calls, counts


class ConceptsNativeRunTest(unittest.TestCase):
    def test_wrong_pilot_reuse_retry_caps_and_zero_rpc_resume(self):
        with concept_fixture(self, barrier=True, arm='pi-restored-grep') as (args, protected, processes, calls, counts):
            args.stage = 'flow'
            graded = runner.flow(args)
            manifest = json.loads((args.output / 'manifest.json').read_text())
            aggregate = json.loads((args.output / 'grade-1to10/aggregate.json').read_text())
            self.assertEqual(aggregate['scores']['luna']['total']['totalScore'], 144)
            self.assertEqual(aggregate['strict']['luna']['total']['correct'], 15)
            self.assertEqual(aggregate['resources']['newCompressionCalls'], 0)
            self.assertEqual(manifest['state'], 'complete')
            self.assertEqual(len(manifest['completed']), 16)
            self.assertEqual(manifest['pilot']['correct'], {'luna': False, 'sol': False})
            self.assertTrue(manifest['pilot']['valid'])
            self.assertTrue(all(row['reused'] and row['sourceRun'] == str(args.snapshot_source) for row in manifest['snapshots'].values()))
            self.assertEqual([phase for phase, _, _ in calls].count('answer'), 17)
            self.assertEqual([phase for phase, _, _ in calls].count('judge'), 32)
            self.assertEqual([phase for phase, _, _ in calls].count('score'), 32)
            self.assertEqual({effort for phase, _, effort in calls if phase == 'judge'}, {'xhigh', 'medium'})
            resource = json.loads((args.output / 'resource.json').read_text())
            self.assertEqual((resource['workers'], resource['peakActiveQuestions'], resource['peakActiveRpcSessions']), (8, 8, 8))
            self.assertEqual((resource['activeQuestions'], resource['activeRpcSessions']), (0, 0))
            self.assertEqual(resource['phaseCounts'], {'serialization': 1, 'answer': 17, 'judge': 32})
            self.assertFalse((args.output / 'compression').exists())
            runner.verify_files(protected, 'Protected old run')
            calls.clear(); processes.clear()
            resumed = runner.flow(args)
            self.assertEqual(resumed['fingerprint'], graded['fingerprint'])
            self.assertEqual(calls, [])
            self.assertEqual(processes, [['node', '--version']])
            runner.verify_files(protected, 'Protected old run')
            snapshot = Path(next(iter(manifest['snapshots'].values()))['path'])
            snapshot.write_bytes(snapshot.read_bytes() + b'\n')
            with self.assertRaisesRegex(ValueError, 'changed'):
                runner.flow(args)
            self.assertEqual(calls, [])

    def test_completed_result_tampering_is_rejected_without_provider_replay(self):
        with concept_fixture(self) as (args, protected, processes, calls, counts):
            manifest = runner.run(args)
            calls.clear()
            path = args.output / 'results/pi-concepts' / manifest['selected'][0] / 'result.json'
            saved = json.loads(path.read_text())
            saved['answer'] = 'Tampered paid result'
            common.write_json(path, saved)
            with self.assertRaisesRegex(ValueError, 'Saved phase output bytes changed'):
                runner.run(args)
            self.assertEqual(calls, [])
            runner.verify_files(protected, 'Protected old run')

    def test_exhausted_provider_is_terminal_unscored_and_not_replayed(self):
        with concept_fixture(self, exhausted=True) as (args, protected, processes, calls, counts):
            manifest = runner.run(args)
            qid = manifest['selected'][1]
            self.assertEqual(counts['answer', qid], 3)
            result = json.loads((args.output / 'results/pi-concepts' / qid / 'result.json').read_text())
            self.assertEqual(result['outcome'], 'model-error')
            for label in ('luna', 'sol'):
                result = json.loads((args.output / 'judge-v2' / label / 'pi-concepts' / qid / 'result.json').read_text())
                self.assertEqual(result['status'], 'answer-failure')
                self.assertIsNone(result['verdict'])
            calls.clear(); runner.run(args)
            self.assertEqual(calls, [])
            runner.verify_files(protected, 'Protected old run')

    def test_pilot_resume_uses_cached_serialization_and_judges(self):
        with concept_fixture(self) as (args, protected, processes, calls, counts):
            common.write_json(args.output / 'launch.json', {'handle': 'offline-parent-handle', 'workers': 8})
            args.stage = 'pilot'
            manifest = runner.run(args)
            self.assertEqual(manifest['state'], 'pilot-valid')
            self.assertEqual(calls, [('answer', runner.lme.DEV[0], 'high'),
                                     ('judge', runner.lme.DEV[0], 'xhigh'), ('judge', runner.lme.DEV[0], 'medium')])
            calls.clear(); processes.clear()
            args.stage = 'all'
            manifest = runner.run(args)
            self.assertEqual(len(manifest['completed']), 16)
            self.assertTrue(all(qid != runner.lme.DEV[0] for _, qid, _ in calls))
            self.assertFalse(any('--describe' in command for command in processes))
            resource = json.loads((args.output / 'resource.json').read_text())
            self.assertEqual(resource['launch']['handle'], 'offline-parent-handle')
            self.assertTrue(resource['launchKnown'])
            runner.verify_files(protected, 'Protected old run')

    def test_requires_explicit_concepts_guards_and_source_policy(self):
        with concept_fixture(self) as (args, protected, processes, calls, counts):
            args.workers = 4
            with self.assertRaisesRegex(ValueError, 'workers 8'):
                runner.run(args)
            args.workers = 8
            candidate = json.loads(args.candidate.read_text()); candidate['snapshotCommit'] = '2' * 40
            common.write_json(args.candidate, candidate)
            with self.assertRaisesRegex(ValueError, 'explicit commit'):
                runner.run(args)
            candidate['snapshotCommit'] = args.commit; common.write_json(args.candidate, candidate)
            old_path = args.snapshot_source / 'manifest.json'
            old = json.loads(old_path.read_text()); old['identity']['questionPolicy'] = 'changed'
            old['fingerprint'] = common.e.object_sha(old['identity']); common.write_json(old_path, old)
            with self.assertRaisesRegex(ValueError, 'policy changed'):
                runner.run(args)
            self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
