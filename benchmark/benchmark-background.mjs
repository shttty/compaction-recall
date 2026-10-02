// Offline, one actual saved DEV8 history. Fresh process per arm/repetition.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { CompactionIndex } from '../src/inverted-index.mjs';
import { BackgroundIndex } from '../src/background-index.mjs';
import { StageTiming } from '../src/timing.mjs';
const { values: args } = parseArgs({ options: { source: { type: 'string' }, query: { type: 'string' }, output: { type: 'string' }, arm: { type: 'string' }, help: { type: 'boolean' } } });
if (args.help) { console.log('Usage: node --expose-gc benchmark/benchmark-background.mjs --source SESSION_JSONL --query TEXT --output NEW_RESULT_JSON'); process.exit(0); }
if (!args.source || !args.query || (!args.arm && !args.output) || (args.arm && !['sync', 'worker'].includes(args.arm))) throw new Error('Explicit source, query, output and valid arm required');
const arm = args.arm, file = args.source, query = args.query;
if (!arm) {
 const runs = []; for (let repeat = 0; repeat < 3; repeat++)for (const variant of repeat % 2 ? ['worker', 'sync'] : ['sync', 'worker']) runs.push(JSON.parse(execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname, '--source', file, '--query', query, '--arm', variant], { encoding: 'utf8' })));
 const hashes = runs.map(r => JSON.stringify(r.outputHashes)); if (new Set(hashes).size !== 1) throw new Error('Output parity failed');
 const sourceHashes = Object.fromEntries(['../src/background-index.mjs', '../src/index-worker.mjs', '../src/inverted-index.mjs', 'benchmark-background.mjs'].map(name => [name, createHash('sha256').update(fs.readFileSync(new URL(name, import.meta.url))).digest('hex')]));
 const report = { sourceHashes, runtime: process.version, source: file, query, method: '3 isolated process repetitions/arm; alternating order; 5ms event-loop heartbeat; read/parse separately; cold build+query and incremental update include extraction/transfer/worker wait; 10 warm auto and 5 manual requests per repetition; no model calls', runs };
 fs.writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
 const median = v => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
 for (const variant of ['sync', 'worker']) {
  const rs = runs.filter(r => r.arm === variant); console.log(JSON.stringify({ arm: variant, coldMs: median(rs.map(r => r.cold.wallMs)), coldMaxEventLoopLagMs: median(rs.map(r => r.cold.maxLagMs)), warmAutoMs: median(rs.flatMap(r => r.warmAuto.map(x => x.wallMs))), warmAutoMaxLagMs: median(rs.flatMap(r => r.warmAuto.map(x => x.maxLagMs))), updateMs: median(rs.map(r => r.update.wallMs)), updateMaxLagMs: median(rs.map(r => r.update.maxLagMs)), rssBytes: median(rs.map(r => r.memory.after.rss)) }));
 }
} else {
 const measure = async (work) => {
  const delays = []; let expected = performance.now() + 5;
  const interval = setInterval(() => { const now = performance.now(); delays.push(Math.max(0, now - expected)); expected = now + 5; }, 5);
  await sleep(15); delays.length = 0; const start = performance.now(); const result = await work(); const wallMs = performance.now() - start;
  await sleep(15); clearInterval(interval); return { wallMs, maxLagMs: Math.max(0, ...delays), samples: delays.length, result };
 };
 const load = await measure(() => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)); const branch = load.result; delete load.result;
 global.gc?.(); const host = process.memoryUsage(), timer = new StageTiming(), index = arm === 'worker' ? new BackgroundIndex({ timer }) : new CompactionIndex();
 const auto = (idx, b) => arm === 'worker' ? idx.query(query, b) : idx.query(query, b);
 const hash = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
 const cold = await measure(() => auto(index, branch)); const outputHashes = { cold: hash(cold.result) }; delete cold.result;
 global.gc?.(); const after = process.memoryUsage();
 const warmAuto = [], warmManual = [];
 for (let i = 0; i < 10; i++) { const m = await measure(() => auto(index, branch)); outputHashes.auto = hash(m.result); delete m.result; warmAuto.push(m); }
 for (let i = 0; i < 5; i++) { const m = await measure(() => arm === 'worker' ? index.query(query, branch, { mode: 'manual' }) : index.recall(query, branch)); outputHashes.manual = hash(m.result); delete m.result; warmManual.push(m); }
 const boundaries = branch.flatMap((x, i) => x.type === 'compaction' ? [i] : []), growing = arm === 'worker' ? new BackgroundIndex({ timer }) : new CompactionIndex();
 await auto(growing, branch.slice(0, boundaries[0] + 1));
 const update = await measure(() => auto(growing, branch.slice(0, boundaries[1] + 1))); outputHashes.update = hash(update.result); delete update.result;
 let preindexLive = null, eligibilityActivation = null;
 if (arm === 'worker') {
  const batched = new BackgroundIndex({ timer }); await auto(batched, branch.slice(0, boundaries[0] + 1));
  preindexLive = await measure(() => batched.prepare(branch.slice(0, boundaries[1]), { preindexLive: true })); delete preindexLive.result;
  eligibilityActivation = await measure(() => auto(batched, branch.slice(0, boundaries[1] + 1)));
  if (hash(eligibilityActivation.result) !== outputHashes.update) throw new Error('Preindexed eligibility parity failed'); delete eligibilityActivation.result; await batched.dispose();
 }
 const workerHeapBytes = timer.events.filter(e => e.stage === 'background_index_ready').map(e => e.workerHeapBytes);
 if (arm === 'worker') { await index.dispose(); await growing.dispose(); }
 console.log(JSON.stringify({ arm, load, cold, preindexLive, eligibilityActivation, warmAuto, warmManual, update, outputHashes, memory: { host, after, workerHeapBytes, rssPeakKiB: process.resourceUsage().maxRSS }, timings: timer.events }));
}
