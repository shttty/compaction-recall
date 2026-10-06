"""Capacity rejection stops retries; transient provider failure retains its bound."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1] / 'benchmark/coding-recall/e2e'
spec = importlib.util.spec_from_file_location('capacity_retry_runner', HERE / 'round2-run.py')
runner = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(HERE))
try:
    spec.loader.exec_module(runner)
finally:
    sys.path.pop(0)


class CapacityRetry(unittest.TestCase):
    def exercise(self, outcomes):
        records = [dict(outcome=outcome, providerError=error, answerWallMs=1,
                        toolTimeoutErrors=0, providerTimeout=False,
                        tokens=dict(input=0, output=0, cacheRead=0, cacheWrite=0))
                   for outcome, error in outcomes]
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runner, 'answer_attempt', side_effect=records) as attempts, \
                patch.object(runner.common, 'durable_phase', side_effect=lambda d, n, i, operation: operation()), \
                patch.object(runner.time, 'sleep'):
            result = runner.answer_one(Path(directory), {}, {},
                                       {'fingerprint': 'synthetic', 'preflight': {'test': {'sha256': 'synthetic'}}},
                                       {'id': 'synthetic'}, 'test', stop_retry=runner.common.capacity_error)
            return attempts.call_count, result

    def test_capacity_rejection_is_not_retried(self):
        count, result = self.exercise([('model-error', 'context_length_exceeded')] * 3)
        self.assertEqual(count, 1)
        self.assertEqual(result['outcome'], 'model-error')
        self.assertEqual(len(result['attempts']), 1)

    def test_transient_failure_can_recover_on_third_attempt(self):
        count, result = self.exercise([('model-error', '429 rate limit: tokens per minute quota'),
                                       ('model-error', '503 temporarily unavailable'),
                                       ('answered', None)])
        self.assertEqual(count, 3)
        self.assertEqual(result['outcome'], 'answered')
        self.assertEqual(result['recoveredProviderRetries'], 2)


if __name__ == '__main__':
    unittest.main()
