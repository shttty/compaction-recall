"""Synthetic package identity and compaction boundaries; no personal profiles."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[3] / 'benchmark'
sys.path.insert(0, str(HERE))
from runner import compression, prepare


class PackageBoundaries(unittest.TestCase):
    def package(self, root, pi=None):
        source, output = root / 'input', root / 'output'
        source.mkdir(); output.mkdir()
        (source / 'package.json').write_text(json.dumps({'name': 'synthetic-package', 'pi': pi or {'extensions': ['./extension.mjs']}}))
        (source / 'extension.mjs').write_text('export default function() {}\n')
        return source, output

    def test_package_rejects_undeclared_extensions(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.package(Path(temporary), {'skills': []})
            with self.assertRaisesRegex(ValueError, 'pi.extensions'):
                prepare.freeze_package(source, output)

    def test_package_recovery_rejects_source_and_frozen_dependency_drift(self):
        for target in ('input', 'output/package'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, output = self.package(root)
                dependency = source / 'node_modules/runtime'
                dependency.mkdir(parents=True)
                (dependency / 'package.json').write_text('{"name":"runtime","version":"1"}')
                (dependency / 'index.mjs').write_text('export const value = 1;\n')
                prepare.freeze_package(source, output)
                drift = root / target / 'node_modules/runtime/index.mjs'
                drift.chmod(0o600)
                drift.write_text('export const value = 2;\n')
                with self.assertRaisesRegex(ValueError, '(identity|hash) changed|hash/inventory changed'):
                    prepare.freeze_package(source, output)

    def test_multiple_packages_freeze_ordered_independent_trees_and_reject_drift(self):
        for drift in ('source', 'frozen', 'order', 'removal'):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, output = self.package(root)
                second = root / 'second'
                second.mkdir()
                (second / 'package.json').write_text(json.dumps({'pi': {'extensions': ['./entry.mjs']}}))
                (second / 'entry.mjs').write_text('export default pi => pi.on("context", () => {});\n')
                sources = [second, source]
                frozen = prepare.freeze_packages(sources, output)['packages']
                self.assertEqual([item['sourceRoot'] for item in frozen], [str(second), str(source)])
                for item in frozen:
                    self.assertEqual(prepare.package_inventory(Path(item['path']))[0], item['filesSha256'])
                    self.assertEqual(item['treeSha256'], prepare.common.object_sha({
                        'files': item['filesSha256'], 'symlinks': item['symlinks']}))
                self.assertEqual(prepare.freeze_packages(sources, output)['packages'], frozen)
                if drift in ('source', 'frozen'):
                    target = second if drift == 'source' else Path(frozen[0]['path'])
                    entry = target / 'entry.mjs'
                    entry.chmod(0o600)
                    entry.write_text('export default () => {};\n')
                elif drift == 'order':
                    sources.reverse()
                else:
                    sources.pop()
                with self.assertRaisesRegex(ValueError, 'changed'):
                    prepare.freeze_packages(sources, output)

    def test_package_requires_installed_declared_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.package(Path(temporary))
            (source / 'package.json').write_text(json.dumps({'pi': {'extensions': ['./extension.mjs']}, 'dependencies': {'absent': '1'}}))
            with self.assertRaisesRegex(ValueError, 'dependencies must be installed'):
                prepare.freeze_package(source, output)

    def test_declared_resource_cannot_escape_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = self.package(root, {'extensions': ['../other.mjs']})
            (root / 'other.mjs').write_text('export default function() {}\n')
            with self.assertRaisesRegex(ValueError, 'escapes package'):
                prepare.freeze_package(source, output)

    def test_variable_compactions_require_ordered_cuts_and_extension_takeover(self):
        for count in (1, 2, 5):
            entries = [{'type': 'compaction', 'id': f'package-{stage}', 'summary': 'synthetic summary',
                        'firstKeptEntryId': 'retained', 'fromHook': True} for stage in range(count)]
            events = [{'fromExtension': True, 'compactionEntry': entry} for entry in entries]
            with self.subTest(count=count):
                self.assertEqual(compression.validate_compactions(entries, events), entries)
        for cuts, total in (([], 5), ([1, 1], 5), ([3, 2], 5), ([0], 5)):
            with self.subTest(cuts=cuts), self.assertRaises(ValueError):
                compression.cut_boundaries(cuts, total)
        entry = {'type': 'compaction', 'id': 'package-1', 'summary': 'synthetic summary',
                 'firstKeptEntryId': 'retained', 'fromHook': True}
        event = {'fromExtension': True, 'compactionEntry': entry}
        invalid = (([], []), ([entry], []), ([entry, entry], [event]),
                   ([entry], [event, event]),
                   ([{**entry, 'fromHook': False}], [event]),
                   ([entry], [{**event, 'fromExtension': False}]),
                   ([entry], [{**event, 'compactionEntry': {**entry, 'id': 'wrong'}}]))
        for entries, events in invalid:
            with self.subTest(entries=entries, events=events), self.assertRaises(ValueError):
                compression.validate_compactions(entries, events)

    def test_native_snapshots_need_genuine_nonempty_increasing_compactions(self):
        session = {'type': 'session', 'id': 'native'}
        message = {'type': 'message', 'id': 'm1', 'message': {'role': 'user', 'content': []}}
        entry = {'type': 'compaction', 'id': 'c1', 'summary': 'native summary', 'firstKeptEntryId': 'm1'}
        self.assertEqual(prepare.native_compaction_cuts([session, message, entry]), [1])
        invalid = ([session, message], [session, message, entry, {**entry, 'id': 'c2'}],
                   [session, message, {**entry, 'fromHook': True}],
                   [session, message, {**entry, 'id': 'blind-simulated-c1'}],
                   [session, message, {**entry, 'summary': '  '}])
        for rows in invalid:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                prepare.native_compaction_cuts(rows)

    def test_external_absolute_snapshot_is_hash_bound_and_relative_escape_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            session = root / 'external.jsonl'
            rows = [{'type': 'session', 'id': 'synthetic'},
                    {'type': 'message', 'id': 'm0', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'old history'}]}},
                    {'type': 'compaction', 'id': 'c0', 'summary': 'old synthetic history', 'firstKeptEntryId': 'm0'}]
            session.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            question = {'id': 'q', 'question': 'evaluation question', 'question_date': '2024/01/01', 'language': 'en'}
            identity = {'config': {'compression': {'provider': 'synthetic', 'model': 'synthetic', 'effort': 'off'}}}
            manifest = {'identity': identity, 'fingerprint': prepare.common.object_sha(identity), 'state': 'complete',
                        'questions': [question], 'snapshots': {'pi/q': {'path': str(session), 'sha256': prepare.common.sha(session)}}}
            manifest_path = source / 'manifest.json'
            manifest_path.write_text(json.dumps(manifest))
            bound, _ = prepare.bind_snapshots(source, root / 'output', [question], 'LME16-English')
            self.assertEqual(bound['pi/q']['path'], str(session))
            manifest['snapshots']['pi/q']['path'] = '../external.jsonl'
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'Relative snapshot session escapes'):
                prepare.bind_snapshots(source, root / 'output', [question], 'LME16-English')
            manifest['snapshots']['pi/q']['path'] = str(session)
            manifest_path.write_text(json.dumps(manifest))
            session.write_text(session.read_text().replace('old synthetic history', 'changed synthetic history'))
            with self.assertRaisesRegex(ValueError, 'Snapshot source changed'):
                prepare.bind_snapshots(source, root / 'output', [question], 'LME16-English')

    def test_generated_snapshot_reports_from_receipts_and_rejects_content_drift(self):
        common = prepare.common
        reporter = common.module('package_report_boundary', HERE / 'report.py')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = root / 'native', root / 'output'
            source.mkdir(); output.mkdir()
            question = {'id': 'q', 'question': 'evaluation question', 'question_date': '2024/01/01',
                        'language': 'en', 'subset': 'dev8'}
            rows = [{'type': 'session', 'id': 'synthetic'}]
            for stage in range(4):
                rows.append({'type': 'message', 'id': 'm' + str(stage),
                             'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'synthetic history'}]}})
                if stage < 3:
                    rows.append({'type': 'compaction', 'id': 'c' + str(stage), 'summary': 'synthetic summary',
                                 'firstKeptEntryId': 'm0'})
            native_path = source / 'native.jsonl'
            native_path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            native_identity = {'config': {'compression': {'provider': 'synthetic', 'model': 'synthetic', 'effort': 'off'}}}
            common.write_json(source / 'manifest.json', {'identity': native_identity, 'fingerprint': common.object_sha(native_identity),
                'state': 'complete', 'questions': [question], 'snapshots': {'pi/q': {'path': str(native_path), 'sha256': common.sha(native_path)}}})
            native, binding = prepare.bind_snapshots(source, output, [question], 'LME16-English')
            identity = {'arm': 'package', 'dataset': 'LME16-English', 'compressionMode': 'package', 'inputs': {},
                        'snapshotSource': binding, 'snapshotsSha256': common.object_sha(native), 'questionsSha256': common.object_sha([question])}
            fingerprint = common.object_sha(identity)
            folder = output / 'compression/q'
            folder.mkdir(parents=True)
            session, source_path = folder / 'session.jsonl', folder / 'source.jsonl'
            package_rows = [{**row, 'fromHook': True} if row.get('type') == 'compaction' else row for row in rows]
            entries = [row for row in package_rows if row.get('type') == 'compaction']
            source_rows = [rows[0], *[row for row in rows if row.get('type') == 'message']]
            session.write_text(''.join(json.dumps(row) + '\n' for row in package_rows))
            source_path.write_text(''.join(json.dumps(row) + '\n' for row in source_rows))
            events = [{'fromExtension': True, 'compactionEntry': entry} for entry in entries]
            (folder / 'compaction-events.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in events))
            cuts = [0, 1, 2, 3, 4]
            phase = common.object_sha({'run': fingerprint, 'qid': 'q', 'source': common.sha(source_path), 'cuts': cuts})
            saved = common.durable_phase(folder, 'snapshot', phase, lambda: {
                'path': str(session), 'sha256': common.sha(session), 'sourcePath': str(source_path), 'sourceSha256': common.sha(source_path),
                'cuts': cuts, 'modelRequests': 0, 'compactions': [{'stage': n, 'cut': n, 'seconds': n, 'contextBefore': {'estimatedTokens': n * 10},
                                             'contextAfter': {'estimatedTokens': n}} for n in range(1, 4)]})
            common.write_json(output / 'manifest.json', {'identity': identity, 'fingerprint': fingerprint, 'state': 'serialization-complete',
                'arms': ['package'], 'questions': [question], 'selected': ['q'], 'snapshots': {'pi/q': saved}, 'completed': [], 'failures': {}})
            result = reporter.write_report(output)
            self.assertEqual(result['performance']['compactionSeconds'], {'count': 3, 'median': 2, 'max': 3})
            session.write_text(session.read_text().replace('synthetic summary', 'changed summary'))
            with self.assertRaisesRegex(ValueError, 'Package snapshot changed'):
                reporter.write_report(output)

    def test_package_replays_variable_native_cuts_including_final_message(self):
        common = prepare.common
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / 'output'
            native_path = root / 'native.jsonl'
            corpus_path = root / 'data' / 'dev8' / 'q' / 'corpus.json'
            corpus_path.parent.mkdir(parents=True)
            corpus = {'haystack_dates': ['2024/01/01 (Mon) 00:00'],
                      'haystack_sessions': [[{'role': 'user', 'content': f'turn {n}'} for n in range(4)]]}
            corpus_path.write_text(json.dumps(corpus))
            native_rows = [{'type': 'session', 'id': 'native'}]
            native_messages = compression.corpus_projection(corpus)
            native_cuts = (2, len(native_messages))
            for index, (entry_id, role, content, timestamp) in enumerate(native_messages, start=1):
                native_rows.append({'type': 'message', 'id': entry_id,
                                    'message': {'role': role, 'content': content, 'timestamp': timestamp}})
                if index in native_cuts:
                    native_rows.append({'type': 'compaction', 'id': f'native-{index}',
                                        'summary': 'native source summary', 'firstKeptEntryId': entry_id})
            native_path.write_text(''.join(json.dumps(row) + '\n' for row in native_rows))
            native = {'path': str(native_path), 'sha256': common.sha(native_path)}
            question = {'id': 'q', 'language': 'en'}
            identity = {'compressionMode': 'package',
                        'snapshotSource': {'snapshots': {'pi/q': native}},
                        'inputs': {str(corpus_path): common.sha(corpus_path)}}
            manifest = {'identity': identity, 'fingerprint': common.object_sha(identity), 'snapshots': {'pi/q': native}}
            calls = []

            def rpc(command, env, folder, *, request, timeout):
                self.assertEqual((request, timeout), ({'id': 'compact', 'type': 'compact'}, 900))
                number = len(calls) + 1
                rows = common.transcript(folder / 'session.jsonl')
                entry = {'type': 'compaction', 'id': f'package-{number}', 'parentId': rows[-1]['id'],
                         'summary': f'package summary {number}', 'firstKeptEntryId': 'retained', 'fromHook': True}
                with (folder / 'session.jsonl').open('a') as session:
                    session.write(json.dumps(entry) + '\n')
                event = {'fromExtension': True, 'compactionEntry': entry}
                hook = {'fromExtension': True, 'compaction': {'summary': entry['summary'],
                                                               'firstKeptEntryId': entry['firstKeptEntryId']}}
                for name, record in (('compaction-events.jsonl', event), ('compaction-hooks.jsonl', hook)):
                    with (folder / name).open('a') as evidence:
                        evidence.write(json.dumps(record) + '\n')
                calls.append(number)
                return {'rc': 0, 'response': {'success': True}, 'timing': {'processWallMs': 10}}

            with patch.object(compression.sdk, 'package_command', return_value={}), \
                    patch.object(compression.sdk, 'context_estimate', return_value={'estimatedTokens': 10}), \
                    patch.object(compression.common, 'child_env', return_value={}):
                saved = compression.compress(output, {}, {}, manifest, question, rpc_runner=rpc)
            self.assertEqual(calls, [1, 2])
            self.assertEqual(saved['cuts'], [0, 2, len(native_messages)])
            self.assertEqual([item['cut'] for item in saved['compactions']], list(native_cuts))
            self.assertEqual(saved['modelRequests'], 0)

    def test_corpus_chronology_retains_date_markers_and_original_timestamps(self):
        corpus = {'haystack_dates': ['2024/01/02 (Tue) 00:00', '2024/01/01 (Mon) 00:00'],
                  'haystack_sessions': [[{'role': 'user', 'content': 'later'}], [{'role': 'assistant', 'content': 'earlier'}]]}
        actual = compression.corpus_projection(corpus)
        self.assertEqual(actual, [
            ('00000001', 'user', [{'type': 'text', 'text': '[Session Date: 2024/01/01 (Mon) 00:00]'}], 1704067200000),
            ('00000002', 'assistant', [{'type': 'text', 'text': 'earlier'}], 1704067201000),
            ('00000003', 'user', [{'type': 'text', 'text': '[Session Date: 2024/01/02 (Tue) 00:00]\nlater'}], 1704153602000)])


if __name__ == '__main__':
    unittest.main()
