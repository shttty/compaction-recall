"""Synthetic package identity and compaction boundaries; no personal profiles."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

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

    def test_three_compactions_and_extension_takeover_are_required(self):
        entry = {'type': 'compaction', 'summary': 'synthetic summary', 'firstKeptEntryId': 'retained', 'fromHook': True}
        events = [{'fromExtension': True} for _ in range(3)]
        for entries, observed in (([entry] * 2, events[:2]), ([entry] * 4, events + events[:1]),
                                  ([{**entry, 'fromHook': False}] * 3, events),
                                  ([entry] * 3, [{'fromExtension': False}] * 3)):
            with self.subTest(entries=entries, events=observed), self.assertRaises(ValueError):
                compression.validate_compactions(entries, observed)
        self.assertEqual([row['summary'] for row in compression.validate_compactions([entry] * 3, events)], ['synthetic summary'] * 3)

    def test_external_absolute_snapshot_is_hash_bound_and_relative_escape_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            session = root / 'external.jsonl'
            rows = [{'type': 'session', 'id': 'synthetic'}, *[
                {'type': 'compaction', 'id': str(stage), 'summary': 'old synthetic history', 'firstKeptEntryId': 'old'}
                for stage in range(3)]]
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
                                 'firstKeptEntryId': 'm0', 'fromHook': True})
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
            session.write_bytes(native_path.read_bytes()); source_path.write_bytes(native_path.read_bytes())
            (folder / 'compaction-events.jsonl').write_text(''.join(json.dumps({'fromExtension': True}) + '\n' for _ in range(3)))
            cuts = [0, 1, 2, 3, 4]
            phase = common.object_sha({'run': fingerprint, 'qid': 'q', 'source': common.sha(source_path), 'cuts': cuts})
            saved = common.durable_phase(folder, 'snapshot', phase, lambda: {
                'path': str(session), 'sha256': common.sha(session), 'sourcePath': str(source_path), 'sourceSha256': common.sha(source_path),
                'cuts': cuts, 'compactions': [{'stage': n, 'seconds': n, 'contextBefore': {'estimatedTokens': n * 10},
                                             'contextAfter': {'estimatedTokens': n}} for n in range(1, 4)]})
            common.write_json(output / 'manifest.json', {'identity': identity, 'fingerprint': fingerprint, 'state': 'serialization-complete',
                'arms': ['package'], 'questions': [question], 'selected': ['q'], 'snapshots': {'pi/q': saved}, 'completed': [], 'failures': {}})
            result = reporter.write_report(output)
            self.assertEqual(result['performance']['compactionSeconds'], {'count': 3, 'median': 2, 'max': 3})
            session.write_text(session.read_text().replace('synthetic summary', 'changed summary'))
            with self.assertRaisesRegex(ValueError, 'Package snapshot changed'):
                reporter.write_report(output)

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
