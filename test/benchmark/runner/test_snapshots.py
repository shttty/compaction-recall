"""Offline synthetic snapshot contracts; no credentials, network, or model calls."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[3] / 'benchmark'
sys.path.insert(0, str(HERE))
import snapshots
from runner import artifacts as common
from runner import compression, prepare


class NativeSnapshotContracts(unittest.TestCase):
    def setUp(self):
        for name in ('socket.socket.connect', 'socket.create_connection'):
            guard = patch(name, side_effect=AssertionError('Offline test attempted a network request'))
            guard.start()
            self.addCleanup(guard.stop)

    def fixture(self, root):
        output = root / 'snapshots'
        output.mkdir()
        corpus = {'haystack_dates': ['2024/01/02 (Tue) 00:00', '2024/01/01 (Mon) 00:00'],
                  'haystack_sessions': [
                      [{'role': 'user' if n % 2 == 0 else 'assistant', 'content': 'later synthetic turn ' + str(n)} for n in range(8)],
                      [{'role': 'user' if n % 2 == 0 else 'assistant', 'content': 'earlier synthetic turn ' + str(n)} for n in range(6)]]}
        corpus_path = root / 'corpus.json'
        common.write_json(corpus_path, corpus)
        model = {'provider': 'synthetic', 'model': 'offline-fixture', 'effort': 'off'}
        config = {'answer': model}
        common.write_json(output / 'config.json', config)
        question = {'id': 'q', 'question': 'Evaluation question is not a history turn.',
                    'question_date': '2024/02/01', 'language': 'en'}
        return output, corpus, corpus_path, config, question

    def synthetic_worker(self, cuts, calls):
        def run(command, folder):
            calls.append(command)
            source = Path(command[command.index('--source') + 1])
            session = Path(command[command.index('--session') + 1])
            result = Path(command[command.index('--result') + 1])
            rows, projected = common.transcript(source), []
            for count, row in enumerate(rows):
                projected.append(row)
                if count in cuts:
                    projected.append({'type': 'compaction', 'id': 'fixture-c' + str(count),
                                      'parentId': row['id'], 'summary': 'Synthetic offline fixture summary only.',
                                      'firstKeptEntryId': row['id'], 'fromHook': False})
            session.write_text(''.join(json.dumps(row) + '\n' for row in projected))
            common.write_json(result, {'sdkVersion': '1.4.0', 'messageCount': len(rows) - 1,
                                       'compactions': [{'cut': count} for count in cuts]})
        return run

    def test_variable_native_snapshots_bind_and_restore_exact_history_without_replay(self):
        for cuts in ([2], [2, 4], [2, 4, 6, 8, 10], [2, 14]):
            with self.subTest(cuts=cuts), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                output, corpus, corpus_path, config, question = self.fixture(root)
                calls = []
                saved = snapshots.generate_question(output, config, 'fixture-run', question, corpus_path,
                    worker_runner=self.synthetic_worker(cuts, calls))
                source = common.transcript(Path(saved['sourcePath']))
                self.assertEqual(source[1]['id'], '00000001')
                self.assertEqual(source[1]['message']['timestamp'], 1704067200000)
                self.assertEqual(source[1]['message']['content'], [{'type': 'text', 'text': '[Session Date: 2024/01/01 (Mon) 00:00]\nearlier synthetic turn 0'}])
                identity = {'config': {'compression': config['answer']}}
                common.write_json(output / 'manifest.json', {'identity': identity, 'fingerprint': common.object_sha(identity),
                    'state': 'complete', 'questions': [question], 'snapshots': {'pi/q': saved}})
                bound, binding = prepare.bind_snapshots(output, root / 'evaluation', [question], 'LME16-English')
                self.assertEqual(binding['compression'], config['answer'])
                _, messages, observed = compression.source_history(Path(bound['pi/q']['path']), corpus)
                self.assertEqual(observed, [0, *cuts, *([] if cuts[-1] == 14 else [14])])
                self.assertEqual([compression.projection(row) for row in messages], compression.corpus_projection(corpus))
                reused = snapshots.generate_question(output, config, 'fixture-run', question, corpus_path,
                    worker_runner=lambda *args: self.fail('Completed question called the worker again'))
                self.assertEqual(reused, saved)
                self.assertEqual(len(calls), 1)
                session = Path(saved['path'])
                session.write_text(session.read_text().replace('Synthetic offline fixture summary', 'Tampered summary'))
                with self.assertRaisesRegex(ValueError, 'Native snapshot changed'):
                    snapshots.generate_question(output, config, 'fixture-run', question, corpus_path,
                        worker_runner=lambda *args: self.fail('Tampering triggered model replay'))

    def test_unknown_inflight_worker_is_never_replayed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output, _, corpus_path, config, question = self.fixture(root)
            calls = []
            def interrupted(command, folder):
                calls.append(command)
                raise RuntimeError('Synthetic process lost after dispatch')
            with self.assertRaisesRegex(RuntimeError, 'lost after dispatch'):
                snapshots.generate_question(output, config, 'fixture-run', question, corpus_path, worker_runner=interrupted)
            with self.assertRaisesRegex(ValueError, 'Unknown inflight'):
                snapshots.generate_question(output, config, 'fixture-run', question, corpus_path,
                    worker_runner=lambda *args: self.fail('Unknown inflight request replayed'))
            self.assertEqual(len(calls), 1)

    def test_changed_question_identity_or_missing_native_compaction_refuses_completion(self):
        for cuts in ([], [2]):
            with self.subTest(cuts=cuts), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                output, _, corpus_path, config, question = self.fixture(root)
                if cuts:
                    question['question'] = '[Session Date: 2024/01/01 (Mon) 00:00]\nearlier synthetic turn 0'
                with self.assertRaises(ValueError):
                    snapshots.generate_question(output, config, 'fixture-run', question, corpus_path,
                        worker_runner=self.synthetic_worker(cuts, []))


if __name__ == '__main__':
    unittest.main()
