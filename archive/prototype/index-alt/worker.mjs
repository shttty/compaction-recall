// Throwaway storage comparison. The production worker protocol is unchanged.
import { parentPort, workerData } from 'node:worker_threads';
import { lex } from '../../js-runtime/locator.mjs';
import { StageTiming, measured } from '../../../src/timing.mjs';
const { variant } = workerData;
const index = variant === 'A'
  ? new (await import('./typed-index.mjs')).TypedIndex()
  : variant === 'B3' ? new (await import('./b3-index.mjs')).B3Index()
    : new (await import('./sqlite-index.mjs')).SqliteIndex(undefined, variant);
const b3Tokens = variant === 'B3' ? await import('./b3-tokenize.mjs') : null;
let timing, active = [], staging = [], generation = 0, partial = null, eligibleCount = 0, eligibleBranch = [];
function tokenize(entry) {
  if (b3Tokens) return {
    ...entry, b3Prepared: {
      bi: b3Tokens.bigramText(entry.message.content), uni: b3Tokens.unigramText(entry.message.content),
    }
  };
  const tokens = new Map(); let order = 0;
  for (const { term, offset } of lex(entry.message.content)) {
    if (!tokens.has(term)) tokens.set(term, { offset, order });
    order++;
  }
  return { ...entry, tokens };
}
function branch(entries) {
  const ids = new Set(entries.map(entry => entry.id));
  let kept = 'worker-kept'; while (ids.has(kept)) kept += '-';
  return [...entries,
  { type: 'compaction', id: 'worker-boundary', firstKeptEntryId: kept, summary: '', timestamp: '2000-01-01' },
  { type: 'message', id: kept, timestamp: '2000-01-01', message: { role: 'user', content: '' } }];
}
function handle(message) {
  if (message.type === 'begin') {
    generation = message.generation; eligibleCount = message.eligibleCount;
    staging = message.append ? active.slice() : []; partial = null;
    timing?.mark('worker_maintenance', { kind: message.append ? 'incremental_update' : 'build_or_rebuild', entries: eligibleCount, execution: 'worker_thread' });
    return;
  }
  if (message.generation !== generation) throw new Error('Obsolete generation');
  if (message.type === 'batch') {
    staging.push(...measured(timing, 'live_or_eligible_tokenization', () => message.entries.map(tokenize)));
  } else if (message.type === 'large_start') partial = { entry: message.entry, chunks: [] };
  else if (message.type === 'large_chunk') partial.chunks.push(message.text);
  else if (message.type === 'large_end') {
    partial.entry.message.content = measured(timing, 'large_text_assembly', () => partial.chunks.join(''));
    staging.push(measured(timing, 'live_or_eligible_tokenization', () => tokenize(partial.entry))); partial = null;
  } else if (message.type === 'commit') {
    active = staging;
    eligibleBranch = measured(timing, 'eligible_activation_selection', () => branch(active.filter(entry => entry.sourcePosition < eligibleCount)));
    measured(timing, 'postings_activation', () => index.sync(eligibleBranch));
    return {
      documents: index.documents.size, storage: index.stats(),
      ...(timing ? { heapUsed: process.memoryUsage().heapUsed } : {})
    };
  } else if (message.type === 'query') {
    return message.mode === 'manual' ? index.recall(message.query, eligibleBranch, message.options) : index.query(message.query, eligibleBranch);
  } else throw new Error('Unknown worker command');
}
parentPort.on('message', message => {
  if (message.timing && !timing) timing = new StageTiming();
  const timer = message.timing ? timing : undefined; index.timer = timer;
  try {
    const work = () => measured(timer, `worker_${message.type}`, () => handle(message));
    const result = timer ? timer.withParent(message.timing.parentId, work) : work();
    parentPort.postMessage({
      requestId: message.requestId, generation: message.generation, result,
      ...(timer ? { stages: timer.events.splice(0), timingOrigin: timer.origin } : {})
    });
  } catch (error) {
    parentPort.postMessage({
      requestId: message.requestId, generation: message.generation, error: String(error),
      ...(timer ? { stages: timer.events.splice(0), timingOrigin: timer.origin } : {})
    });
  }
});
