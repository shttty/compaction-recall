"""Capacity rejection stops retries; transient provider failure retains its bound."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[3] / 'benchmark'
spec = importlib.util.spec_from_file_location('capacity_retry_runner', HERE / 'runner/phases.py')
runner = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(HERE))
from runner import sdk
try:
    spec.loader.exec_module(runner)
finally:
    sys.path.pop(0)


class CapacityRetry(unittest.TestCase):
    def exercise(self, outcomes):
        model = {'provider': 'synthetic', 'model': 'test-model'}
        config = {'answer': model}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            snapshot = output / 'snapshot.jsonl'
            snapshot.write_text(json.dumps({'type': 'session', 'version': 3, 'id': 'synthetic'}) + '\n')
            evidence = output / 'tools.json'
            evidence.write_text('{}')
            arm = 'pi-native'
            manifest = {'fingerprint': 'synthetic',
                        'toolEvidence': {arm: {'path': str(evidence), 'sha256': runner.common.sha(evidence)}},
                        'snapshots': {'pi/synthetic': {'path': str(snapshot)}}}
            question = {'id': 'synthetic', 'question': 'Synthetic retry evidence?', 'question_date': '2024/01/01 00:00'}
            pending = iter(outcomes)
            calls = []
            def provider(command, env, folder, *, prompt, **kwargs):
                outcome, error = next(pending)
                calls.append(outcome)
                session = Path(command[command.index('--session') + 1])
                assistant = {'role': 'assistant', **model,
                             'stopReason': 'error' if outcome == 'model-error' else 'stop',
                             'content': [{'type': 'text', 'text': '' if error else 'Synthetic recovered answer'}],
                             'usage': {'input': 1, 'output': 1, 'cacheRead': 0, 'cacheWrite': 0}}
                if error:
                    assistant['errorMessage'] = error
                rows = [{'type': 'message', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': prompt}]}},
                        {'type': 'message', 'message': assistant}]
                with session.open('a') as stream:
                    stream.write(''.join(json.dumps(row) + '\n' for row in rows))
                (folder / 'tools.json').write_text('{}')
                return {'outcome': 'completed', 'rc': 0, 'timing': {}}
            with patch.object(runner.common, 'CONFIG', config), patch.object(runner.time, 'sleep'):
                result = runner.answer_one(output, config, {}, manifest, question, arm,
                    command_factory=sdk.answer_command, stop_retry=runner.common.capacity_error, rpc_runner=provider)
            return len(calls), result

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
