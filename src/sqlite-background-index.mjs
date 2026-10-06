import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { BackgroundIndex } from './background-index.mjs';
import { createQueryCheck, queryNow } from './sqlite-deadline.mjs';
import { parseQuery } from './concept-query-compiler.mjs';

const sourceURL = typeof __filename === 'string' ? pathToFileURL(__filename) : import.meta.url;

export class SQLiteBackgroundIndex extends BackgroundIndex {
 /** @param {{timer?: import('./timing.mjs').StageTiming, autoGate?: number, recallTimeoutMs?: number, snippetBudget?: number, jieba?: boolean, engineModule?: URL}} options */
 constructor({ timer, autoGate = 280, recallTimeoutMs = 5000, snippetBudget = 240, jieba = true,
  engineModule = new URL('./default-worker-engine.mjs', sourceURL) } = {}) {
  const engineOptions = { autoGate, snippetBudget, jieba };
  super({ timer, engineModule, workerFactory: options => new Worker(new URL('./index-worker.mjs', sourceURL),
   { workerData: { ...options, engineOptions }, execArgv: [] }) });
  this.recallTimeoutMs = recallTimeoutMs;
 }
 /** @param {unknown} query @param {import('@earendil-works/pi-coding-agent').SessionEntry[]} branch
  * @param {{mode?: 'auto' | 'manual', options?: {limit?: number, offset?: number, page?: boolean}, timeoutMs?: number}} settings */
 async queryRanked(query, branch, settings = {}) {
  if (settings.mode !== 'manual') return super.queryRanked(query, branch, settings);
  const timeoutMs = settings.timeoutMs ?? this.recallTimeoutMs;
  const queryDeadlineAt = queryNow() + timeoutMs;
  const check = createQueryCheck(queryDeadlineAt, timeoutMs);
  // Validate before structured cloning can erase a non-plain input prototype.
  // Keep the original object for worker compilation and content trace.
  parseQuery(query);
  const options = { ...settings.options, queryDeadlineAt, queryTimeoutMs: timeoutMs };
  const result = await super.queryRanked(query, branch, { ...settings, options });
  // Native MATCH cannot be preempted; never deliver a result past its deadline.
  check();
  return result;
 }
 /** @param {unknown} query @param {import('@earendil-works/pi-coding-agent').SessionEntry[]} branch
  * @param {{limit?: number, offset?: number}} options
  * @returns {Promise<{total: number, page: ReturnType<typeof import('./sqlite-page.mjs').sqliteRecallPage>, ids: string[]}>} */
 async queryPage(query, branch, options = {}) {
  return /** @type {any} */ (await this.queryRanked(query, branch, { mode: 'manual', options: { ...options, page: true } }));
 }
}
