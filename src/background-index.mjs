import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { branchMessageEntries, compactedEntries } from './history.mjs';
import { locatorText, buildLocator, buildRecallPage, formatLocatorRows, recallPageFromRows } from './locator.mjs';
import { measured } from './timing.mjs';

// jiti transforms import.meta.url; its CommonJS filename remains the original source.
const sourceURL = typeof __filename === 'string' ? pathToFileURL(__filename) : import.meta.url;
const cancelled = () => Object.assign(new Error('Index generation cancelled'), { name: 'AbortError' });
export class BackgroundIndex {
 /** @param {{timer?: import('./timing.mjs').StageTiming, engineModule?: string | URL, workerFactory?: (options: {engineModule?: string}) => Worker, yieldFn?: () => Promise<unknown>}} options */
 constructor({ timer, engineModule, workerFactory = options => new Worker(new URL('./index-worker.mjs', sourceURL), { workerData: options }), yieldFn = yieldImmediate } = {}) {
  if (engineModule !== undefined && new URL(engineModule).protocol !== 'file:') throw new TypeError('engineModule must be an explicit file URL');
  Object.assign(this, { timer, engineModule: engineModule === undefined ? undefined : String(engineModule), workerFactory, yieldFn });
  this.generation = 0;
  this.nextRequest = 0;
  this.pending = new Map();
  this.entries = [];
  this.eligibleCount = 0;
  this.ready = false;
  this.disposed = false;
  this.failed = false;
  this.worker = null;
  this.preparation = null;
  this.termination = Promise.resolve();
  this.failure = null;
 }
 branch = null;
 fullEntries = [];
 compacted = [];
 serveWhilePreparing = false;
 activeQueries = 0;
 queryIdleWaiters = [];
 event(stage, fields = {}) { this.timer?.mark(stage, fields); }
 async stopWorker() {
  const worker = this.worker;
  this.worker = null;
  for (const { reject } of this.pending.values()) reject(cancelled());
  this.pending.clear();
  if (worker) {
   const previous = this.termination;
   this.termination = Promise.all([previous, worker.terminate()]).then(() => undefined);
  }
  await this.termination;
 }
 reset() {
  this.generation++;
  const stopped = this.stopWorker();
  this.disposed = false;
  this.branch = null;
  this.fullEntries = [];
  this.compacted = [];
  this.entries = [];
  this.eligibleCount = 0;
  this.ready = false;
  this.serveWhilePreparing = false;
  this.failed = false;
  this.failure = null;
  this.preparation = null;
  return stopped;
 }
 async dispose() {
  if (this.engineModule && this.worker && !this.failed) {
   try { await this.rpc('dispose', {}, this.generation); } catch { /* Termination still awaited. */ }
  }
  this.disposed = true;
  this.generation++;
  await this.stopWorker();
  this.branch = null;
  this.fullEntries = [];
  this.compacted = [];
  this.entries = [];
  this.preparation = null;
  this.ready = false;
 }
 startWorker() {
  if (this.worker) return;
  const worker = this.workerFactory({ engineModule: this.engineModule });
  this.worker = worker;
  worker.on('online', () => { if (this.worker === worker) this.event('worker_online'); });
  worker.on('message', message => {
   if (this.worker !== worker) return;
   const pending = this.pending.get(message.requestId);
   if (!pending) return;
   this.pending.delete(message.requestId);
   if (message.stages) this.timer?.merge(message.stages, message.timingOrigin);
   if (message.generation !== this.generation) pending.reject(cancelled());
   else if (message.error !== undefined) pending.reject(Object.assign(new Error(message.error), { name: message.errorName ?? 'Error', engineError: message.engineError === true }));
   else pending.resolve(message.result);
  });
  const fail = () => {
   if (this.worker !== worker) return;
   this.failed = true;
   this.ready = false;
   void this.stopWorker();
   this.event('worker_failed');
  };
  worker.on('error', fail);
  worker.on('exit', fail);
 }
 rpc(type, payload, generation) {
  const send = () => new Promise((resolve, reject) => {
   if (generation !== this.generation || this.disposed) return reject(cancelled());
   const requestId = ++this.nextRequest;
   this.pending.set(requestId, { resolve, reject });
   const timing = this.timer?.capture();
   try {
    measured(this.timer, 'worker_post_message', () => this.worker.postMessage({
     type, requestId, generation, ...payload,
     ...(timing ? { timing } : {}),
    }));
   } catch (error) { this.pending.delete(requestId); reject(error); }
  });
  return this.timer ? this.timer.runAsync(`worker_roundtrip_${type}`, send) : send();
 }
 prepare(branch, { preindexLive = false } = {}) {
  if (this.disposed) return Promise.reject(cancelled());
  if (preindexLive && this.activeQueries) {
   const generation = this.generation;
   return new Promise(resolve => this.queryIdleWaiters.push(resolve)).then(() => {
    if (generation !== this.generation || this.disposed) throw cancelled();
    return this.prepare(branch, { preindexLive: true });
   });
  }
  const next = measured(this.timer, 'main_branch_selection', () => {
   if (!this.branch || branch.length !== this.branch.length || branch.some((entry, i) => entry !== this.branch[i])) {
    this.branch = branch.slice();
    this.fullEntries = measured(this.timer, 'branch_projection', () => branchMessageEntries(branch));
    this.compacted = measured(this.timer, 'compacted_selection', () => this.fullEntries.slice(0, compactedEntries(branch).length));
   }
   const preserve = this.entries.length >= this.compacted.length && this.entries.every((entry, i) => entry === this.fullEntries[i]);
   return preindexLive ? this.fullEntries : preserve ? this.entries : this.compacted;
  });
  const eligibleCount = this.compacted.length;
  const same = next.length === this.entries.length && next.every((entry, i) => entry === this.entries[i]);
  if (same && this.eligibleCount === eligibleCount && this.preparation) return this.preparation;
  let append = this.ready && next.length >= this.entries.length && this.entries.every((entry, i) => entry === next[i]);
  const seen = new Set(this.entries.filter(entry => ['user', 'assistant'].includes(entry.message.role)).map(entry => entry.id));
  for (const entry of next.slice(this.entries.length)) {
   if (!['user', 'assistant'].includes(entry.message.role)) continue;
   if (seen.has(entry.id)) append = false;
   seen.add(entry.id);
  }
  const from = append ? this.entries.length : 0;
  const serveOld = append && this.eligibleCount === eligibleCount;
  if (!append && this.worker) void this.stopWorker();
  const generation = ++this.generation;
  this.entries = next;
  this.eligibleCount = eligibleCount;
  this.serveWhilePreparing = serveOld;
  this.ready = false;
  const build = () => this.build(next, from, append, generation);
  this.preparation = (this.timer ? this.timer.runAsync('background_prepare', build) : build()).catch(error => {
   if (generation !== this.generation || this.disposed) throw cancelled();
   this.failed = true;
   this.failure = error;
   void this.stopWorker();
   this.event('fallback_required');
   if (this.engineModule) throw error;
  });
  return this.preparation;
 }
 async build(next, from, append, generation) {
  if (this.failed) return;
  await this.termination;
  if (generation !== this.generation || this.disposed) throw cancelled();
  this.startWorker();
  await this.rpc('begin', { append, eligibleCount: this.eligibleCount }, generation);
  let batch = [], chars = 0;
  const flush = async () => {
   if (batch.length) { await this.rpc('batch', { entries: batch }, generation); batch = []; chars = 0; }
   await this.yieldFn();
  };
  for (let i = from; i < next.length; i++) {
   if (generation !== this.generation || this.disposed) throw cancelled();
   const original = next[i];
   if (!['user', 'assistant'].includes(original.message.role)) continue;
   const text = measured(this.timer, 'main_text_extraction', () => locatorText(original.message));
   const entry = { type: 'message', sourcePosition: i, id: original.id, timestamp: original.timestamp, message: { role: original.message.role, content: text } };
   if (text.length > 65536) {
    await flush();
    await this.rpc('large_start', { entry: { ...entry, message: { ...entry.message, content: '' } } }, generation);
    for (let at = 0; at < text.length; at += 65536) {
     await this.rpc('large_chunk', { text: text.slice(at, at + 65536) }, generation);
     await this.yieldFn();
    }
    await this.rpc('large_end', {}, generation);
   } else {
    if (chars + text.length > 65536) await flush();
    batch.push(entry); chars += text.length;
   }
   if (batch.length >= 32 || chars >= 65536) await flush();
  }
  await flush();
  const result = await this.rpc('commit', {}, generation);
  if (generation !== this.generation || this.disposed) throw cancelled();
  this.ready = true;
  this.event('background_index_ready', { kind: append ? 'incremental_update' : 'build_or_rebuild', documents: result.documents, workerHeapBytes: result.heapUsed });
  if (this.timer && process.env.COMPACTION_RECALL_TIMING_FILE) {
   const worker = this.worker;
   try {
    const { rss, heapUsed } = process.memoryUsage();
    const heap = await worker.getHeapStatistics();
    if (generation !== this.generation || this.disposed || worker !== this.worker) throw cancelled();
    this.event('index_memory', { processRssBytes: rss, mainHeapUsedBytes: heapUsed, workerHeapBytes: heap.used_heap_size, entries: result.documents });
   } catch (error) {
    if (generation !== this.generation || this.disposed) throw cancelled();
    // Optional diagnostics cannot invalidate a completed index.
   }
  }
 }
 scan(query, branch, mode, options) {
  return measured(this.timer, 'synchronous_scan_fallback', () => mode === 'manual' ? buildRecallPage(query, branch, options, this.timer) : buildLocator(query, branch, this.timer));
 }
 /** @param {unknown} query @param {import('@earendil-works/pi-coding-agent').SessionEntry[]} branch
  * @param {{mode?: 'auto' | 'manual', options?: {limit?: number, offset?: number}}} [settings] */
 queryRanked(query, branch, settings = {}) {
  if (!this.engineModule) throw new TypeError('queryRanked requires an explicit engineModule');
  return this.query(query, branch, { ...settings, ranked: true });
 }
 /**
  * @overload
  * @param {unknown} query
  * @param {import('@earendil-works/pi-coding-agent').SessionEntry[]} branch
  * @param {{mode?: 'auto' | 'manual', options?: {limit?: number, offset?: number}, ranked: true}} settings
  * @returns {Promise<{total: number, results: {id: string, date: string, role: string, snippet: string, score?: number}[]}>}
  */
 /**
  * @overload
  * @param {string} query
  * @param {import('@earendil-works/pi-coding-agent').SessionEntry[]} branch
  * @param {{mode: 'manual', options?: {limit?: number, offset?: number}}} settings
  * @returns {Promise<ReturnType<typeof buildRecallPage>>}
  */
 /**
  * @overload
  * @param {string} query
  * @param {import('@earendil-works/pi-coding-agent').SessionEntry[]} branch
  * @param {{mode?: 'auto', options?: {limit?: number, offset?: number}}} [settings]
  * @returns {Promise<string | undefined>}
  */
 async query(query, branch, { mode = 'auto', options = {}, ranked = false } = {}) {
  this.activeQueries++;
  try {
   const preparation = this.prepare(branch), generation = this.generation;
   const wait = async () => { if (!this.serveWhilePreparing) await preparation; };
   if (this.timer) await this.timer.runAsync('critical_path_index_wait', wait); else await wait();
   if (generation !== this.generation || this.disposed) throw cancelled();
   if (this.failed) {
    if (this.engineModule) throw this.failure ?? new Error('Index worker unavailable');
    return this.scan(query, branch, mode, options);
   }
   try {
    const result = await this.rpc('query', { query, mode, options }, generation);
    if (ranked) return result;
    const rows = this.engineModule ? result.results.map(({ id, date, role, snippet }) => ({ id, date, role, snippet })) : result.results;
    return mode === 'manual' ? recallPageFromRows(rows, options, this.timer)
     : measured(this.timer, 'auto_render_budget', () => formatLocatorRows(rows));
   }
   catch (error) {
    if (generation !== this.generation || this.disposed) throw cancelled();
    if (this.engineModule && error.engineError) throw error;
    this.failure = error;
    this.failed = true;
    await this.stopWorker();
    if (this.engineModule) throw error;
    return this.scan(query, branch, mode, options);
   }
  } finally {
   if (--this.activeQueries === 0) {
    for (const resolve of this.queryIdleWaiters.splice(0)) resolve();
   }
  }
 }
}
