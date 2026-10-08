import { createIndex, parseAutoGate } from '../search/sqlite-index.mjs';
import { measured } from '../observability/timing.mjs';
import { createQueryCheck } from '../search/sqlite-deadline.mjs';

export function createWorkerEngine({ autoGate = 280, snippetBudget = 240, jieba = true } = {}) {
  autoGate = parseAutoGate(autoGate);
  let index;
  let documents = [];
  return {
    commit(entries, { eligibleCount, append = false, includeIneligible = false, timer }) {
      const next = entries.filter(entry => includeIneligible || entry.sourcePosition < eligibleCount).map(entry => ({
        id: entry.id, text: entry.message.content, sourcePosition: entry.sourcePosition,
        date: entry.timestamp.slice(0, 10), timestamp: entry.timestamp, role: entry.message.role,
      }));
      const same = (left, right) => left.id === right.id && left.text === right.text && left.sourcePosition === right.sourcePosition && left.timestamp === right.timestamp && left.role === right.role;
      const changed = !index || next.length !== documents.length || next.some((entry, i) => !same(entry, documents[i]));
      const knownIds = new Set(documents.map(document => document.id));
      const additions = next.slice(documents.length);
      const appendable = changed && index && append && next.length > documents.length && documents.every((entry, i) => same(entry, next[i])) && additions.every(entry => !knownIds.has(entry.id) && knownIds.add(entry.id));
      if (appendable) {
        measured(timer, 'postings_append', () => index.append(additions));
        documents = next;
      } else if (changed) {
        const replacement = measured(timer, 'postings_activation', () => createIndex(next, { jieba, autoGate, snippetBudget }));
        index?.close(); index = replacement; documents = next;
      }
      timer?.mark('worker_maintenance', { kind: appendable ? 'incremental_update' : changed ? 'build_or_rebuild' : 'activation', entries: index.size, execution: 'worker_thread' });
      return { documents: index.size };
    },
    query(query, { mode, timer, options = {} }) {
      if (!index) throw new Error('SQLite worker has not committed a corpus');
      const check = mode === 'manual' ? createQueryCheck(options.queryDeadlineAt, options.queryTimeoutMs) : undefined;
      check?.();
      if (mode === 'manual' && options.page) return index.queryPage(query, options, { timer, check });
      const found = measured(timer, 'candidate_collection', () => index.queryRows(query, { mode, timer, check, ...options }));
      // Materialize full-rank callers here: deadline errors must remain engine
      // errors, not transport failures that would discard a healthy index.
      const results = found.results.map(row => { check?.(); return { ...row }; });
      check?.();
      return { ...found, results };
    },
    dispose() { index?.close(); index = undefined; documents = []; },
  };
}
