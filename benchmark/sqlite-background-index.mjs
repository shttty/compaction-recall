import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { BackgroundIndex } from '../src/background-index.mjs';
import { createQueryCheck, queryNow } from '../prototype/soft-match-sqlite/deadline.mjs';

const sourceURL = typeof __filename === 'string' ? pathToFileURL(__filename) : import.meta.url;

export class SQLiteBackgroundIndex extends BackgroundIndex {
 constructor({ timer, arm = process.env.COMPACTION_RECALL_SQLITE_ARM ?? 'off', autoGate = 210,
  recallTimeoutMs = 5000, snippetBudget, engineModule = new URL('./retrieval-sqlite-worker.mjs', sourceURL) } = {}) {
  const env = {
   ...process.env, COMPACTION_RECALL_SQLITE_ARM: arm, COMPACTION_RECALL_AUTO_GATE: String(autoGate),
   COMPACTION_RECALL_SNIPPET_BUDGET: snippetBudget === undefined ? '' : String(snippetBudget)
  };
  super({ timer, engineModule, workerFactory: options => new Worker(new URL('../src/index-worker.mjs', sourceURL), { workerData: options, env, execArgv: [] }) });
  this.recallTimeoutMs = recallTimeoutMs;
 }
 /** @param {string} query @param {import('@earendil-works/pi-coding-agent').SessionEntry[]} branch
  * @param {{mode?: 'auto' | 'manual', options?: {limit?: number, offset?: number, page?: boolean}, timeoutMs?: number}} settings */
 async queryRanked(query, branch, settings = {}) {
  if (settings.mode !== 'manual') return super.queryRanked(query, branch, settings);
  const timeoutMs = settings.timeoutMs ?? this.recallTimeoutMs;
  const queryDeadlineAt = queryNow() + timeoutMs;
  const check = createQueryCheck(queryDeadlineAt, timeoutMs);
  const options = { ...settings.options, queryDeadlineAt, queryTimeoutMs: timeoutMs };
  const result = await super.queryRanked(query, branch, { ...settings, options });
  // Native MATCH cannot be preempted; never deliver a result past its deadline.
  check();
  return result;
 }
 /** @param {string} query @param {import('@earendil-works/pi-coding-agent').SessionEntry[]} branch
  * @param {{limit?: number, offset?: number}} options
  * @returns {Promise<{total: number, page: ReturnType<typeof import('./retrieval-sqlite-page.mjs').sqliteRecallPage>, ids: string[], missingTerms: string[]}>} */
 async queryPage(query, branch, options = {}) {
  return /** @type {any} */ (await this.queryRanked(query, branch, { mode: 'manual', options: { ...options, page: true } }));
 }
}
