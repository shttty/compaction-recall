import { branchMessageEntries, compactedEntries } from '../history/history.mjs';
import { locatorText } from '../history/locator.mjs';
import { measured } from '../observability/timing.mjs';

export const cancelled = () => Object.assign(new Error('Index generation cancelled'), { name: 'AbortError' });

/** @param {import('./sqlite-background-index.mjs').SQLiteBackgroundIndex} index */
export function prepareIndex(index, branch, preindexLive) {
 if (index.disposed) return Promise.reject(cancelled());
 if (preindexLive && index.activeQueries) {
  const generation = index.generation;
  return new Promise(resolve => index.queryIdleWaiters.push(resolve)).then(() => {
   if (generation !== index.generation || index.disposed) throw cancelled();
   return index.prepare(branch, { preindexLive: true });
  });
 }
 const next = measured(index.timer, 'main_branch_selection', () => {
  if (!index.branch || branch.length !== index.branch.length || branch.some((entry, i) => entry !== index.branch[i])) {
   index.branch = branch.slice();
   index.fullEntries = measured(index.timer, 'branch_projection', () => branchMessageEntries(branch));
   index.compacted = measured(index.timer, 'compacted_selection', () => index.fullEntries.slice(0, compactedEntries(branch).length));
  }
  const preserve = index.entries.length >= index.compacted.length && index.entries.every((entry, i) => entry === index.fullEntries[i]);
  return preindexLive ? index.fullEntries : preserve ? index.entries : index.compacted;
 });
 const eligibleCount = index.compacted.length;
 const same = next.length === index.entries.length && next.every((entry, i) => entry === index.entries[i]);
 if (same && index.eligibleCount === eligibleCount && index.preparation) return index.preparation;
 let append = index.ready && next.length >= index.entries.length && index.entries.every((entry, i) => entry === next[i]);
 const seen = new Set(index.entries.filter(entry => ['user', 'assistant'].includes(entry.message.role)).map(entry => entry.id));
 for (const entry of next.slice(index.entries.length)) {
  if (!['user', 'assistant'].includes(entry.message.role)) continue;
  if (seen.has(entry.id)) append = false;
  seen.add(entry.id);
 }
 const from = append ? index.entries.length : 0;
 const serveOld = append && index.eligibleCount === eligibleCount;
 if (!append && index.worker) void index.stopWorker();
 const generation = ++index.generation;
 index.entries = next;
 index.eligibleCount = eligibleCount;
 index.serveWhilePreparing = serveOld;
 index.ready = false;
 const build = () => index.build(next, from, append, generation);
 index.preparation = (index.timer ? index.timer.runAsync('background_prepare', build) : build()).catch(error => {
  if (generation !== index.generation || index.disposed) throw cancelled();
  index.failed = true;
  index.failure = error;
  void index.stopWorker();
  index.event('worker_failed');
  throw error;
 });
 return index.preparation;
}

/** @param {import('./sqlite-background-index.mjs').SQLiteBackgroundIndex} index */
export async function buildIndex(index, next, from, append, generation) {
 if (index.failed) return;
 await index.termination;
 if (generation !== index.generation || index.disposed) throw cancelled();
 index.startWorker();
 await index.rpc('begin', { append, eligibleCount: index.eligibleCount }, generation);
 let batch = [], chars = 0;
 const flush = async () => {
  if (batch.length) { await index.rpc('batch', { entries: batch }, generation); batch = []; chars = 0; }
  await index.yieldFn();
 };
 for (let i = from; i < next.length; i++) {
  if (generation !== index.generation || index.disposed) throw cancelled();
  const original = next[i];
  if (!['user', 'assistant'].includes(original.message.role)) continue;
  const text = measured(index.timer, 'main_text_extraction', () => locatorText(original.message));
  const entry = { type: 'message', sourcePosition: i, id: original.id, timestamp: original.timestamp, message: { role: original.message.role, content: text } };
  if (text.length > 65536) {
   await flush();
   await index.rpc('large_start', { entry: { ...entry, message: { ...entry.message, content: '' } } }, generation);
   for (let at = 0; at < text.length; at += 65536) {
    await index.rpc('large_chunk', { text: text.slice(at, at + 65536) }, generation);
    await index.yieldFn();
   }
   await index.rpc('large_end', {}, generation);
  } else {
   if (chars + text.length > 65536) await flush();
   batch.push(entry); chars += text.length;
  }
  if (batch.length >= 32 || chars >= 65536) await flush();
 }
 await flush();
 const result = await index.rpc('commit', {}, generation);
 if (generation !== index.generation || index.disposed) throw cancelled();
 index.ready = true;
 index.event('background_index_ready', { kind: append ? 'incremental_update' : 'build_or_rebuild', documents: result.documents, workerHeapBytes: result.heapUsed });
 if (index.timer && process.env.COMPACTION_RECALL_TIMING_FILE) {
  const worker = index.worker;
  index.memoryDocuments = result.documents;
  await index.sampleMemory(worker, generation, result.documents, 'post_build');
  if (generation !== index.generation || index.disposed) throw cancelled();
  if (worker !== index.worker || worker.threadId === -1) return;
  index.memoryTimers ??= new Set();
  const timer = setTimeout(() => {
   index.memoryTimers.delete(timer);
   // Later commits may have changed the document count in this same worker.
   void index.sampleMemory(worker, generation, index.memoryDocuments, 'settled')
    .then(path => { if (path) index.timer?.flush(path); }).catch(() => { });
  }, 3000);
  timer.unref();
  index.memoryTimers.add(timer);
 }
}
