import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { validateArm } from '../prototype/soft-match-sqlite/arms.mjs';

export function createEngine(documents, { arm = process.env.COMPACTION_RECALL_SQLITE_ARM ?? 'off',
  execution = arm === 'jieba' ? 'worker' : 'sync' } = {}) {
  validateArm(arm);
  if (execution === 'worker') return threadedEngine(documents, arm);
  if (execution !== 'sync') throw new Error('execution must be sync or worker');
  const index = createIndex(documents, { arm });
  return {
    searchAuto(question) {
      return index.search(question, { automatic: true, limit: documents.length }).results;
    },
    searchRaw(query, options) {
      return index.searchRaw(query, options);
    },
    dispose() {
      index.close();
    },
  };
}

function threadedEngine(documents, arm) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { sqliteEvaluationEngine: true, documents, arm }, execArgv: [] });
  return new Promise((resolve, reject) => {
    const pending = new Map();
    let sequence = 0;
    const fail = error => { reject(error); for (const request of pending.values()) request.reject(error); pending.clear(); };
    worker.on('error', fail);
    worker.on('exit', code => { if (code || pending.size) fail(new Error(`SQLite evaluation worker exited ${code}`)); });
    const request = (method, query, options) => new Promise((resolve, reject) => {
      const id = sequence++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, query, options });
    });
    worker.on('message', message => {
      if (message.ready) {
        resolve({
          searchAuto: query => request('searchAuto', query),
          searchRaw: (query, options) => request('searchRaw', query, options),
          dispose: async () => { try { await request('dispose'); } finally { await worker.terminate(); } }
        });
        return;
      }
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
      else waiting.resolve(message.value);
    });
  });
}

// For jieba, even the synchronous index stays inside a worker. The main thread
// imports only the pure-JS arm selector; native addon and dictionary stay here.
if (!isMainThread && workerData?.sqliteEvaluationEngine) {
  const engine = createEngine(workerData.documents, { arm: workerData.arm, execution: 'sync' });
  parentPort.postMessage({ ready: true });
  parentPort.on('message', ({ id, method, query, options }) => {
    try { parentPort.postMessage({ id, value: engine[method](query, options) }); }
    catch (error) { parentPort.postMessage({ id, error: { name: error.name, message: error.message } }); }
  });
}
