"""Offline release materials: frozen bytes, coverage and machine/human separation."""
import hashlib
import json
from pathlib import Path
import unittest

ARCHIVE = Path(__file__).resolve().parents[1] / 'benchmark/archive/release-0.1.0'


class ReleaseBenchmarkArchive(unittest.TestCase):
    def test_original_hashes_and_complete_run_bindings(self):
        manifest = json.loads((ARCHIVE / 'manifest.json').read_text())
        inventory = {row['path']: row for row in manifest['files']}
        self.assertEqual(len(inventory), len(manifest['files']))
        for name, row in inventory.items():
            with self.subTest(artifact=name):
                path = ARCHIVE / name
                self.assertTrue(path.resolve().is_relative_to(ARCHIVE.resolve()))
                self.assertFalse(path.is_symlink())
                raw = path.read_bytes()
                self.assertEqual(len(raw), row['bytes'])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), row['sha256'])
                if row['kind'] in ('answer', 'strict-judgment', 'graded-judgment'):
                    self.assertTrue(row['source'].endswith('/result.json'))
        self.assertEqual(len(manifest['runs']), 7)
        for run in manifest['runs']:
            expected = 8 if run['dataset'] == 'swe-chat8' else 16
            self.assertEqual(len(set(run['selected'])), expected)
            answers, strict, graded = {}, {}, {}
            for name in run['artifacts']:
                row = inventory[name]
                value = json.loads((ARCHIVE / name).read_text())
                qid = value['question_id']
                self.assertIn(qid, run['selected'])
                if row['kind'] == 'answer':
                    self.assertNotIn(qid, answers)
                    answers[qid] = (value, row)
                elif row['kind'] == 'strict-judgment':
                    strict[value['judgeName'], qid] = value
                else:
                    graded[value['judgeName'], qid] = value
            self.assertEqual(set(answers), set(run['selected']))
            self.assertEqual(len(strict), 2 * expected)
            self.assertEqual(len(graded), 2 * expected)
            for label in ('luna', 'sol'):
                correct = strict_scored = graded_scored = score = 0
                for qid, (answer, row) in answers.items():
                    self.assertEqual(answer['outcome'], 'answered')
                    self.assertIsInstance(answer['answer'], str)
                    for verdict in (strict[label, qid], graded[label, qid]):
                        self.assertIn(verdict['status'], ('graded', 'judge-error'))
                        self.assertEqual(verdict['originalResultSha256'], row['sha256'])
                    if strict[label, qid]['status'] == 'graded':
                        strict_scored += 1
                        correct += strict[label, qid]['verdict']['correct']
                    else:
                        self.assertIsNone(strict[label, qid]['verdict'])
                    if graded[label, qid]['status'] == 'graded':
                        graded_scored += 1
                        score += graded[label, qid]['verdict']['score']
                    else:
                        self.assertIsNone(graded[label, qid]['verdict'])
                self.assertEqual(correct, run['summary']['strict'][label]['correct'])
                self.assertEqual(score, run['summary']['graded'][label]['totalScore'])
                self.assertEqual(strict_scored, run['summary']['strict'][label]['scored'])
                self.assertEqual(graded_scored, run['summary']['graded'][label]['scored'])

    def test_swe_native_selection_and_manual_review_remain_separate(self):
        material = ARCHIVE / 'swe-chat8/en/material'
        binding = json.loads((material / 'native-bindings.compact.json').read_text())
        self.assertEqual(len(binding['records']), 6)
        self.assertEqual(len({r['family'] for r in binding['records']}), 4)
        review = json.loads((material / 'sw08-human-review.json').read_text())
        self.assertTrue(review['accepted'])
        self.assertTrue(review['machineResultsUnchanged'])
        answer = (ARCHIVE / review['originalAnswer']).read_bytes()
        self.assertEqual(hashlib.sha256(answer).hexdigest(), review['originalAnswerSha256'])
        self.assertIn('9ae87932b', json.loads(answer)['answer'])
        for row in review['machineStrict'].values():
            self.assertEqual((row['correct'], row['scored']), (7, 8))


if __name__ == '__main__':
    unittest.main()
