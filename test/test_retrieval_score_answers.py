"""Offline validation of the shared current 1–10 judgment contract."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("score_contract", ROOT / "benchmark/retrieval-score-answers.py")
scorer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scorer)


class ParserTests(unittest.TestCase):
    def test_integer_endpoints(self):
        for score in (1, 10):
            text = json.dumps({"score": score, "reason": "语义正确。"}, ensure_ascii=False)
            self.assertEqual(scorer.parse_score(" \n" + text + "\n"), {"score": score, "reason": "语义正确。"})

    def test_rejects_noncanonical_or_invalid_scores(self):
        invalid = [
            '{"score":true,"reason":"x"}', '{"score":1.0,"reason":"x"}',
            '{"score":0,"reason":"x"}', '{"score":11,"reason":"x"}',
            '{"score":"8","reason":"x"}', '{"score":null,"reason":"x"}',
            '{"score":8}', '{"reason":"x"}', '{"score":8,"reason":"x","extra":0}',
            '{"score":8,"reason":""}', '{"score":8,"reason":"   "}',
            '{"score":8,"reason":"two\\nlines"}', '{"score":8,"reason":3}',
            '```json\n{"score":8,"reason":"x"}\n```',
            'prefix {"score":8,"reason":"x"}', '{"score":8,"reason":"x"} trailing',
            '[{"score":8,"reason":"x"}]', 'null',
        ]
        for text in invalid:
            with self.subTest(text=text), self.assertRaises((ValueError, TypeError)):
                scorer.parse_score(text)


if __name__ == "__main__":
    unittest.main()
