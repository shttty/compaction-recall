import { lex, locatorText, locatorRow, rankLocatorCandidates, RECALL_DEFAULT_LIMIT, RECALL_MAX_LIMIT } from './locator.mjs';
import { measured } from './timing.mjs';
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
function branch(entries) {
  const ids = new Set(entries.map(entry => entry.id));
  let kept = 'worker-kept';
  while (ids.has(kept)) kept += '-';
  return [...entries,
    { type: 'compaction', id: 'worker-boundary', firstKeptEntryId: kept, summary: '', timestamp: '2000-01-01' },
    { type: 'message', id: kept, timestamp: '2000-01-01', message: { role: 'user', content: '' } },
  ];
}

export function createWorkerEngine() {
  const index = new CachedIndex();
  let eligibleBranch = [];
  return {
    prepareEntry: tokenize,
    commit(entries, { eligibleCount, timer }) {
      index.timer = timer;
      // Live token maps never enter documents/postings (and therefore never N or DF).
      eligibleBranch = measured(timer, 'eligible_activation_selection', () => branch(entries.filter(entry => entry.sourcePosition < eligibleCount)));
      timer?.mark('worker_maintenance', { kind: 'activation', entries: eligibleBranch.length - 2, execution: 'worker_thread' });
      measured(timer, 'postings_activation', () => index.sync(eligibleBranch));
      return { documents: index.documents.size };
    },
    query(query, { mode, options = {}, timer }) {
      if (mode === 'manual') {
        const limit = options.limit ?? RECALL_DEFAULT_LIMIT, offset = options.offset ?? 0;
        if (!Number.isInteger(limit) || limit < 1 || limit > RECALL_MAX_LIMIT) throw new RangeError('limit must be an integer from 1 to 50');
        if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a nonnegative safe integer');
      }
      index.timer = timer;
      const found = index.collect(query, eligibleBranch);
      const ranked = rankLocatorCandidates(found.candidates, found.frequency, found.documents, timer);
      const selected = mode === 'manual' ? ranked : ranked.slice(0, 5);
      return { total: ranked.length, results: selected.map(candidate => locatorRow(candidate, found.frequency)) };
    },
  };
}
