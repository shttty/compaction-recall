// Offline scaling of the public extension. No provider, AgentSession.prompt, or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep, setImmediate as immediate } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(import.meta.url);
const { values: args } = parseArgs({
  options: {
    data: { type: 'string' }, question: { type: 'string', default: '577d4d32' },
    sizes: { type: 'string', default: '50000,200000,500000,1000000' },
    repeats: { type: 'string', default: '3' }, keep: { type: 'string', default: '20000' },
    output: { type: 'string' }, fixture: { type: 'string' }, arm: { type: 'string' },
    help: { type: 'boolean' },
  }
});
const hash = value => createHash('sha256').update(value).digest('hex');
const command = () => [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const median = values => quantile(values, 0.5);
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

// One JSON object at a time, using a bounded stream; never parse the 2.7GB array.
async function extractQuestion(file, id) {
  let depth = 0, inString = false, escaped = false, parts = [], recordIndex = 0;
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 65536 })) {
    let start = depth ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"' && depth) inString = true;
      else if (c === '{') { if (!depth) start = i; depth++; }
      else if (c === '}') {
        depth--;
        if (!depth) {
          parts.push(chunk.slice(start, i + 1));
          const raw = parts.join('');
          const record = JSON.parse(raw);
          recordIndex++;
          if (record.question_id === id) return { record, recordIndex, recordSha256: hash(raw) };
          parts = []; start = -1;
        }
      }
    }
    if (start >= 0) parts.push(chunk.slice(start));
  }
  throw new Error(`Question ${id} not found in local dataset`);
}

function message(raw, timestamp) {
  assert.ok(['user', 'assistant'].includes(raw.role), 'Only source user/assistant text is supported');
  assert.equal(typeof raw.content, 'string');
  if (raw.role === 'user') return { role: 'user', content: raw.content, timestamp };
  return {
    role: 'assistant', content: [{ type: 'text', text: raw.content }], timestamp,
    api: 'openai-completions', provider: 'offline', model: 'offline-history', stopReason: 'stop',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  };
}

function fixtureFor(record, target, keep, estimateTokens, findCutPoint) {
  const sessions = record.haystack_sessions.map((session, s) =>
    session.map((raw, m) => message(raw, Date.UTC(2023, 0, 1) + s * 86400000 + m)));
  const tokens = sessions.map(session => session.reduce((n, msg) => n + estimateTokens(msg), 0));
  let count = 0, total = 0;
  while (count < sessions.length && total + tokens[count] <= target) total += tokens[count++];
  assert.ok(count > 1, 'Need multiple whole sessions for this tier');
  assert.ok(count < sessions.length, 'Requested tier must leave real source turns for the live batch');
  const messages = sessions.slice(0, count).flat();
  const entries = messages.map((message, i) => ({ type: 'message', id: String(i), message }));
  const firstKeptIndex = findCutPoint(entries, 0, entries.length, keep).firstKeptEntryIndex;
  const retained = messages.slice(firstKeptIndex).reduce((n, msg) => n + estimateTokens(msg), 0);
  assert.ok(firstKeptIndex > 0 && retained >= keep, 'SDK cut must retain the requested recent context');
  const cycles = [];
  for (const session of sessions.slice(count)) {
    for (let i = 0; i + 1 < session.length && cycles.length < 10; i++) {
      if (session[i].role === 'user' && session[i + 1].role === 'assistant') { cycles.push([session[i], session[++i]]); }
    }
    if (cycles.length === 10) break;
  }
  assert.equal(cycles.length, 10, 'Need ten real subsequent source user/assistant cycles');
  const text = msg => msg.role === 'user' ? msg.content : msg.content[0].text;
  const query = record.question;
  assert.equal(typeof query, 'string');
  const grepPattern = query.toLowerCase().match(/[a-z]{5,}/)?.[0];
  assert.ok(grepPattern, 'Question must supply a literal grep term');
  return {
    messages, liveCycles: cycles, query, grepPattern, firstKeptIndex, stats: {
      targetTokens: target, actualTokens: total, sessions: count, messageEntries: messages.length,
      charactersUtf16: messages.reduce((n, msg) => n + text(msg).length, 0),
      charactersCodePoints: messages.reduce((n, msg) => n + Array.from(text(msg)).length, 0),
      compactedTokens: total - retained, retainedTokens: retained,
      compactedEntries: firstKeptIndex, retainedEntries: messages.length - firstKeptIndex,
      liveBatchTokens: cycles.flat().reduce((n, msg) => n + estimateTokens(msg), 0),
      liveBatchEntries: cycles.length * 2, querySha256: hash(query), grepPattern,
    }
  };
}

