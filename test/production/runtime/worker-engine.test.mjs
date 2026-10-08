import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteBackgroundIndex } from '../../../src/worker/sqlite-background-index.mjs';
import { StageTiming } from '../../../src/observability/timing.mjs';
import { initialBranch, extendedBranch, msg } from '../../fixtures/corpus.mjs';

const ids = found => found.results.map(row => row.id);
const manual = concepts => ({ concepts: [concepts] });
const workerURL = new URL('../../../src/worker/index-worker.mjs', import.meta.url);

test('released worker preserves large transfers, live scope, compaction and awaited disposal', async () => {
  const index = new SQLiteBackgroundIndex();
  const initial = initialBranch([msg('a', 'needle first'), msg('long', '😀'.repeat(40000) + ' needle ' + 'tail '.repeat(20000))]);
  let worker;
  try {
    assert.deepEqual(ids(await index.queryRanked('needle', initial)).sort(), ['ma', 'mlong']);
    worker = index.worker;
    const live = [...initial, msg('new', 'newneedle')];
    await index.prepare(live, { preindexLive: true });
    assert.equal((await index.queryPage(manual(['newneedle']), live)).total, 0);
    const compacted = extendedBranch(initial.slice(0, -2), [msg('new', 'newneedle')]);
    assert.deepEqual((await index.queryPage(manual(['newneedle']), compacted)).ids, ['mnew']);
  } finally { await index.dispose(); }
  assert.equal(worker.threadId, -1);
  await assert.rejects(index.queryRanked('needle', initial), { name: 'AbortError' });
});

test('native query errors and expired deadlines do not destroy a healthy worker', async () => {
  const index = new SQLiteBackgroundIndex();
  const branch = initialBranch([msg('a', 'needle first')]);
  try {
    await index.prepare(branch);
    const worker = index.worker;
    await assert.rejects(index.queryPage(manual(['*']), branch), { name: 'QueryError', code: 'EMPTY_ANALYSIS' });
    await assert.rejects(index.queryRanked(manual(['needle']), branch, { mode: 'manual', timeoutMs: 0 }), { name: 'TimeoutError' });
    await assert.rejects(index.queryPage(Object.assign(Object.create({ inherited: true }), manual(['needle'])), branch), { name: 'QueryError', code: 'INVALID_QUERY' });
    assert.deepEqual((await index.queryPage(manual(['needle']), branch)).ids, ['ma']);
    assert.equal(index.worker, worker);
    assert.equal(index.failed, false);
  } finally { await index.dispose(); }
});

test('worker creation and released engine initialization failures fail closed without query restarts', async () => {
  const branch = initialBranch([msg('a', 'needle')]);
  for (const failure of ['creation', 'initialization']) {
    let starts = 0;
    const index = new SQLiteBackgroundIndex({ workerFactory: options => {
      starts++;
      if (failure === 'creation') throw new Error('synthetic worker startup failure');
      return new Worker(workerURL, { workerData: { ...options, engineOptions: { ...options.engineOptions, autoGate: 0 } }, execArgv: [] });
    } });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(index.queryRanked('needle', branch), failure === 'creation' ? /synthetic worker startup failure/ : /positive safe integer/);
      }
      assert.equal(starts, 1);
      assert.equal(index.failed, true);
      assert.equal(index.worker, null);
    } finally { await index.dispose(); }
  }
});

test('jieba native initialization failure falls back to Intl.Segmenter inside the worker without failing or restarting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-jieba-init-'));
  const preload = join(directory, 'reject-jieba.cjs');
  writeFileSync(preload, `const Module = require('node:module');\nconst load = Module._load;\nModule._load = function(request, ...args) { if (request === '@node-rs/jieba') throw new Error('synthetic jieba native init failure'); return load.call(this, request, ...args); };\n`);
  let starts = 0;
  const index = new SQLiteBackgroundIndex({ workerFactory: options => {
    starts++;
    return new Worker(workerURL, { workerData: options, execArgv: ['--require', preload] });
  } });
  try {
    const branch = initialBranch([msg('native-init', '杭州西湖')]);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(ids(await index.queryRanked('杭州西湖', branch)), ['mnative-init']);
    }
    assert.equal(starts, 1);
    assert.equal(index.failed, false);
  } finally {
    await index.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unexpected actual worker exit rejects queries and reset waits before replacing it', async () => {
  const index = new SQLiteBackgroundIndex();
  const branch = initialBranch([msg('a', 'needle')]);
  try {
    await index.prepare(branch);
    const old = index.worker;
    await old.terminate();
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(index.queryRanked('needle', branch), /Index worker unavailable/);
    assert.equal(index.worker, null);
    await index.reset();
    assert.equal(old.threadId, -1);
    assert.deepEqual((await index.queryPage(manual(['needle']), branch)).ids, ['ma']);
    assert.notEqual(index.worker, old);
  } finally { await index.dispose(); }
});

