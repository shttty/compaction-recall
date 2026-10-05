import { createIndex, parseAutoGate } from '../prototype/soft-match-sqlite/index.mjs';
import { measured } from '../src/timing.mjs';
import { validateArm } from '../prototype/soft-match-sqlite/arms.mjs';
import { createQueryCheck } from '../prototype/soft-match-sqlite/deadline.mjs';

export function createWorkerEngine({ arm = process.env.COMPACTION_RECALL_SQLITE_ARM ?? 'off', autoGate = process.env.COMPACTION_RECALL_AUTO_GATE,
  snippetBudget = process.env.COMPACTION_RECALL_SNIPPET_BUDGET } = {}) {
  validateArm(arm);
  autoGate = parseAutoGate(autoGate);
  if (typeof snippetBudget === 'string') snippetBudget = /^\d+$/.test(snippetBudget) ? Number(snippetBudget) : undefined;
  let index;
  let documents = [];
  return {
    commit(entries, { eligibleCount, timer }) {
      const next = entries.filter(entry => entry.sourcePosition < eligibleCount).map(entry => ({
        id: entry.id, text: entry.message.content, sourcePosition: entry.sourcePosition,
        date: entry.timestamp.slice(0, 10), timestamp: entry.timestamp, role: entry.message.role,
      }));
      const changed = !index || next.length !== documents.length || next.some((entry, i) =>
        entry.id !== documents[i].id || entry.text !== documents[i].text ||
        entry.sourcePosition !== documents[i].sourcePosition || entry.timestamp !== documents[i].timestamp || entry.role !== documents[i].role);
      if (changed) {
        const replacement = measured(timer, 'postings_activation', () => createIndex(next, { arm, autoGate, snippetBudget }));
        index?.close(); index = replacement; documents = next;
      }
      timer?.mark('worker_maintenance', { kind: changed ? 'build_or_rebuild' : 'activation', entries: index.size, execution: 'worker_thread' });
      return { documents: index.size };
    },
    query(query, { mode, timer, options = {} }) {
      if (!index) throw new Error('SQLite worker has not committed a corpus');
      const check = mode === 'manual' ? createQueryCheck(options.queryDeadlineAt, options.queryTimeoutMs) : undefined;
      check?.();
      if (mode === 'manual' && options.page) return index.queryPage(query, options, { timer, check });
      const found = measured(timer, 'candidate_collection', () => index.queryRows(query, { mode, timer, check, ...(mode === 'auto' ? options : {}) }));
      // Materialize full-rank callers here: deadline errors must remain engine
      // errors, not transport failures that would discard a healthy index.
      const results = found.results.map(row => { check?.(); return { ...row }; });
      check?.();
      return { ...found, results };
    },
    dispose() { index?.close(); index = undefined; documents = []; },
  };
}