// Observe the real Worker, not a replacement worker script or a production API patch.
function observeWorkers() {
  const NativeWorker = workerThreads.Worker;
  const active = new Set(), commits = [], failures = [], queryReplies = [];
  let waiter;
  workerThreads.Worker = class extends NativeWorker {
    constructor(...options) {
      super(...options);
      this.scalingRequests = new Map();
      active.add(this);
      this.on('error', error => { failures.push(error.message); waiter?.reject(error); });
      this.on('exit', () => active.delete(this));
      this.on('message', reply => {
        const request = this.scalingRequests.get(reply.requestId);
        this.scalingRequests.delete(reply.requestId);
        if (reply.error) { failures.push(reply.error); waiter?.reject(new Error(reply.error)); }
        if (request?.type === 'query') queryReplies.push(performance.now());
        if (request?.type === 'commit' && !reply.error) {
          const event = { atMs: performance.now(), documents: reply.result.documents };
          commits.push(event);
          // The production listener resolves its commit RPC in this same event turn.
          queueMicrotask(() => waiter?.resolve(event));
        }
      });
    }
    postMessage(value, ...rest) {
      this.scalingRequests.set(value.requestId, { type: value.type });
      return super.postMessage(value, ...rest);
    }
  };
  syncBuiltinESMExports();
  return {
    active, commits, failures, queryReplies,
    nextCommit() {
      assert.equal(waiter, undefined, 'Only one maintenance phase at a time');
      let timeout;
      const promise = new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        timeout = setTimeout(() => reject(new Error('Worker readiness timeout')), 120000);
      });
      return promise.finally(() => { clearTimeout(timeout); waiter = undefined; });
    },
  };
}

async function backgroundMeasure(work) {
  let previous = performance.now(), maxLagMs = 0, samples = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, Math.max(0, now - previous - 5));
    previous = now; samples++;
  }, 5);
  await sleep(15);
  maxLagMs = 0; samples = 0; previous = performance.now();
  const start = performance.now();
  try {
    const value = await work();
    const wallMs = performance.now() - start;
    await sleep(10); // Capture the delayed last heartbeat; excluded from wall time.
    return { wallMs, maxEventLoopDelayMs: maxLagMs, heartbeatSamples: samples, value };
  } finally { clearInterval(heartbeat); }
}

async function hot(work) {
  const samplesMs = [];
  let result;
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    result = await work();
    samplesMs.push(performance.now() - start);
  }
  return {
    samplesMs, p50Ms: quantile(samplesMs, 0.5), p95Ms: quantile(samplesMs, 0.95),
    resultCount: result?.details?.total ?? result?.length ?? null
  };
}

