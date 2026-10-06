"""Public provenance integrity, score separation and external-input boundaries."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'benchmark/archive/release-0.1.0'
RUNNER = ARCHIVE / 'source/latest-used/benchmark/coding-recall/e2e'


class ReleaseBenchmarkArchive(unittest.TestCase):
    def test_public_inventory_sources_and_score_bindings(self):
        manifest = json.loads((ARCHIVE / 'manifest.json').read_text())
        inventory = {row['path']: row for row in manifest['publicFiles']}
        self.assertEqual(len(inventory), len(manifest['publicFiles']))
        for name, row in inventory.items():
            with self.subTest(artifact=name):
                path = ARCHIVE / name
                self.assertTrue(path.resolve().is_relative_to(ARCHIVE.resolve()))
                self.assertFalse(path.is_symlink())
                raw = path.read_bytes()
                self.assertEqual(len(raw), row['bytes'])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), row['sha256'])
        sources = manifest['sources']
        self.assertFalse(sources['longMemEval']['cleanedReleaseUsed'])
        self.assertEqual(sources['sweChat']['questionOrigin'], 'locally-derived-not-upstream-question-set')
        for source in sources.values():
            self.assertTrue(source['datasetUrl'].startswith('https://'))
            self.assertIn('license', source)
        self.assertEqual(len(manifest['runs']), 7)
        for run in manifest['runs']:
            with self.subTest(run=run['id']):
                expected = 8 if run['dataset'] == 'swe-chat8' else 16
                self.assertEqual(len(set(run['selected'])), expected)
                self.assertEqual({case['question_id'] for case in run['cases']}, set(run['selected']))
                self.assertEqual(len(run['cases']), expected)
                self.assertTrue(run['candidate'])
                self.assertTrue(run['models'])
                self.assertTrue(run['promptHashes'])
                for label in ('luna', 'sol'):
                    correct = strict_scored = graded_scored = score = 0
                    for case in run['cases']:
                        self.assertEqual(case['outcome'], 'answered')
                        self.assertNotIn('answer', case)
                        verdicts = case['judgments'][label]
                        for verdict in verdicts.values():
                            self.assertEqual(verdict['originalResultSha256'], case['answerFileSha256'])
                            self.assertIn(verdict['status'], ('graded', 'judge-error'))
                            if verdict['status'] == 'judge-error':
                                self.assertIsNone(verdict['verdict'])
                                self.assertTrue(verdict['failureKind'])
                            self.assertNotIn('reason', verdict)
                        strict, graded = verdicts['strict'], verdicts['graded']
                        if strict['status'] == 'graded':
                            self.assertLessEqual(set(strict['verdict']), {'correct', 'hedged', 'guess'})
                            strict_scored += 1
                            correct += strict['verdict']['correct']
                        if graded['status'] == 'graded':
                            self.assertEqual(set(graded['verdict']), {'score'})
                            graded_scored += 1
                            score += graded['verdict']['score']
                    self.assertEqual(correct, run['summary']['strict'][label]['correct'])
                    self.assertEqual(strict_scored, run['summary']['strict'][label]['scored'])
                    self.assertEqual(score, run['summary']['graded'][label]['totalScore'])
                    self.assertEqual(graded_scored, run['summary']['graded'][label]['scored'])

    def test_chinese_translations_are_bound_to_original_ids_and_frozen_bytes(self):
        manifest = json.loads((ARCHIVE / 'manifest.json').read_text())
        rows = manifest['chineseTranslations']
        self.assertEqual(len(rows), 16)
        selected = next(run['selected'] for run in manifest['runs'] if run['language'] == 'zh')
        self.assertEqual({row['questionId'] for row in rows}, set(selected))
        for row in rows:
            value = json.loads((ARCHIVE / row['path']).read_text())
            self.assertEqual(value['question_id'], row['questionId'])
            self.assertEqual(value['source']['questionId'], row['questionId'])
            self.assertEqual(value['source']['datasetRevision'], manifest['sources']['longMemEval']['datasetRevision'])
            self.assertEqual(hashlib.sha256(value['question'].encode()).hexdigest(), row['textUtf8Sha256'])
            self.assertEqual(value['originalAssetSha256'], row['originalAssetSha256'])
            self.assertEqual(value['translation']['model'], 'deepseek-flash')
            self.assertNotIn('question_en', value)
            self.assertNotIn('answer', value)

    def test_swe_native_selection_and_manual_review_remain_separate(self):
        manifest = json.loads((ARCHIVE / 'manifest.json').read_text())
        records = manifest['sweSourcePool']
        self.assertEqual(len(records), 6)
        self.assertEqual(len({record['family'] for record in records}), 4)
        self.assertEqual(manifest['sweSelection']['newCompressionCalls'], 0)
        self.assertEqual(manifest['sweSelection']['providerCallsBeforeFreeze'], 0)
        self.assertTrue(manifest['sweAuthorshipEvidence'])
        review = manifest['humanReview']
        self.assertTrue(review['accepted'])
        self.assertTrue(review['machineResultsUnchanged'])
        run = next(run for run in manifest['runs'] if run['id'] == review['run'])
        answer = next(case for case in run['cases'] if case['question_id'] == review['questionId'])
        self.assertEqual(answer['answerFileSha256'], review['originalAnswerSha256'])
        for label, row in review['machineStrict'].items():
            self.assertEqual((row['correct'], row['scored']), (7, 8))
            self.assertEqual(row, run['summary']['strict'][label])
            self.assertFalse(answer['judgments'][label]['strict']['verdict']['correct'])

    def test_runners_reject_missing_external_inputs_before_runtime_or_output(self):
        flags = {
            'lme-zh-run.py': ('config', 'luna-config', 'sol-config', 'candidate', 'pins', 'preflight', 'data-root'),
            'run-swechat.py': ('config', 'luna-config', 'sol-config', 'tool-definition-manifest', 'data-root', 'candidate-root'),
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / 'fixture.json'
            fixture.write_text('{}')
            for runner, names in flags.items():
                for missing in ('config', 'data-root'):
                    with self.subTest(runner=runner, missing=missing):
                        out = root / f'{runner}-{missing}-output'
                        command = [sys.executable, str(RUNNER / runner), '--output', str(out), '--commit', '0' * 40, '--task', 'offline-fixture']
                        if runner == 'lme-zh-run.py':
                            command += ['--archive-sha256', '0' * 64]
                        for name in names:
                            path = root / 'absent' if name == missing else root if name.endswith('root') else fixture
                            command += ['--' + name, str(path)]
                        result = subprocess.run(command, cwd=ROOT, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True, timeout=30)
                        self.assertEqual(result.returncode, 2, result.stderr)
                        self.assertIn(f'missing external input --{missing}:', result.stderr)
                        self.assertNotIn('Traceback', result.stderr)
                        self.assertFalse(out.exists())


if __name__ == '__main__':
    unittest.main()
