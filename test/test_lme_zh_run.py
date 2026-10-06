"""Chinese live orchestration fixtures: RPC/model boundaries mocked, profiles forbidden."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HERE = ROOT / 'benchmark/coding-recall/e2e'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


common = module('zh_run_fixture_common', HERE / 'run.py')
with patch.dict(sys.modules, {'run': common}):
    runner = module('zh_run_fixture', HERE / 'lme-zh-run.py')
fixtures = module('zh_run_helper_fixture', ROOT / 'test/test_evaluate.py')


class ChineseLiveRunTest(unittest.TestCase):
    def test_wrong_pilot_continues_all16_provider_retry_and_identical_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            output, data, candidate = home / 'output', home / 'data', home / 'candidate'
            candidate.mkdir(); (data / 'data').mkdir(parents=True)
            helper = home / 'helper.py'; helper.write_text(fixtures.HELPER)
            archive = home / 'candidate.tar'; archive.write_bytes(b'Synthetic immutable archive')
            entry = candidate / 'entry.mjs'; entry.write_text('export default () => {};\n')
            pin = {'commit': '0' * 40, 'path': str(candidate), 'entry': 'entry.mjs',
                   'runtimeClosureSha256': {'entry.mjs': common.sha(entry)}, 'archiveSha256': common.sha(archive),
                   'nodeVersion': 'synthetic-node', 'sdkVersion': 'synthetic-sdk'}
            profile = home / 'forbidden-profile'
            config = {'sdk_path': str(home / 'synthetic-sdk'), 'helper_path': str(helper), 'data_path': str(data),
                      'output_dir': str(output), 'candidate_repo': str(candidate), 'system_prompt': 'Synthetic isolated system',
                      'protocol': {'segments': 4, 'reserve_tokens': 10, 'overhead_tokens': 1}}
            phase = {'provider': 'synthetic', 'model': 'synthetic-luna', 'effort': 'high', 'profile': str(profile)}
            config.update(compression=phase, answer=phase, judge=phase)
            models = {'compression': {k: phase[k] for k in ('provider', 'model', 'effort')},
                      'answer': {k: phase[k] for k in ('provider', 'model', 'effort')}, 'judges': {}}
            selected = ['dev8/' + qid for qid in runner.lme.DEV] + ['hard8/' + qid for qid in runner.lme.HARD]
            for key in selected:
                qid = key.split('/')[1]; folder = data / 'data' / key
                question = {'question_id': qid, 'question': '中文问题-' + qid, 'question_date': '2024/01/02 00:00'}
                corpus = {'haystack_dates': ['2024/01/01 00:00'], 'haystack_sessions': [[
                          {'role': 'user', 'content': f'合成证据{i}\u2028\u2029', 'has_answer': True} for i in range(16)]]}
                for filename, value in (('question-zh.json', question), ('question.json', question), ('corpus-zh.json', corpus),
                                        ('corpus.json', corpus), ('answer.json', {'question_id': qid, 'answer': '四'})):
                    common.write_json(folder / filename, value)
            common.write_json(home / 'config.json', config)
            for label, effort, model in (('luna', 'xhigh', 'synthetic-luna'), ('sol', 'medium', 'synthetic-sol')):
                own = {**phase, 'effort': effort, 'model': model}
                common.write_json(home / (label + '.json'), {**config, 'judge': own})
                models['judges'][label] = {k: own[k] for k in ('provider', 'model', 'effort')}
            common.write_json(home / 'approved.json', {'identity': {'models': models, 'inputs': {}, 'selected': selected}})
            common.write_json(home / 'candidate.json', {'snapshotCommit': pin['commit'], 'archiveSha256': common.sha(archive),
                              'archivePath': str(archive), 'snapshotRepo': str(candidate), 'configuration': runner.FIXED_ENV,
                              'files': {'entry.mjs': common.sha(entry)}})
            common.write_json(home / 'pins.json', {'sqlite': pin})
            scope = home / 'synthetic.scope'; scope.mkdir(); (scope / 'memory.peak').write_text('1024')
            args = argparse.Namespace(output=output, data_root=data, config=home / 'config.json', luna_config=home / 'luna.json',
                                      sol_config=home / 'sol.json', preflight=home / 'approved.json', candidate=home / 'candidate.json',
                                      pins=home / 'pins.json', workers=4, stage='all', commit=pin['commit'],
                                      archive_sha256=common.sha(archive), task='RSM-ZH16-NATIVE-LIVE-20261005')
            calls = []
            failed_once = False
            def process(command, **kwargs):
                self.assertNotIn('systemd-run', command)
                if command == ['node', '--version']:
                    return subprocess.CompletedProcess(command, 0, 'synthetic-node\n', '')
                if str(command[1]).endswith('pi-context-estimate.mjs'):
                    return subprocess.CompletedProcess(command, 0, json.dumps({'estimatedTokens': 100}), '')
                self.assertIn('--describe', command)
                cfg = json.loads(Path(command[command.index('--config') + 1]).read_text())
                selected_phase = command[command.index('--phase') + 1]
                result = {k: cfg[selected_phase][k] for k in ('provider', 'model', 'effort')}
                result.update(contextWindow=372000, maxTokens=128000, sdk_version='synthetic')
                return subprocess.CompletedProcess(command, 0, json.dumps(result), '')
            def compact(command, folder, **kwargs):
                nonlocal failed_once
                calls.append('compression')
                session = Path(command[command.index('--session') + 1]); folder = Path(folder)
                (folder / 'wire-requests.jsonl').write_text(json.dumps({'effort': 'high'}) + '\n')
                if not failed_once:
                    failed_once = True
                    return {'success': False, 'seconds': 1, 'response': {'success': False, 'error': 'synthetic provider failure'}, 'rc': 0}
                rows = common.transcript(session)
                rows.append({'type': 'compaction', 'id': 'c' + str(len(rows)), 'summary': 'Synthetic native checkpoint',
                             'firstKeptEntryId': rows[-1]['id'], 'parentId': rows[-1]['id'], 'tokensBefore': 100})
                session.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
                return {'success': True, 'seconds': 1, 'response': {'success': True, 'data': {'usage': {'input': 10, 'output': 2}}}, 'rc': 0}
            def rpc(command, env, folder, prompt, **kwargs):
                self.assertNotIn('systemd-run', command)
                folder = Path(folder); session = Path(command[command.index('--session') + 1])
                if folder.parent.name == 'probe':
                    tools = [{'name': name, 'description': 'Native synthetic tool', 'parameters': {}} for name in
                             ('history_expand', 'history_grep', 'history_recall')]
                    common.write_json(output / 'offline/tool-definitions' / (runner.ARM + '.json'),
                                      {'source': 'before_provider_request', 'descriptionsPreserved': True, 'registered': tools, 'serialized': tools})
                    return {'outcome': 'incomplete', 'rc': 2, 'timing': {}, 'stderr': ''}
                cfg = json.loads(Path(command[command.index('--config') + 1]).read_text())
                label = command[command.index('--phase') + 1]
                actual = cfg[label]
                calls.append(label)
                is_judge = label == 'judge'
                rows = [] if is_judge else common.transcript(session)
                rows.append({'type': 'thinking_level_change', 'thinkingLevel': actual['effort']})
                rows.append({'type': 'message', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': prompt}]}})
                if is_judge:
                    # Wrong pilot is still a valid complete pipeline and must not be rerun/tuned.
                    wrong = runner.lme.DEV[0] in str(folder)
                    text = json.dumps({'correct': not wrong, 'final_answer': '四', 'hedged': False, 'guess': False, 'reason': 'Synthetic verdict'})
                    common.write_json(folder / 'effort-evidence.json', {'effort': actual['effort'], 'source': 'onPayload'})
                else:
                    text = '四'
                    common.write_json(folder / 'tools.json', {'matched': True})
                    (folder / 'wire-requests.jsonl').write_text(json.dumps({'effort': actual['effort']}) + '\n')
                rows.append({'type': 'message', 'message': {'role': 'assistant', 'provider': actual['provider'], 'model': actual['model'],
                             'stopReason': 'stop', 'content': [{'type': 'text', 'text': text}],
                             'usage': {'input': 10, 'output': 2, 'cacheRead': 3, 'cacheWrite': 0}}})
                if is_judge:
                    session.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
                else:
                    # Append without reserializing the immutable native prefix.
                    suffix = rows[len(common.transcript(session)):]
                    with session.open('a') as stream:
                        stream.write(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in suffix))
                return {'outcome': 'completed', 'rc': 0, 'timing': {}, 'stderr': '', 'memory': {'peakObservedRssKiB': 100}}
            original_open = io.open
            def guard(path, *values, **kwargs):
                if isinstance(path, (str, Path)) and (Path(path) == profile or profile in Path(path).parents):
                    raise AssertionError('No profile reads')
                return original_open(path, *values, **kwargs)
            with (patch.object(runner, 'whole_scope', return_value=scope),
                  patch.object(runner.subprocess, 'run', side_effect=process), patch.object(runner.subprocess, 'Popen', side_effect=AssertionError('No process/provider')),
                  patch.object(common, 'compact_rpc', side_effect=compact), patch.object(common.e.rpc, 'run_rpc', side_effect=rpc),
                  patch.object(runner.time, 'sleep', return_value=None), patch.object(io, 'open', side_effect=guard),
                  contextlib.redirect_stdout(io.StringIO())):
                manifest = runner.run(args)
                self.assertEqual(manifest['state'], 'complete')
                self.assertEqual((len(manifest['snapshots']), len(manifest['completed']), len(manifest['failures'])), (16, 16, 0))
                self.assertEqual(manifest['pilot'], {'id': runner.lme.DEV[0], 'valid': True, 'countsIn16': True, 'correct': {'luna': False, 'sol': False}})
                self.assertEqual({name: calls.count(name) for name in set(calls)}, {'compression': 49, 'answer': 16, 'judge': 32})
                self.assertTrue(all(len(value['build']['compactions']) == 3 for value in manifest['snapshots'].values()))
                calls.clear(); resumed = runner.run(args)
                self.assertEqual(resumed['fingerprint'], manifest['fingerprint'])
                self.assertEqual(calls, [])
                gold = data / 'data' / selected[0] / 'answer.json'
                common.write_json(gold, {'question_id': runner.lme.DEV[0], 'answer': 'CHANGED_REFERENCE'})
                with self.assertRaisesRegex(ValueError, 'changed'):
                    runner.run(args)
                self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