async function child() {
  assert.ok(global.gc, 'Child requires --expose-gc');
  assert.ok(['baseline', 'lite', 'full'].includes(args.arm));
  const observer = observeWorkers();
  // The explicit loader and in-memory session do not create model/provider runtimes.
  globalThis.fetch = () => { throw new Error('Network is forbidden in this offline measurement'); };
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { loadExtensions } = await import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
  const session = sdk.SessionManager.inMemory(process.cwd());
  let input = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
  const stats = input.stats, query = input.query, pattern = input.grepPattern;
  const liveCycles = input.liveCycles;
  const ids = input.messages.map(msg => session.appendMessage(msg));
  const firstKeptId = ids[input.firstKeptIndex], expandId = ids[Math.floor(input.firstKeptIndex / 2)];
  input = null;
  const loaded = await loadExtensions(args.arm === 'baseline' ? [] : [path.join(root, 'src/index.ts')], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), session, undefined);
  const errors = [];
  runner.onError(error => errors.push(error));
  const tools = new Map(runner.getAllRegisteredTools().map(tool => [tool.definition.name, tool.definition]));
  const execute = (name, params) => tools.get(name).execute('scaling', params, undefined, undefined, runner.createToolContext('scaling', undefined));
  session.appendCompaction('[Offline compaction placeholder; no model call.]', firstKeptId, stats.actualTokens);
  const compactionEntry = session.getLeafEntry();
  const compactEvent = { type: 'session_compact', compactionEntry, fromExtension: false, reason: 'manual', willRetry: false };
  session.appendMessage({ role: 'user', content: query, timestamp: Date.UTC(2026, 9, 3) });
  const messages = session.buildSessionContext().messages;
  let background = null, liveBatch = null, coldRequest = null;
  try {
    background = await backgroundMeasure(async () => {
      const ready = args.arm === 'full' ? observer.nextCommit() : undefined;
      await runner.emit({ type: 'session_start', reason: 'startup' });
      await runner.emit(compactEvent);
      return ready ? await ready : null;
    });
    if (args.arm === 'full') {
      assert.equal(background.value.documents, stats.compactedEntries);
      assert.equal(observer.active.size, 1);
    } else assert.equal(observer.active.size, 0);
    // Each arm executes one equivalent request before sampling memory.
    let firstResponse = await runner.emitContext(messages);
    if (args.arm === 'full') assert.equal(observer.queryReplies.length, 1, 'Require a real worker query, not fallback');
    const locatorCount = firstResponse.filter(msg => msg.customType === 'compaction-recall:compacted-locators:v1').length;
    firstResponse = null;
    await immediate(); global.gc();
    const mainAtMs = performance.now(), main = process.memoryUsage();
    const worker = [...observer.active][0];
    let workerSample = null;
    if (worker && typeof worker.getHeapStatistics === 'function') {
      const requestAtMs = performance.now();
      const heap = await worker.getHeapStatistics();
      workerSample = { requestAtMs, receivedAtMs: performance.now(), explicitWorkerGc: false, heap };
    }
    const memory = {
      mainAtMs, mainGc: true, rssBytes: main.rss, mainHeapUsedBytes: main.heapUsed,
      mainExternalBytes: main.external, worker: workerSample,
      workerSamplingNote: worker ? 'Quiescent after same query, separately timestamped; no explicit worker GC; do not sum heaps.' : 'No worker in this arm.'
    };
    const warm = { context: await hot(() => runner.emitContext(messages)) };
    if (args.arm !== 'baseline') {
      if (args.arm === 'full') {
        await execute('history_recall', { query });
        warm.history_recall = await hot(() => execute('history_recall', { query }));
      }
      await execute('history_grep', { pattern });
      warm.history_grep = await hot(() => execute('history_grep', { pattern }));
      await execute('history_expand', { id: expandId });
      warm.history_expand = await hot(() => execute('history_expand', { id: expandId }));
    }
    if (args.arm === 'full') {
      liveBatch = await backgroundMeasure(async () => {
        const ready = observer.nextCommit();
        for (const [user, assistant] of liveCycles) {
          await runner.emit({ type: 'message_end', message: user });
          session.appendMessage(user);
          session.appendMessage(assistant);
          await runner.emit({ type: 'agent_end', messages: [user, assistant] });
        }
        return await ready;
      });
      assert.equal(liveBatch.value.documents, stats.compactedEntries, 'Live cache must not enter postings');
      // Separate cold foreground scenario; this overlaps its rebuild and is not additive.
      const before = observer.queryReplies.length;
      await runner.emit({ type: 'session_tree', oldLeafId: null, newLeafId: session.getLeafId() });
      const start = performance.now();
      await runner.emitContext(messages);
      coldRequest = { wallMs: performance.now() - start, scenario: 'First request immediately after session_tree invalidates the index' };
      assert.ok(observer.queryReplies.length > before);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(observer.failures, []);
    await runner.emit({ type: 'session_shutdown', reason: 'quit' });
    assert.equal(observer.active.size, 0);
    return {
      arm: args.arm, command: command(), pid: process.pid, stats, memory, background, liveBatch, coldRequest, warm,
      locatorCount, workerQueryReplies: observer.queryReplies.length,
      peakRssKiB: process.resourceUsage().maxRSS, shutdown: 'completed', timingFileEnabled: false
    };
  } finally { await runner.emit({ type: 'session_shutdown', reason: 'quit' }); }
}

