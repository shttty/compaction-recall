import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundIndex } from '../benchmark/archive/js-runtime/background-index.mjs'
import { StageTiming } from '../src/timing.mjs';
import { initialBranch, msg } from './corpus.mjs';

function memoryDestination(t) {
  const saved = process.env.COMPACTION_RECALL_TIMING_FILE;
  const home = mkdtempSync(join(tmpdir(), 'index-memory-'));
  const file = join(home, 'timing.jsonl');
  process.env.COMPACTION_RECALL_TIMING_FILE = file;
  t.after(() => {
    if (saved === undefined) delete process.env.COMPACTION_RECALL_TIMING_FILE; else process.env.COMPACTION_RECALL_TIMING_FILE = saved;
    rmSync(home, { recursive: true, force: true });
  });
  return file;
}

function captureSettledTimers(t) {
  const original = globalThis.setTimeout;
  const scheduled = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const handle = original(callback, delay, ...args);
    if (delay === 3000) scheduled.push({ handle, run: () => callback(...args) });
    return handle;
  });
  return scheduled;
}

const fields = ['processRssBytes', 'mainHeapUsedBytes', 'mainHeapTotalBytes', 'mainExternalBytes', 'workerHeapBytes', 'workerHeapTotalBytes', 'entries'];

test('real worker emits post_build and one unref settled sample after 3000 ms, with complete private JSONL fields', { timeout: 10000 }, async t => {
  const file = memoryDestination(t);
  const scheduled = captureSettledTimers(t);
  const timer = new StageTiming();
  const mark = timer.mark.bind(timer);
  let observedSettled;
  const settled = new Promise(resolve => { observedSettled = resolve; });
  t.mock.method(timer, 'mark', (stage, values) => {
    mark(stage, values);
    if (stage === 'index_memory' && values.phase === 'settled') observedSettled();
  });
  const index = new BackgroundIndex({ timer });
  try {
    await index.prepare(initialBranch([msg('a', 'quasar observation')]));
    const immediate = timer.events.filter(event => event.stage === 'index_memory');
    assert.equal(immediate.length, 1);
    assert.equal(immediate[0].phase, 'post_build');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].handle.hasRef(), false);
    const deadlineStart = performance.now();
    timer.flush(file);
    await settled;
    assert.ok(performance.now() - deadlineStart >= 2900);
    await new Promise(resolve => setImmediate(resolve));
    const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(event => event.stage === 'index_memory');
    assert.deepEqual(records.map(event => event.phase), ['post_build', 'settled']);
    for (const record of records) {
      for (const field of fields) assert.ok(Number.isFinite(record[field]) && record[field] >= 0, field);
      assert.equal(record.entries, 1);
      assert.ok(record.mainHeapTotalBytes >= record.mainHeapUsedBytes);
      assert.ok(record.workerHeapTotalBytes >= record.workerHeapBytes);
      assert.ok(Number.isFinite(record.workerExternalBytes) && record.workerExternalBytes >= 0);
      assert.equal(Object.hasOwn(record, 'query'), false);
    }
    assert.equal(index.memoryTimers.size, 0);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    console.log('SETTLED_MEMORY_MARK', JSON.stringify(records[1]));
  } finally { await index.dispose(); }
});

test('disposed worker skips a late settled callback without heap API calls, new marks or errors', async t => {
  memoryDestination(t);
  const scheduled = captureSettledTimers(t);
  const timer = new StageTiming();
  let heapReads = 0;
  const index = new BackgroundIndex({
    timer, workerFactory: () => {
      const worker = new Worker(new URL('../benchmark/archive/js-runtime/index-worker.mjs', import.meta.url));
      const getHeapStatistics = worker.getHeapStatistics.bind(worker);
      worker.getHeapStatistics = () => { heapReads++; return getHeapStatistics(); };
      return worker;
    }
  });
  try {
    await index.prepare(initialBranch([msg('a', 'quasar')]));
    assert.equal(scheduled.length, 1);
    assert.equal(heapReads, 1);
    await index.dispose();
    assert.equal(index.memoryTimers.size, 0);
    const marks = timer.events.length;
    scheduled[0].run();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(heapReads, 1);
    assert.equal(timer.events.length, marks);
  } finally { await index.dispose(); }
});

test('an explicit timer without an effective timing file creates no settled timeout or new memory marks', async t => {
  const saved = process.env.COMPACTION_RECALL_TIMING_FILE;
  delete process.env.COMPACTION_RECALL_TIMING_FILE;
  const scheduled = captureSettledTimers(t);
  const timer = new StageTiming();
  const index = new BackgroundIndex({ timer });
  try {
    const branch = initialBranch([msg('a', 'quasar')]);
    await index.prepare(branch);
    await index.query('quasar', branch);
    assert.equal(scheduled.length, 0);
    assert.equal(index.memoryTimers, undefined);
    assert.equal(timer.events.some(event => event.stage === 'index_memory'), false);
    assert.ok(timer.events.some(event => event.stage === 'background_index_ready' && typeof event.workerHeapBytes === 'number'));
  } finally {
    await index.dispose();
    if (saved === undefined) delete process.env.COMPACTION_RECALL_TIMING_FILE; else process.env.COMPACTION_RECALL_TIMING_FILE = saved;
  }
});

test('external fields keep the requested main sum and omit absent worker external_memory', async t => {
  memoryDestination(t);
  const timer = new StageTiming();
  const memoryUsage = process.memoryUsage;
  t.mock.method(process, 'memoryUsage', () => ({ ...memoryUsage(), external: 100, arrayBuffers: 25 }));
  const index = new BackgroundIndex({
    timer, workerFactory: () => {
      const worker = new Worker(new URL('../benchmark/archive/js-runtime/index-worker.mjs', import.meta.url));
      const getHeapStatistics = worker.getHeapStatistics.bind(worker);
      worker.getHeapStatistics = async () => {
        const stats = await getHeapStatistics();
        delete stats.external_memory;
        return stats;
      };
      return worker;
    }
  });
  try {
    await index.prepare(initialBranch([msg('a', 'quasar')]));
    const event = timer.events.find(event => event.stage === 'index_memory');
    assert.equal(event.phase, 'post_build');
    assert.equal(event.mainExternalBytes, 125);
    assert.equal(Object.hasOwn(event, 'workerExternalBytes'), false);
  } finally { await index.dispose(); }
});
