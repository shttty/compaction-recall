import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundIndex } from '../src/background-index.mjs';
import { StageTiming } from '../src/timing.mjs';
import { formatLocatorRows, recallPageFromRows, buildLocator, buildRecallPage } from '../src/locator.mjs';
import { initialBranch, extendedBranch, msg } from './corpus.mjs';
const engineModule = new URL('./fixtures/worker-engine.mjs', import.meta.url);

test('replaceable worker builds, ranks raw queries, propagates errors and awaits disposal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'worker-engine-'));
  const destination = join(home, 'disposed');
  const index = new BackgroundIndex({ engineModule });
  const long = 'prefix '.repeat(12000) + 'needle';
  const initial = initialBranch([msg('a', 'needle first'), msg('long', long), msg('dispose', 'dispose-file:' + destination)]);
  try {
    await index.prepare(initial);
    const auto = await index.queryRanked('needle', initial);
    assert.deepEqual(auto.results.map(row => row.id), ['mlong', 'ma']);
    assert.equal(auto.total, 2);
    const visibleRows = auto.results.map(({ id, date, role, snippet }) => ({ id, date, role, snippet }));
    assert.equal(await index.query('needle', initial), formatLocatorRows(visibleRows));
    const manual = await index.queryRanked({ term: 'needle' }, initial, { mode: 'manual' });
    assert.deepEqual(manual, auto);
    assert.deepEqual(await index.query('needle', initial, { mode: 'manual', options: { limit: 1 } }), recallPageFromRows(visibleRows, { limit: 1 }));
    await assert.rejects(index.queryRanked('syntax-error', initial, { mode: 'manual' }), error => error.name === 'SyntaxError' && error.message === 'synthetic MATCH 原文: "unterminated');
    // A native query error must not destroy the worker or select the default lexical engine.
    assert.equal(index.failed, false);
    assert.deepEqual(await index.queryRanked('needle', initial), auto);
    const live = [...initial, msg('new', 'newneedle')];
    await index.prepare(live, { preindexLive: true });
    assert.equal((await index.queryRanked('newneedle', live)).total, 0);
    const compacted = extendedBranch(initial.slice(0, -2), [msg('new', 'newneedle')]);
    assert.equal((await index.queryRanked('newneedle', compacted)).total, 1);
  } finally {
    await index.dispose();
    assert.equal(readFileSync(destination, 'utf8'), 'disposed');
    rmSync(home, { recursive: true, force: true });
  }
});

test('custom commit errors do not silently select production scan', async () => {
  const index = new BackgroundIndex({ engineModule });
  try {
    await assert.rejects(index.queryRanked('commit-error', initialBranch([msg('broken', 'commit-error')])), error => error.name === 'SyntaxError' && error.message === 'synthetic commit 原文');
  } finally { await index.dispose(); }
});

test('every timed commit records separate numeric process, main and worker memory', async () => {
  const saved = process.env.COMPACTION_RECALL_TIMING_FILE;
  const home = mkdtempSync(join(tmpdir(), 'worker-memory-'));
  const file = join(home, 'timing.jsonl');
  process.env.COMPACTION_RECALL_TIMING_FILE = file;
  const timer = new StageTiming();
  const index = new BackgroundIndex({ engineModule, timer });
  try {
    const initial = initialBranch([msg('a', 'needle')]);
    await index.prepare(initial);
    await index.prepare(extendedBranch([msg('a', 'needle')], [msg('b', 'needle new')]));
    const marks = timer.events.filter(event => event.stage === 'index_memory');
    assert.equal(marks.length, 2);
    for (const mark of marks) {
      for (const field of ['processRssBytes', 'mainHeapUsedBytes', 'workerHeapBytes', 'entries']) {
        assert.equal(typeof mark[field], 'number'); assert.ok(mark[field] > 0);
      }
      assert.equal(Object.hasOwn(mark, 'query'), false);
    }
    timer.flush(file);
    const written = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(event => event.stage === 'index_memory');
    assert.equal(written.length, 2);
    console.log('WORKER_MEMORY_MARK', JSON.stringify(written[0]));
  } finally {
    await index.dispose();
    if (saved === undefined) delete process.env.COMPACTION_RECALL_TIMING_FILE; else process.env.COMPACTION_RECALL_TIMING_FILE = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy readiness mark retains numeric worker heap with an explicit timer and no timing file', async () => {
  const saved = process.env.COMPACTION_RECALL_TIMING_FILE;
  delete process.env.COMPACTION_RECALL_TIMING_FILE;
  const timer = new StageTiming();
  const index = new BackgroundIndex({ timer });
  try {
    await index.prepare(initialBranch([msg('a', 'quasar')]));
    const ready = timer.events.find(event => event.stage === 'background_index_ready');
    assert.equal(typeof ready?.workerHeapBytes, 'number');
    assert.ok(Number.isFinite(ready.workerHeapBytes) && ready.workerHeapBytes > 0);
    assert.equal(timer.events.some(event => event.stage === 'index_memory'), false);
  } finally {
    await index.dispose();
    if (saved === undefined) delete process.env.COMPACTION_RECALL_TIMING_FILE; else process.env.COMPACTION_RECALL_TIMING_FILE = saved;
  }
});

test('without a timing destination neither main nor worker memory APIs are sampled', async () => {
  const saved = process.env.COMPACTION_RECALL_TIMING_FILE;
  delete process.env.COMPACTION_RECALL_TIMING_FILE;
  const original = process.memoryUsage;
  let heapReads = 0;
  const workerURL = new URL('../src/index-worker.mjs', import.meta.url).href;
  const index = new BackgroundIndex({
    workerFactory: () => {
      const worker = new Worker(`process.memoryUsage=()=>{throw new Error('Unexpected worker memory sample');}; import(${JSON.stringify(workerURL)});`, { eval: true });
      worker.getHeapStatistics = () => { heapReads++; throw new Error('Unexpected worker heap sample'); };
      return worker;
    }
  });
  process.memoryUsage = () => { throw new Error('Unexpected main memory sample'); };
  try {
    const branch = initialBranch([msg('a', 'quasar')]);
    assert.equal(await index.query('quasar', branch), buildLocator('quasar', branch));
    assert.deepEqual(await index.query('quasar', branch, { mode: 'manual' }), buildRecallPage('quasar', branch));
    assert.equal(index.failed, false);
    assert.equal(heapReads, 0);
  } finally {
    process.memoryUsage = original;
    await index.dispose();
    if (saved === undefined) delete process.env.COMPACTION_RECALL_TIMING_FILE; else process.env.COMPACTION_RECALL_TIMING_FILE = saved;
  }
});
