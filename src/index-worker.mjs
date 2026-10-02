import { parentPort } from 'node:worker_threads';
import { lex, locatorText } from './locator.mjs';
import { StageTiming, measured } from './timing.mjs';
import { CompactionIndex } from './inverted-index.mjs';

class CachedIndex extends CompactionIndex {
  add(entry, recency) {
    if (!entry.tokens) return super.add(entry, recency);
    if (this.seen.has(entry.id)) return;
    this.seen.add(entry.id);
    if (!locatorText(entry.message)) return;
    this.documents.set(recency, entry);
    for (const [term, position] of entry.tokens) {
      let posting = this.postings.get(term);
      if (!posting) this.postings.set(term, posting = new Map());
      posting.set(recency, position);
    }
    delete entry.tokens;
    this.indexed++;
  }
}
function tokenize(entry) {
  const tokens = new Map();
  let order = 0;
  for (const { term, offset } of lex(entry.message.content)) {
    if (!tokens.has(term)) tokens.set(term, { offset, order });
    order++;
  }
  return { ...entry, tokens };
}
const index = new CachedIndex();
let timing, active = [], staging = [], generation = 0, partial = null, eligibleCount = 0, eligibleBranch = [];
function branch(entries) {
  const ids = new Set(entries.map(entry => entry.id));
  let kept = 'worker-kept';
  while (ids.has(kept)) kept += '-';
  return [...entries,
  { type: 'compaction', id: 'worker-boundary', firstKeptEntryId: kept, summary: '', timestamp: '2000-01-01' },
  { type: 'message', id: kept, timestamp: '2000-01-01', message: { role: 'user', content: '' } },
  ];
}
function handle(message) {
  if (message.type === 'begin') {
    generation = message.generation;
    eligibleCount = message.eligibleCount;
    staging = message.append ? active.slice() : [];
    partial = null;
    timing?.mark('worker_maintenance', { kind: message.append ? 'incremental_update' : 'build_or_rebuild', entries: eligibleCount, execution: 'worker_thread' });
    return;
  }
  if (message.generation !== generation) throw new Error('Obsolete generation');
  if (message.type === 'batch') {
    timing?.mark('worker_maintenance', { kind: 'pretokenize', entries: message.entries.length, execution: 'worker_thread' });
    staging.push(...measured(timing, 'live_or_eligible_tokenization', () => message.entries.map(tokenize)));
  } else if (message.type === 'large_start') partial = { entry: message.entry, chunks: [] };
  else if (message.type === 'large_chunk') partial.chunks.push(message.text);
  else if (message.type === 'large_end') {
    timing?.mark('worker_maintenance', { kind: 'pretokenize', entries: 1, execution: 'worker_thread' });
    partial.entry.message.content = measured(timing, 'large_text_assembly', () => partial.chunks.join(''));
    staging.push(measured(timing, 'live_or_eligible_tokenization', () => tokenize(partial.entry)));
    partial = null;
  } else if (message.type === 'commit') {
    active = staging;
    // Live token maps never enter documents/postings (and therefore never N or DF).
    eligibleBranch = measured(timing, 'eligible_activation_selection', () => branch(active.filter(entry => entry.sourcePosition < eligibleCount)));
    timing?.mark('worker_maintenance', { kind: 'activation', entries: eligibleBranch.length - 2, execution: 'worker_thread' });
    measured(timing, 'postings_activation', () => index.sync(eligibleBranch));
    return { documents: index.documents.size, ...(timing ? { heapUsed: process.memoryUsage().heapUsed } : {}) };
  } else if (message.type === 'query') {
    return message.mode === 'manual' ? index.recall(message.query, eligibleBranch, message.options) : index.query(message.query, eligibleBranch);
  } else throw new Error('Unknown worker command');
}
parentPort.on('message', message => {
  if (message.timing && !timing) timing = new StageTiming();
  const timer = message.timing ? timing : undefined;
  index.timer = timer;
  try {
    const work = () => measured(timer, `worker_${message.type}`, () => handle(message));
    const result = timer ? timer.withParent(message.timing.parentId, work) : work();
    parentPort.postMessage({
      requestId: message.requestId, generation: message.generation, result,
      ...(timer ? { stages: timer.events.splice(0), timingOrigin: timer.origin } : {}),
    });
  } catch {
    parentPort.postMessage({
      requestId: message.requestId, generation: message.generation, error: 'Index worker operation failed',
      ...(timer ? { stages: timer.events.splice(0), timingOrigin: timer.origin } : {}),
    });
  }
});
