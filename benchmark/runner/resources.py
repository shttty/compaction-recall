"""Whole-run cgroup, concurrency, capacity stop, and persisted resource ledgers."""
import json
from pathlib import Path
import threading
from runner import artifacts as common
from runner import sdk

MEMORY_MAX = 14 * 1024 ** 3


def whole_scope():
    relative = next(line.split('::', 1)[1] for line in Path('/proc/self/cgroup').read_text().split('\n') if line.startswith('0::'))
    directory = Path('/sys/fs/cgroup') / relative.lstrip('/')
    if int((directory / 'memory.max').read_text()) != MEMORY_MAX or int((directory / 'memory.swap.max').read_text()) != 0:
        raise ValueError('Entire runner must inherit one MemoryMax=14G / MemorySwapMax=0 scope')
    return directory


class RunResources:
    def __init__(self, output, manifest, workers, scope):
        self.output, self.manifest, self.workers, self.scope = output, manifest, workers, scope
        self.arm = manifest['arms'][0]
        self.capacity_stop = threading.Event()
        if manifest.get('capacityRejection'):
            self.capacity_stop.set()
        self.lock = threading.RLock()
        previous = json.loads((output / 'resource.json').read_text()) if (output / 'resource.json').exists() else {}
        self.gauges = {'activeQuestions': 0, 'peakActiveQuestions': previous.get('peakActiveQuestions', 0),
                       'activeRpcSessions': 0, 'peakActiveRpcSessions': previous.get('peakActiveRpcSessions', 0),
                       'phaseCounts': dict(previous.get('phaseCounts', {})), 'phaseActive': {},
                       'phasePeaks': dict(previous.get('phasePeaks', {}))}
        self.slots = threading.BoundedSemaphore(workers)

    def persist(self):
        with self.lock:
            output, manifest, scope = self.output, self.manifest, self.scope
            common.write_json(output / 'manifest.json', manifest)
            answers, judges = [], []
            for qid in manifest['selected']:
                path = output / 'results' / self.arm / qid / 'result.json'
                if path.exists(): answers.append(json.loads(path.read_text()))
                for label in ('luna', 'sol'):
                    path = output / 'judge-v2' / label / self.arm / qid / 'result.json'
                    if path.exists(): judges.append(json.loads(path.read_text()))
            common.write_json(output / 'answer-ledger.json', {'fingerprint': manifest['fingerprint'], 'records': answers})
            common.write_json(output / 'judge-v2/ledger.json', {'fingerprint': manifest['fingerprint'], 'records': judges})
            launch_path = output / 'launch.json'
            launch = json.loads(launch_path.read_text()) if launch_path.is_file() else None
            resource = {'cgroupPath': str(scope), 'scopeName': scope.name,
                        'memoryMaxBytes': MEMORY_MAX, 'swapMaxBytes': 0, 'memoryPeakBytes': int((scope / 'memory.peak').read_text()),
                        'workers': self.workers, 'maxConcurrentSessions': self.workers, 'state': manifest['state'], **self.gauges,
                        'launch': launch, 'launchPath': str(launch_path), 'launchKnown': launch is not None,
                        'measurementSources': {'memoryPeakBytes': str(scope / 'memory.peak'),
                                              'activeQuestions': 'case entry/finally', 'activeRpcSessions': 'shared scoped_rpc entry/finally',
                                              'launch': str(launch_path) + ' (parent-authored; unknown until present)'}}
            common.write_json(output / 'resource.json', resource)
            common.write_json(output / 'progress.json', {**resource, 'fingerprint': manifest['fingerprint'],
                         'completed': list(manifest['completed']), 'failures': dict(manifest['failures'])})

    def stop_capacity_retry(self, record):
        message = common.capacity_error(record)
        if message is None:
            return False
        with self.lock:
            self.manifest.setdefault('capacityRejection', {'id': record['question_id'], 'message': common.safe_error(message),
                                                         'rawSession': record.get('session'), 'sessionSha256': record.get('sessionSha256')})
            self.capacity_stop.set()
            self.persist()
        return True

    def enter_question(self, qid):
        if qid in self.manifest['failures'] or qid in self.manifest['completed']:
            return False
        with self.lock:
            if self.capacity_stop.is_set():
                return False
            self.gauges['activeQuestions'] += 1
            self.gauges['peakActiveQuestions'] = max(self.gauges['peakActiveQuestions'], self.gauges['activeQuestions'])
            self.persist()
        return True

    def leave_question(self):
        with self.lock:
            self.gauges['activeQuestions'] -= 1
            self.persist()

    def measured_rpc(self, command, env, directory, **kwargs):
        phase = command[command.index('--phase') + 1]
        if Path(directory).name == 'serialization': phase = 'serialization'
        with self.slots:
            with self.lock:
                gauges = self.gauges
                gauges['activeRpcSessions'] += 1
                gauges['peakActiveRpcSessions'] = max(gauges['peakActiveRpcSessions'], gauges['activeRpcSessions'])
                gauges['phaseCounts'][phase] = gauges['phaseCounts'].get(phase, 0) + 1
                gauges['phaseActive'][phase] = gauges['phaseActive'].get(phase, 0) + 1
                gauges['phasePeaks'][phase] = max(gauges['phasePeaks'].get(phase, 0), gauges['phaseActive'][phase])
                self.persist()
            try:
                return sdk.plain_rpc(command, env, directory, **kwargs)
            finally:
                with self.lock:
                    gauges['activeRpcSessions'] -= 1
                    gauges['phaseActive'][phase] -= 1
                    self.persist()
