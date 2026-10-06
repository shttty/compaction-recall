import test from 'node:test';
import assert from 'node:assert/strict';
import { StageTiming } from '../src/timing.mjs';
import { SQLiteBackgroundIndex } from '../src/sqlite-background-index.mjs';
import { initialBranch, extendedBranch, msg } from './corpus.mjs';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('timed SQLite queries preserve cold/warm/update visibility and worker parent spans without content', async () => {
 const timing = new StageTiming(), index = new SQLiteBackgroundIndex({ timer: timing });
 const records = [msg('a', 'quasar privatefixture'), msg('b', 'quasar other')], branch = initialBranch(records);
 try {
  const first = await timing.runAsync('lookup', () => index.queryPage({ concepts: [['quasar']] }, branch));
  assert.deepEqual([...first.ids].sort(), ['ma', 'mb']);
  const worker = index.worker;
  const commits = timing.events.filter(event => event.stage === 'worker_commit').length;
  assert.deepEqual((await index.queryPage({ concepts: [['quasar']] }, branch)).ids, first.ids);
  assert.equal(index.worker, worker);
  assert.equal(timing.events.filter(event => event.stage === 'worker_commit').length, commits);
  const next = extendedBranch(records, [msg('c', 'quasar new')]);
  assert.deepEqual((await index.queryPage({ concepts: [['quasar']] }, next)).ids.sort(), ['ma', 'mb', 'mc']);
  const spans = new Map(timing.events.filter(event => event.type === 'span').map(event => [event.id, event]));
  for (const event of timing.events.filter(event => event.type === 'span' && ['worker_batch', 'worker_commit', 'worker_query'].includes(event.stage))) {
   assert.equal(event.execution, 'worker_thread');
   assert.equal(spans.get(event.parentId).stage, `worker_roundtrip_${event.stage.slice(7)}`);
  }
  assert.ok(timing.events.filter(event => event.type === 'span').every(event => event.durationMs >= 0));
  assert.doesNotMatch(JSON.stringify(timing.events), /quasar|privatefixture/);
 } finally { await index.dispose(); }
});
test('nested spans retain inclusive parent relation without false parallel nesting', async () => {
 const t = new StageTiming();
 await Promise.all([t.runAsync('toolA', async () => { await Promise.resolve(); t.run('innerA', () => { }); }), t.runAsync('toolB', async () => { await Promise.resolve(); t.run('innerB', () => { }); })]);
 const byStage = Object.fromEntries(t.events.map(e => [e.stage, e]));
 assert.equal(byStage.toolA.parentId, null); assert.equal(byStage.toolB.parentId, null);
 assert.equal(byStage.innerA.parentId, byStage.toolA.id); assert.equal(byStage.innerB.parentId, byStage.toolB.id);
});

test('disabled timing reads no clock and writes nothing', () => {
 execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { performance } from 'node:perf_hooks';
    import { syncBuiltinESMExports } from 'node:module';
    delete process.env.COMPACTION_RECALL_TIMING_FILE;
    let clocks = 0, writes = 0;
    performance.now = () => { clocks++; throw Error('clock used'); };
    const originalOpen = fs.openSync;
    fs.openSync = (path, flags, ...args) => {
      if (flags === 'r' || flags === fs.constants.O_RDONLY) return originalOpen(path, flags, ...args);
      writes++; throw Error('filesystem write used');
    };
    for (const key of ['writeSync', 'appendFileSync', 'writeFileSync', 'fchmodSync']) fs[key] = () => { writes++; throw Error('filesystem used'); };
    syncBuiltinESMExports();
    const { recallTiming, measured, flushTiming } = await import(${JSON.stringify(new URL('../src/timing.mjs', import.meta.url).href)});
    assert.equal(recallTiming, undefined);
    assert.equal(measured(recallTiming, 'disabled', () => 42), 42);
    flushTiming();
    assert.equal(clocks, 0); assert.equal(writes, 0);
  `], { env: { ...process.env, COMPACTION_RECALL_TIMING_FILE: '' } });
});

test('timing fields reject private values, arbitrary keys and structural overrides', () => {
 const timer = new StageTiming(() => 1);
 timer.mark('preindex_config', { query: 'SECRET', args: { token: 'SECRET' }, credentials: 'SECRET', stage: 'SECRET', type: 'SECRET', operation: 'SECRET', trigger: 'SECRET', requestId: 'SECRET', count: 3 });
 assert.deepEqual(timer.events, [{ type: 'mark', execution: 'synchronous_main_thread', stage: 'preindex_config', atMs: 0, parentId: null, count: 3 }]);
});

test('transferred worker spans retain parent identity and align independent origins', () => {
 let mainNow = 100, workerNow = 120;
 const main = new StageTiming(() => mainNow), worker = new StageTiming(() => workerNow);
 main.run('request', () => {
  const transfer = main.capture(); workerNow = 125;
  worker.withParent(transfer.parentId, () => worker.run('worker_query', () => { workerNow = 130; }));
  main.merge(worker.events.splice(0), worker.origin); mainNow = 140;
 });
 const [child, parent] = main.events;
 assert.equal(child.parentId, parent.id); assert.notEqual(child.id, parent.id);
 assert.equal(child.startMs, 25); assert.equal(child.durationMs, 5); assert.equal(parent.durationMs, 40);
});

test('existing logs become private; logging failure preserves results and original exceptions', () => {
 const directory = mkdtempSync(join(tmpdir(), 'compaction-recall-timing-test-'));
 try {
  const path = join(directory, 'events.jsonl'), timer = new StageTiming(() => 1);
  writeFileSync(path, '', { mode: 0o666 });
  chmodSync(path, 0o644);
  timer.run('success', () => 42); timer.flush(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).stage, 'success');
  assert.equal(timer.run('still_success', () => 42), 42); timer.flush(directory);
  const failure = new Error('SECRET');
  assert.throws(() => timer.run('failure', () => { throw failure; }), error => error === failure);
  assert.equal(timer.events[0].outcome, 'error'); assert.ok(!JSON.stringify(timer.events).includes('SECRET'));
  timer.flush(join(directory, 'missing', 'events')); assert.deepEqual(timer.events, []);
 } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('event buffer stays bounded and reports dropped measurements', () => {
 const directory = mkdtempSync(join(tmpdir(), 'compaction-recall-timing-bound-'));
 try {
  const timer = new StageTiming(() => 1), path = join(directory, 'events.jsonl');
  for (let i = 0; i < 10005; i++) timer.mark('bounded', { count: i });
  assert.equal(timer.events.length, 10000); timer.flush(path);
  const events = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).stage, 'dropped_timing_events'); assert.equal(events.at(-1).count, 5);
 } finally { rmSync(directory, { recursive: true, force: true }); }
});