test('session reset cancels an in-flight old build before serving the replacement branch', async () => {
  let release, entered;
  const gate = new Promise(resolve => release = resolve);
  const reached = new Promise(resolve => entered = resolve);
  let pause = true;
  const index = new SQLiteBackgroundIndex({ yieldFn: async () => { if (pause) { entered(); await gate; } } });
  const old = index.queryRanked('needle', initialBranch([msg('old', 'needle old')])).catch(error => error.name);
  await reached;
  await index.reset();
  pause = false; release();
  try {
    assert.equal(await old, 'AbortError');
    assert.deepEqual(ids(await index.queryRanked('nebula', initialBranch([msg('fresh', 'nebula fresh')]))), ['mfresh']);
  } finally { release(); await index.dispose(); }
});

test('live prewarm cannot cancel a cold foreground lookup or block a warm eligible query', async () => {
  let release, entered;
  let gate = new Promise(resolve => release = resolve);
  let reached = new Promise(resolve => entered = resolve);
  let pause = true;
  const index = new SQLiteBackgroundIndex({ yieldFn: async () => { if (pause) { entered(); await gate; } } });
  const branch = initialBranch([msg('old', 'needle eligible')]);
  const lookup = index.queryRanked('needle', branch);
  await reached;
  const prewarm = index.prepare(branch, { preindexLive: true });
  pause = false; release();
  try {
    assert.deepEqual(ids(await lookup), ['mold']);
    await prewarm;
    gate = new Promise(resolve => release = resolve);
    reached = new Promise(resolve => entered = resolve);
    pause = true;
    const live = [...branch, ...Array.from({ length: 40 }, (_, i) => msg(`live${i}`, 'secretlive'))];
    const updating = index.prepare(live, { preindexLive: true });
    await reached;
    let timeout;
    try {
      const found = await Promise.race([index.queryRanked('needle', live), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Query waited for irrelevant live batch')), 1000);
      })]);
      assert.deepEqual(ids(found), ['mold']);
    } finally { clearTimeout(timeout); pause = false; release(); await updating; }
    assert.equal((await index.queryPage(manual(['secretlive']), live)).total, 0);
  } finally { release(); await index.dispose(); }
});

test('every timed commit records separate process, main and worker memory without document text', async () => {
  const saved = process.env.COMPACTION_RECALL_TIMING_FILE;
  const home = mkdtempSync(join(tmpdir(), 'worker-memory-'));
  const file = join(home, 'timing.jsonl');
  process.env.COMPACTION_RECALL_TIMING_FILE = file;
  const timer = new StageTiming();
  const index = new SQLiteBackgroundIndex({ timer });
  try {
    await index.prepare(initialBranch([msg('a', 'needle privatefixture')]));
    await index.prepare(extendedBranch([msg('a', 'needle privatefixture')], [msg('b', 'needle new')]));
    const marks = timer.events.filter(event => event.stage === 'index_memory');
    assert.equal(marks.length, 2);
    for (const mark of marks) for (const field of ['processRssBytes', 'mainHeapUsedBytes', 'workerHeapBytes', 'entries']) {
      assert.equal(typeof mark[field], 'number'); assert.ok(mark[field] > 0);
    }
    timer.flush(file);
    const written = readFileSync(file, 'utf8');
    assert.doesNotMatch(written, /needle|privatefixture/);
    assert.equal(written.split('\n').filter(Boolean).map(JSON.parse).filter(event => event.stage === 'index_memory').length, 2);
  } finally {
    await index.dispose();
    if (saved === undefined) delete process.env.COMPACTION_RECALL_TIMING_FILE; else process.env.COMPACTION_RECALL_TIMING_FILE = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test('without timing neither main nor actual worker memory APIs are sampled', async () => {
  const original = process.memoryUsage;
  let heapReads = 0;
  const index = new SQLiteBackgroundIndex({ workerFactory: options => {
    const worker = new Worker(`process.memoryUsage=()=>{throw new Error('Unexpected worker memory sample');}; import(${JSON.stringify(workerURL.href)});`, { eval: true, workerData: options });
    worker.getHeapStatistics = () => { heapReads++; throw new Error('Unexpected worker heap sample'); };
    return worker;
  } });
  process.memoryUsage = () => { throw new Error('Unexpected main memory sample'); };
  try {
    const branch = initialBranch([msg('a', 'needle')]);
    assert.deepEqual(ids(await index.queryRanked('needle', branch)), ['ma']);
    assert.deepEqual((await index.queryPage(manual(['needle']), branch)).ids, ['ma']);
    assert.equal(heapReads, 0);
  } finally { process.memoryUsage = original; await index.dispose(); }
});