function summarize(runs, sizes) {
  return sizes.map(target => {
    const byArm = Object.fromEntries(['baseline', 'lite', 'full'].map(arm => [arm, runs.filter(r => r.arm === arm && r.stats.targetTokens === target)]));
    const med = (arm, get) => median(byArm[arm].map(get));
    const baselineRss = med('baseline', r => r.memory.rssBytes);
    const fullRss = med('full', r => r.memory.rssBytes), liteRss = med('lite', r => r.memory.rssBytes);
    const foreground = Object.fromEntries(Object.entries(byArm).map(([arm, rows]) => [arm,
      Object.fromEntries(Object.keys(rows[0].warm).map(name => [name, {
        p50Ms: median(rows.map(r => r.warm[name].p50Ms)), p95Ms: median(rows.map(r => r.warm[name].p95Ms)),
      }]))]));
    return {
      ...byArm.full[0].stats, memory: {
        baselineRssMiB: baselineRss / 1048576, fullRssMiB: fullRss / 1048576, liteRssMiB: liteRss / 1048576,
        fullExtraRssMiB: (fullRss - baselineRss) / 1048576, liteExtraRssMiB: (liteRss - baselineRss) / 1048576,
        mainHeapMiB: Object.fromEntries(Object.keys(byArm).map(arm => [arm, med(arm, r => r.memory.mainHeapUsedBytes) / 1048576])),
        fullWorkerHeapMiB: med('full', r => r.memory.worker?.heap.used_heap_size ?? NaN) / 1048576
      },
      backgroundWallMs: med('full', r => r.background.wallMs), backgroundMaxDelayMs: med('full', r => r.background.maxEventLoopDelayMs),
      contextAddedP50Ms: foreground.full.context.p50Ms - foreground.baseline.context.p50Ms,
      contextAddedP95Ms: foreground.full.context.p95Ms - foreground.baseline.context.p95Ms,
      searchReplyP50Ms: foreground.full.history_recall.p50Ms, searchReplyP95Ms: foreground.full.history_recall.p95Ms,
      coldRequestMs: med('full', r => r.coldRequest.wallMs), liveBatchWallMs: med('full', r => r.liveBatch.wallMs),
      liveBatchMaxDelayMs: med('full', r => r.liveBatch.maxEventLoopDelayMs), foreground
    };
  });
}

