import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { measured } from '../observability/timing.mjs';
import { createQueryCheck, queryNow } from '../sqlite/sqlite-deadline.mjs';
import { parseQuery } from '../query/concept-query.mjs';
import { buildIndex, cancelled, prepareIndex } from './sqlite-background-build.mjs';
// jiti transforms import.meta.url; its CommonJS filename remains the original source.
const sourceURL = typeof __filename === 'string' ? pathToFileURL(__filename) : import.meta.url;
export class SQLiteBackgroundIndex {
 /** @param {{timer?: import('../observability/timing.mjs').StageTiming, autoGate?: number, recallTimeoutMs?: number, snippetBudget?: number, jieba?: boolean, workerFactory?: (options: {engineOptions: {autoGate: number, snippetBudget: number, jieba: boolean}}) => Worker, yieldFn?: () => Promise<unknown>}} options */
 constructor({ timer, autoGate = 280, recallTimeoutMs = 5000, snippetBudget = 240, jieba = true,
  workerFactory = options => new Worker(new URL('./index-worker.mjs', sourceURL), { workerData: options, execArgv: [] }), yieldFn = yieldImmediate } = {}) {
  Object.assign(this, { timer, engineOptions: { autoGate, snippetBudget, jieba }, recallTimeoutMs, workerFactory, yieldFn });
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
 /** @type {Set<NodeJS.Timeout> | undefined} */
 memoryTimers;
 memoryDocuments = 0;
 event(stage, fields = {}) { this.timer?.mark(stage, fields); }
 async stopWorker() {
  if (this.memoryTimers) {
   for (const timer of this.memoryTimers) clearTimeout(timer);
   this.memoryTimers.clear();
  }
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
  if (this.worker && !this.failed) {
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
  const worker = this.workerFactory({ engineOptions: this.engineOptions });
  this.worker = worker;
  worker.on('online', () => { if (this.worker === worker) this.event('worker_online'); });
  worker.on('message', message => {
   if (this.worker !== worker) return;
   const pending = this.pending.get(message.requestId);
   if (!pending) return;
   this.pending.delete(message.requestId);
   if (message.stages) this.timer?.merge(message.stages, message.timingOrigin);
   if (message.generation !== this.generation) pending.reject(cancelled());
   else if (message.error !== undefined) pending.reject(Object.assign(new Error(message.error), { name: message.errorName ?? 'Error', ...(typeof message.errorCode === 'string' ? { code: message.errorCode } : {}), engineError: message.engineError === true }));
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
  return prepareIndex(this, branch, preindexLive);
 }
 build(next, from, append, generation) {
  return buildIndex(this, next, from, append, generation);
 }
 /** @param {Worker} worker @param {number} generation @param {number} entries
  * @param {'post_build' | 'settled'} phase */
 async sampleMemory(worker, generation, entries, phase) {
  const path = process.env.COMPACTION_RECALL_TIMING_FILE;
  if (!this.timer || !path || this.disposed || generation !== this.generation || worker !== this.worker || worker.threadId === -1) return;
  try {
   const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
   const heap = await worker.getHeapStatistics();
   if (this.disposed || generation !== this.generation || worker !== this.worker || worker.threadId === -1) return;
   this.event('index_memory', {
    processRssBytes: rss, mainHeapUsedBytes: heapUsed, workerHeapBytes: heap.used_heap_size, entries,
    mainHeapTotalBytes: heapTotal, mainExternalBytes: external + arrayBuffers,
    workerHeapTotalBytes: heap.total_heap_size,
    ...(typeof heap.external_memory === 'number' ? { workerExternalBytes: heap.external_memory } : {}), phase,
   });
   return path;
  } catch { /* Optional diagnostics cannot invalidate a completed index. */ }
 }
 /** @param {unknown} query @param {import('@earendil-works/pi-coding-agent').SessionEntry[]} branch
  * @param {{mode?: 'auto' | 'manual', options?: {limit?: number, offset?: number, page?: boolean, recentUserTexts?: string[]}, timeoutMs?: number}} settings */
 async queryRanked(query, branch, { mode = 'auto', options = {}, timeoutMs = this.recallTimeoutMs } = {}) {
  let check;
  if (mode === 'manual') {
   const queryDeadlineAt = queryNow() + timeoutMs;
   check = createQueryCheck(queryDeadlineAt, timeoutMs);
   // Validate before structured cloning can erase a non-plain input prototype; count overflow is clamped and
   // reported by the worker, so it is not an error here.
   parseQuery(query, { clamped: [] });
   options = { ...options, queryDeadlineAt, queryTimeoutMs: timeoutMs };
  }
  this.activeQueries++;
  try {
   const preparation = this.prepare(branch), generation = this.generation;
   const wait = async () => { if (!this.serveWhilePreparing) await preparation; };
   if (this.timer) await this.timer.runAsync('critical_path_index_wait', wait); else await wait();
   if (generation !== this.generation || this.disposed) throw cancelled();
   if (this.failed) throw this.failure ?? new Error('Index worker unavailable');
   let result;
   try {
    result = await this.rpc('query', { query, mode, options }, generation);
   }
   catch (error) {
    if (generation !== this.generation || this.disposed) throw cancelled();
    if (error.engineError) throw error;
    this.failure = error;
    this.failed = true;
    await this.stopWorker();
    throw error;
   }
   // Native MATCH cannot be preempted; never deliver a result past its deadline.
   check?.();
   return result;
  } finally {
   if (--this.activeQueries === 0) {
    for (const resolve of this.queryIdleWaiters.splice(0)) resolve();
   }
  }
 }
 /** @param {unknown} query @param {import('@earendil-works/pi-coding-agent').SessionEntry[]} branch
  * @param {{limit?: number, offset?: number}} options
  * @returns {Promise<{total: number, page: ReturnType<typeof import('../sqlite/sqlite-page.mjs').sqliteRecallPage>, ids: string[]}>} */
 async queryPage(query, branch, options = {}) {
  return /** @type {any} */ (await this.queryRanked(query, branch, { mode: 'manual', options: { ...options, page: true } }));
 }
}
