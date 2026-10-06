// Throwaway prototype runner. Source/index files and existing benchmarks stay untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep, setImmediate as immediate } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import threads from 'node:worker_threads';
import { parseArgs } from 'node:util';
const root = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(import.meta.url);
const NODE24 = '/home/rinne/.nvm/versions/node/v24.18.0/bin/node';
const masks = ['2,3', '4,5', '6,7', '8,9', '10,11'];
const variants = ['base', 'A', 'B1', 'B2', 'B3'];
const { values: args } = parseArgs({
  options: {
    data: { type: 'string' }, sizes: { type: 'string', default: '50000,200000,500000,1000000' },
    output: { type: 'string' }, lane: { type: 'string' }, variant: { type: 'string' },
    runtime: { type: 'string', default: NODE24 }, child: { type: 'boolean' }, timing: { type: 'boolean' },
    variants: { type: 'string' }, help: { type: 'boolean' },
    parallel: { type: 'string', default: '5' }, repeats: { type: 'string', default: '3' }, 'memory-plan': { type: 'string' },
  }
});
const sha = value => createHash('sha256').update(value).digest('hex');
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const affinity = () => fs.readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)[1];
const availableMemory = () => Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)[1]) * 1024;
const io = () => Object.fromEntries(fs.readFileSync('/proc/self/io', 'utf8').trim().split('\n').map(line => {
  const [key, value] = line.split(':'); return [key, Number(value)];
}));
function observeWorkers(variant) {
  const NativeWorker = threads.Worker, active = new Set(), failures = [], commits = [];
  let waiter, queries = 0;
  threads.Worker = class extends NativeWorker {
    constructor(filename, options) {
      const isIndex = String(filename).endsWith('/src/index-worker.mjs');
      super(isIndex && variant !== 'base' ? new URL('./worker.mjs', import.meta.url) : filename,
        isIndex && variant !== 'base' ? { ...options, workerData: { variant } } : options);
      this.requests = new Map(); this.lastBegin = null; active.add(this);
      this.on('error', error => { failures.push(String(error)); waiter?.reject(error); });
      this.on('exit', () => active.delete(this));
      this.on('message', reply => {
        const type = this.requests.get(reply.requestId); this.requests.delete(reply.requestId);
        if (reply.error) { failures.push(reply.error); waiter?.reject(new Error(reply.error)); }
        if (type === 'query') queries++;
        if (type === 'commit' && !reply.error) {
          const value = { ...reply.result, append: this.lastBegin?.append, atMs: performance.now(), sharedProcessRssAtCommit: process.memoryUsage().rss };
          commits.push(value); queueMicrotask(() => waiter?.resolve(value));
        }
      });
    }
    postMessage(value, ...rest) {
      this.requests.set(value.requestId, value.type);
      if (value.type === 'begin') this.lastBegin = { append: value.append, eligibleCount: value.eligibleCount };
      return super.postMessage(value, ...rest);
    }
  };
  syncBuiltinESMExports();
  return {
    active, failures, commits, get queries() { return queries; }, nextCommit() {
      assert.equal(waiter, undefined);
      let timeout;
      const promise = new Promise((resolve, reject) => {
        waiter = { resolve, reject }; timeout = setTimeout(() => reject(new Error('Worker commit timeout')), 180000);
      });
      return promise.finally(() => { clearTimeout(timeout); waiter = undefined; });
    }
  };
}
async function background(work) {
  let previous = performance.now(), maxDelay = 0, samples = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now(); maxDelay = Math.max(maxDelay, now - previous - 5); previous = now; samples++;
  }, 5);
  await sleep(15); previous = performance.now(); maxDelay = 0; samples = 0;
  const startMs = performance.now();
  try {
    const value = await work(), endMs = performance.now(); await sleep(10);
    return { startMs, endMs, wallMs: endMs - startMs, maxEventLoopDelayMs: Math.max(0, maxDelay), heartbeatSamples: samples, value };
  } finally { clearInterval(heartbeat); }
}
async function hot(work) {
  const samplesMs = [], startMs = performance.now();
  for (let i = 0; i < 20; i++) { const at = performance.now(); await work(); samplesMs.push(performance.now() - at); }
  return { startMs, endMs: performance.now(), samplesMs, p50Ms: quantile(samplesMs, 0.5), p95Ms: quantile(samplesMs, 0.95) };
}
const rows = text => (text ?? '').split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
async function consistency(runner, recall, session, queries) {
  const output = [];
  for (const query of queries) {
    const request = [...session.buildSessionContext().messages, { role: 'user', content: query, timestamp: 1 }];
    const messages = await runner.emitContext(request);
    const autoText = messages.find(m => m.customType === 'compaction-recall:compacted-locators:v1')?.content ?? null;
    const pages = [], topIds = [];
    let offset = 0;
    do {
      const page = await recall({ query, limit: 50, offset });
      const text = page.content[0].text;
      if (!offset) topIds.push(...rows(text).map(row => row.id));
      pages.push({ offset, sha256: sha(JSON.stringify(page)), ...page.details });
      if (!page.details.hasMore) break;
      assert.ok(page.details.nextOffset > offset); offset = page.details.nextOffset;
    } while (true);
    output.push({ query, autoText, autoSha256: sha(JSON.stringify(autoText)), autoIds: rows(autoText).map(row => row.id), topIds, pages });
  }
  return output;
}
async function child() {
  assert.ok(global.gc); assert.ok(variants.includes(args.variant));
  const fixture = await new Promise(resolve => process.once('message', resolve));
  const observer = observeWorkers(args.variant);
  globalThis.fetch = () => { throw new Error('Offline prototype: network is forbidden'); };
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { loadExtensions } = await import('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
  const header = { type: 'session', version: 3, id: '11111111-2222-4333-8444-555555555555', timestamp: '2023-01-01T00:00:00.000Z', cwd: process.cwd() };
  const session = sdk.SessionManager.inMemory(process.cwd(), undefined, [header, ...fixture.entries]);
  session.branch(fixture.entries[fixture.originalCount - 1].id);
  session.appendCompaction('[Offline placeholder; no model.]', fixture.entries[fixture.firstKept].id, fixture.stats.actualTokens);
  const loaded = await loadExtensions([path.join(root, 'src/index.ts')], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), session, undefined);
  const errors = []; runner.onError(error => errors.push(error));
  const definition = runner.getAllRegisteredTools().find(t => t.definition.name === 'history_recall').definition;
  const recall = params => definition.execute('index-alt', params, undefined, undefined, runner.createToolContext('index-alt', undefined));
  const query = fixture.queries[0];
  const messages = [...session.buildSessionContext().messages, { role: 'user', content: query, timestamp: 1 }];
  const compactEvent = () => ({ type: 'session_compact', compactionEntry: session.getLeafEntry(), fromExtension: false, reason: 'manual', willRetry: false });
  const beforeIO = io();
  const startup = { rssBytes: process.memoryUsage().rss, peakRssKiB: process.resourceUsage().maxRSS };
  try {
    const build = await background(async () => {
      const ready = observer.nextCommit();
      await runner.emit({ type: 'session_start', reason: 'startup' });
      await runner.emit(compactEvent()); return await ready;
    });
    assert.equal(build.value.documents, fixture.firstKept);
    await runner.emitContext(messages); assert.equal(observer.queries, 1, 'No synchronous fallback allowed');
    await immediate(); global.gc();
    const mainAtMs = performance.now(), main = process.memoryUsage();
    const requestAtMs = performance.now();
    const heap = await [...observer.active][0].getHeapStatistics();
    const memory = {
      mainAtMs, sharedProcessRssBytes: main.rss, mainHeapUsedBytes: main.heapUsed, mainExternalBytes: main.external,
      worker: { requestAtMs, receivedAtMs: performance.now(), explicitGc: false, heap },
      storageAtCommit: build.value.storage ?? null,
      note: 'RSS is process-wide/shared, not additive per-thread RSS; worker heap is a separate quiescent sample without worker GC. Typed buffers and SQLite native allocations are not JS heap.'
    };
    const warmContext = await hot(() => runner.emitContext(messages));
    await recall({ query });
    const warmRecall = await hot(() => recall({ query }));
    const initial = await consistency(runner, recall, session, fixture.queries);
    // Both cuts share original entry identities: this is a real append/activation,
    // not a reset/rebuild. Future messages were held in memory, on a descendant path.
    session.branch(fixture.entries.at(-1).id);
    session.appendCompaction('[Offline incremental placeholder.]', fixture.entries[fixture.nextKept].id, fixture.stats.actualTokens + (fixture.stats.addedTokens ?? 0));
    const incremental = await background(async () => {
      const ready = observer.nextCommit(); await runner.emit(compactEvent()); return await ready;
    });
    assert.equal(incremental.value.append, true, 'Incremental phase must not silently rebuild');
    assert.equal(incremental.value.documents, fixture.nextKept);
    const updated = await consistency(runner, recall, session, fixture.queries);
    assert.deepEqual(errors, []); assert.deepEqual(observer.failures, []);
    const afterIO = io();
    const diskWriteBytes = afterIO.write_bytes - beforeIO.write_bytes;
    if (!args.timing) assert.equal(diskWriteBytes, 0, 'Memory run must not write filesystem data during indexing/querying');
    for (const event of observer.commits) if (event.storage?.databaseList) {
      assert.ok(event.storage.databaseList.every(db => db.file === ''));
    }
    await runner.emit({ type: 'session_shutdown', reason: 'quit' }); assert.equal(observer.active.size, 0);
    return {
      variant: args.variant, runtime: process.version, pid: process.pid, affinity: affinity(), timeOriginMs: performance.timeOrigin, stats: fixture.stats,
      command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
      startup, peakRssKiB: process.resourceUsage().maxRSS, semanticCases: fixture.semanticCases ?? null,
      timingEnabled: !!args.timing, memory, build, warmContext, warmRecall, incremental, initial, updated,
      workerQueryReplies: observer.queries, diskWriteBytes, diskWriteScope: '/proc/self/io write_bytes delta after SDK loading, through all index/query phases; explicit timing writes permitted only for timing runs', shutdown: 'completed'
    };
  } finally { await runner.emit({ type: 'session_shutdown', reason: 'quit' }); }
}
function complete(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).shutdown === 'completed'; } catch { return false; }
}
async function barrier(files, description) {
  const limit = Date.now() + 900000;
  while (!files.every(complete)) {
    if (Date.now() > limit) throw new Error(`Barrier timeout: ${description}`);
    await sleep(50);
  }
}
function launch(fixture, variant, output, lane, repetition, runtime, timing) {
  return new Promise((resolve, reject) => {
    const mask = masks[lane], timingFile = path.join(output, `${fixture.stats.targetTokens}-${variant}-r${repetition}.timing.jsonl`);
    const missingHome = path.join('/home/rinne/.hermes/cache/scratch', `index-alt-memory-only-${process.pid}-${variant}`);
    const env = {
      PATH: process.env.PATH, HOME: missingHome, PI_CODING_AGENT_DIR: path.join(missingHome, 'agent'),
      PI_OFFLINE: '1', DO_NOT_TRACK: '1', JITI_FS_CACHE: '0', COMPACTION_RECALL_MODE: 'full',
      ...(timing ? { COMPACTION_RECALL_TIMING_FILE: timingFile } : {})
    };
    const childArgs = ['-c', mask, runtime, '--expose-gc', script, '--child', '--variant', variant, ...(timing ? ['--timing'] : [])];
    const startedAt = new Date().toISOString();
    const hostMemAvailableBefore = availableMemory(), driverRssBytes = process.memoryUsage().rss;
    assert.ok(hostMemAvailableBefore >= 1.5 * 1024 ** 3, 'Available memory below 1.5 GiB safety floor; stop instead of touching services');
    const processChild = spawn('taskset', childArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
    let stdout = '', stderr = '';
    processChild.stdout.on('data', data => { stdout += data; });
    processChild.stderr.on('data', data => { stderr += data; });
    const timeout = setTimeout(() => processChild.kill('SIGKILL'), 600000);
    processChild.on('error', error => { clearTimeout(timeout); reject(error); });
    processChild.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || stderr) return reject(new Error(`Child ${variant} failed code=${code} signal=${signal}\n${stderr}\n${stdout}`));
      try {
        const result = {
          ...JSON.parse(stdout), lane, repetition, cpuMask: mask, startedAt, finishedAt: new Date().toISOString(), hostMemAvailableBefore, driverRssBytes,
          launchCommand: ['taskset', ...childArgs], stderr, ...(timing ? { timingFile: path.basename(timingFile) } : {})
        };
        resolve(result);
      } catch (error) { reject(error); }
    });
    processChild.send(fixture);
  });
}
async function parent() {
  assert.ok(args.data && args.output, 'Explicit local --data and result --output required');
  const output = path.resolve(args.output); fs.mkdirSync(output, { recursive: true });
  process.env.JITI_FS_CACHE = '0';
  process.env.PI_CODING_AGENT_DIR = '/home/rinne/.hermes/cache/scratch/index-alt-no-personal-profile';
  const { extract, fixture, semanticFixture } = await import('./data.mjs');
  const selected = await extract(args.data);
  const sizes = args.sizes.split(',').map(value => value === 'semantic' ? value : Number(value));
  const fixtures = sizes.map(size => size === 'semantic' ? semanticFixture() : fixture(selected.record, size));
  selected.record = undefined; global.gc?.();
  const lane = args.lane === undefined ? 0 : Number(args.lane);
  const parallelism = args.lane === undefined ? 1 : Number(args.parallel);
  assert.ok([1, 4, 5].includes(parallelism));
  assert.ok(Number.isInteger(lane) && lane >= 0 && lane < parallelism);
  const selectedVariants = args.variants ? args.variants.split(',') : variants;
  assert.ok(selectedVariants.every(v => variants.includes(v)));
  const repeats = args.lane === undefined ? 1 : Number(args.repeats);
  const jobs = Array.from({ length: repeats }, (_, round) => selectedVariants.map((_, slot) => ({
    variant: selectedVariants[(slot + round) % selectedVariants.length], repetition: round + 1,
  }))).flat();
  const memoryPlan = args['memory-plan'] ? JSON.parse(fs.readFileSync(args['memory-plan'], 'utf8')) : null;
  const sourceFiles = [...fs.readdirSync(path.join(root, 'src')).map(n => `src/${n}`),
  ...fs.readdirSync(path.join(root, 'archive/prototype/index-alt')).filter(n => n.endsWith('.mjs')).map(n => `prototype/index-alt/${n}`), 'package.json', 'package-lock.json'];
  const metadata = {
    shutdown: 'completed', lane, node: process.version, childRuntime: args.runtime, cpuMask: masks[lane],
    cpuModel: os.cpus()[0].model, logicalCpus: os.cpus().length,
    smtTopology: 'User-specified siblings (0,1),(2,3),...,(14,15); dedicated job masks 2/3,4/5,6/7,8/9,10/11; CPU0/1 unassigned',
    actualParallelism: parallelism, masks: masks.slice(0, parallelism), memoryPlan,
    driverRssAtReady: process.memoryUsage().rss, driverPeakRssAtReadyKiB: process.resourceUsage().maxRSS,
    concurrency: parallelism === 1 ? 'single standalone smoke/timing job' : 'Common input-ready barrier and per-wave result barrier; five-way waves align size and repetition, rotate physical-core assignments by repetition; four-way fallback packs the same jobs into waves',
    plannedJobs: jobs, sizes, timingEnabled: !!args.timing,
    command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    dataset: { path: args.data, questionId: '577d4d32', recordIndex: selected.recordIndex, recordSha256: selected.recordSha256 },
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(path.join(root, file)))])),
    methods: {
      tokens: 'Same per-message SDK estimateTokens and findCutPoint(...,20000) as perf scaling; prefix ends at source session boundary',
      input: 'Original messages transferred over IPC, no data/profile/cache temporary files; deterministic source IDs; query appended to context only',
      memory: 'Main GC after one warm context, before hot loops; process RSS; separately timestamped worker.getHeapStatistics without worker GC; timing disabled',
      warm: '20 index-hot context and 20 recall first-page requests for original question; external performance.now; p50/p95 nearest rank',
      incremental: '20 subsequent original messages plus compaction activating newly eligible messages; production begin.append must be true',
      parity: 'Eight fixed queries, all recall pages, initial and incrementally activated corpus; exact auto text and SHA-256 of complete tool results',
      storage: 'SQLite :memory:, temp_store MEMORY, journal_mode MEMORY; /proc/self/io write_bytes checked while measuring; no warning suppression',
      timing: 'Separate 1M diagnostic runs; production COMPACTION_RECALL_TIMING_FILE records actual worker spans; hotRecall start/end selects stage attribution',
    }
  };
  writeJson(path.join(output, `lane-${lane}-metadata.json`), metadata);
  const lanes = Array.from({ length: parallelism }, (_, i) => i);
  if (parallelism > 1) await barrier(lanes.map(i => path.join(output, `lane-${i}-metadata.json`)), 'all lanes loaded input');
  for (const item of fixtures) for (let wave = 0; wave < Math.ceil(jobs.length / parallelism); wave++) {
    const job = jobs[wave * parallelism + lane];
    if (job) {
      const { variant, repetition } = job;
      const result = await launch(item, variant, output, lane, repetition, args.runtime, !!args.timing);
      result.wave = wave;
      writeJson(path.join(output, `${item.stats.targetTokens}-${variant}-r${repetition}.json`), result);
      console.log(JSON.stringify({
        target: item.stats.targetTokens, variant, lane, repetition,
        rssMiB: result.memory.sharedProcessRssBytes / 1048576, peakRssMiB: result.peakRssKiB / 1024,
        buildMs: result.build.wallMs, recallP50Ms: result.warmRecall.p50Ms, incrementalMs: result.incremental.wallMs
      }));
    }
    if (parallelism > 1) await barrier(jobs.slice(wave * parallelism, (wave + 1) * parallelism).map(peer =>
      path.join(output, `${item.stats.targetTokens}-${peer.variant}-r${peer.repetition}.json`)), `size ${item.stats.targetTokens} wave ${wave}`);
  }
}
if (args.help) console.log('node --expose-gc prototype/index-alt/run.mjs --data LOCAL_DATASET --output NEW_RESULTS [--lane 0..4 --parallel 4|5 --repeats 3 --memory-plan JSON] [--sizes semantic,50000] [--runtime NODE] [--variants base,A,B1,B2,B3] [--timing]');
else if (args.child) { console.log(JSON.stringify(await child())); process.disconnect(); }
else await parent();