async function parent() {
  assert.ok(args.data && args.output, 'Explicit local --data and new --output directory required');
  const sizes = args.sizes.split(',').map(Number), repeats = Number(args.repeats), keep = Number(args.keep);
  assert.ok(sizes.every(n => Number.isSafeInteger(n) && n > keep));
  assert.ok(Number.isInteger(repeats) && repeats > 0 && Number.isSafeInteger(keep) && keep > 0);
  fs.mkdirSync(args.output, { recursive: false });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-recall-scaling-'));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, 'parent-agent');
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
  try {
    const { estimateTokens, findCutPoint } = await import('@earendil-works/pi-coding-agent');
    const extracted = await extractQuestion(args.data, args.question);
    const fixtures = sizes.map(size => fixtureFor(extracted.record, size, keep, estimateTokens, findCutPoint));
    const sdkFiles = ['node_modules/@earendil-works/pi-coding-agent/package.json',
      'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js',
      'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js',
      'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js',
      'node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js'];
    const sourceFiles = ['package.json', 'package-lock.json', 'archive/benchmark/benchmark-scaling.mjs',
      ...fs.readdirSync(path.join(root, 'src')).map(name => `src/${name}`), ...sdkFiles];
    const metadata = {
      createdAt: new Date().toISOString(), command: command(), node: process.version,
      sdkVersion: JSON.parse(fs.readFileSync(path.join(root, sdkFiles[0]), 'utf8')).version,
      cpuModel: os.cpus()[0].model, logicalCpus: os.cpus().length, availableParallelism: os.availableParallelism(),
      platform: process.platform, arch: process.arch, totalMemoryBytes: os.totalmem(),
      sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
      dataset: {
        path: path.resolve(args.data), bytes: fs.statSync(args.data).size, questionId: args.question,
        recordIndex: extracted.recordIndex, recordSha256: extracted.recordSha256, totalSessions: extracted.record.haystack_sessions.length
      },
      repeats, hotSamplesPerProcess: 20, retainedTargetTokens: keep,
      method: {
        tokens: 'SDK 1.0.0 estimateTokens on normalized text messages: sum ceil(UTF-16 text.length / 4), not model tokenizer',
        tiers: 'Largest complete-session prefix not exceeding target; retained suffix uses SDK findCutPoint(entries, 0, length, keepRecentTokens)',
        baseline: 'Same SDK SessionManager.inMemory + ExtensionRunner, no extensions and no model/provider/UI runtime',
        timing: 'External performance.now; production timing disabled in every arm; 5ms heartbeat excess over scheduled interval',
        ready: 'Real Worker commit response, followed by production commit promise microtasks; no source changes',
        memory: 'After readiness and one context query, main-thread global.gc then RSS/main heap; separate quiescent Worker.getHeapStatistics, no worker GC and no summing',
        warm: '20 context/tool samples per fresh process; tools get one untimed warmup; nearest-rank p50/p95 then median across processes',
        rssDelta: 'Median arm RSS minus same-tier median baseline RSS; not a sum of heaps',
        contextAdded: 'Median arm context percentile minus matching baseline context percentile; SDK clone included in both',
        background: 'Startup on a precompacted SDK session: session_start + session_compact dispatch through commit; SDK appendCompaction excluded',
        liveBatch: 'Next ten original source user/assistant pairs after prefix; append and real cadence hooks through commit; still uncompressed',
        cold: 'Separate immediate context request after session_tree reset; includes overlapping worker rebuild, do not add to background time',
        query: 'Original question for context/recall; grep first ASCII word of >=5 letters in question; expand middle compacted entry, defaults',
      }
    };
    assert.equal(metadata.sdkVersion, '1.0.0');
    writeJson(path.join(args.output, 'metadata.json'), metadata);
    const runs = [], arms = ['baseline', 'lite', 'full'];
    for (const fixture of fixtures) {
      const fixtureFile = path.join(temporary, `${fixture.stats.targetTokens}.json`);
      writeJson(fixtureFile, fixture);
      for (let repeat = 0; repeat < repeats; repeat++) {
        for (const arm of [...arms.slice(repeat % 3), ...arms.slice(0, repeat % 3)]) {
          const directory = path.join(temporary, `${fixture.stats.targetTokens}-${repeat}-${arm}`);
          const agentDir = path.join(directory, 'agent');
          fs.mkdirSync(agentDir, { recursive: true });
          const env = {
            PATH: process.env.PATH, HOME: directory, TMPDIR: directory, PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: '1', DO_NOT_TRACK: '1', COMPACTION_RECALL_MODE: arm === 'lite' ? 'lite' : 'full'
          };
          const childArgs = ['--expose-gc', script, '--arm', arm, '--fixture', fixtureFile];
          const result = spawnSync(process.execPath, childArgs, { cwd: directory, env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '', 'Child stderr must be empty');
          const run = { repetition: repeat + 1, ...JSON.parse(result.stdout) };
          writeJson(path.join(args.output, `${fixture.stats.targetTokens}-${arm}-${repeat + 1}.json`), run);
          runs.push(run);
          console.log(JSON.stringify({
            target: fixture.stats.targetTokens, arm, repeat: repeat + 1, rssMiB: run.memory.rssBytes / 1048576,
            backgroundMs: run.background.wallMs, contextP50Ms: run.warm.context.p50Ms
          }));
        }
      }
    }
    const rows = summarize(runs, sizes);
    const summary = { metadata: 'metadata.json', runCount: runs.length, rows };
    if (rows.length > 1) summary.endpointFullExtraRssMiBPer100kCompactedTokens =
      (rows.at(-1).memory.fullExtraRssMiB - rows[0].memory.fullExtraRssMiB) / (rows.at(-1).compactedTokens - rows[0].compactedTokens) * 100000;
    writeJson(path.join(args.output, 'summary.json'), summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (args.help) console.log('node benchmark/benchmark-scaling.mjs --data LOCAL_LONGMEMEVAL_M_JSON --output NEW_DIRECTORY [--question 577d4d32] [--sizes 50000,200000,500000,1000000] [--repeats 3] [--keep 20000]');
else if (args.arm) console.log(JSON.stringify(await child()));
else await parent();
