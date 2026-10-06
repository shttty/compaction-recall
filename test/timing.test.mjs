import test from 'node:test';
import assert from 'node:assert/strict';
import { StageTiming } from '../src/timing.mjs';
import { registerStageEvents } from '../benchmark/pi-stage-events.mjs';
import { CompactionIndex } from '../archive/js-runtime/inverted-index.mjs';
import { buildRecallPage, buildLocator } from '../archive/js-runtime/locator.mjs';
import { initialBranch, extendedBranch, msg } from './corpus.mjs';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('timed index preserves response parity and distinguishes cold build, warm query and update', () => {
 let t = 0; const timing = new StageTiming(() => ++t), index = new CompactionIndex(timing);
 const records = [msg('a', 'quasar rare keyword'), msg('b', 'quasar other')], branch = initialBranch(records);
 assert.equal(index.query('quasar', branch), buildLocator('quasar', branch));
 assert.deepEqual(index.recall('quasar', branch), buildRecallPage('quasar', branch));
 const next = extendedBranch(records, [msg('c', 'quasar new')]);
 assert.equal(index.query('quasar', next), buildLocator('quasar', next));
 const stages = timing.events.map(x => x.stage);
 for (const stage of ['index_build_tokenize_postings', 'index_update_tokenize_postings', 'query_tokenization', 'postings_search', 'candidate_materialization', 'deduplicate', 'mechanical_rank', 'manual_snippets_pagination_render', 'auto_render_budget']) assert.ok(stages.includes(stage), stage);
 assert.equal(stages.filter(x => x === 'index_build_tokenize_postings').length, 1);
 assert.ok(timing.events.filter(x => x.type === 'span').every(x => x.durationMs >= 0));
 assert.ok(!JSON.stringify(timing.events).includes('rare keyword'));
});
test('nested spans retain inclusive parent relation without false parallel nesting', async () => {
 const t = new StageTiming();
 await Promise.all([t.runAsync('toolA', async () => { await Promise.resolve(); t.run('innerA', () => { }); }), t.runAsync('toolB', async () => { await Promise.resolve(); t.run('innerB', () => { }); })]);
 const byStage = Object.fromEntries(t.events.map(e => [e.stage, e]));
 assert.equal(byStage.toolA.parentId, null); assert.equal(byStage.toolB.parentId, null);
 assert.equal(byStage.innerA.parentId, byStage.toolA.id); assert.equal(byStage.innerB.parentId, byStage.toolB.id);
});
test('mock SDK event trace separates headers, thinking, visible text and model response end', () => {
 let now = 0; const t = new StageTiming(() => now), hooks = {}; registerStageEvents({ on: (name, fn) => hooks[name] = fn }, t);
 hooks.before_provider_request({ payload: { secret: 'DO_NOT_LOG' } }); now = 20; hooks.after_provider_response({ headers: { secret: 'DO_NOT_LOG' } });
 now = 30; hooks.message_update({ assistantMessageEvent: { type: 'thinking_delta', delta: 'DO_NOT_LOG' } });
 now = 50; hooks.message_update({ assistantMessageEvent: { type: 'text_delta', delta: 'DO_NOT_LOG' } });
 now = 60; hooks.message_update({ assistantMessageEvent: { type: 'text_delta' } });
 now = 80; hooks.message_end({ message: { role: 'assistant', content: 'DO_NOT_LOG' } });
 assert.equal(t.events.filter(e => e.stage === 'first_visible_text_delta').length, 1);
 assert.equal(t.events.find(e => e.stage === 'first_visible_text_delta').sinceRequestMs, 50);
 assert.equal(t.events.find(e => e.stage === 'assistant_response_end').sinceRequestMs, 80);
 assert.ok(!JSON.stringify(t.events).includes('DO_NOT_LOG'));
});

test('disabled timing reads no clock, writes nothing and registers no observer', () => {
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
    const { registerStageEvents } = await import(${JSON.stringify(new URL('../benchmark/pi-stage-events.mjs', import.meta.url).href)});
    assert.equal(recallTiming, undefined);
    assert.equal(measured(recallTiming, 'disabled', () => 42), 42);
    flushTiming(); registerStageEvents({ on() { throw Error('observer registered'); } });
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
