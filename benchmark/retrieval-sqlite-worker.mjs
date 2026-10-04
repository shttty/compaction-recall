import { createIndex, implicitOr, tokenize } from '../prototype/soft-match-sqlite/index.mjs';
import { queryOperands } from '../prototype/soft-match-sqlite/query.mjs';
import { prototypeSpans } from './snippet-compare-core.mjs';
import { fts5Snippet } from './fts5-snippet.mjs';
import { measured } from '../src/timing.mjs';

export function createWorkerEngine() {
  let index;
  let documents = [];
  let byId = new Map();
  return {
    commit(entries, { eligibleCount, timer }) {
      const eligible = entries.filter(entry => entry.sourcePosition < eligibleCount);
      const changed = !index || eligible.length !== documents.length || eligible.some((entry, i) =>
        entry.id !== documents[i].id || entry.message.content !== documents[i].text);
      if (changed) {
        const next = eligible.map(entry => ({ id: entry.id, text: entry.message.content }));
        const replacement = measured(timer, 'postings_activation', () => createIndex(next));
        index?.close();
        index = replacement;
        documents = next;
        byId = new Map(documents.map(document => [document.id, document]));
      }
      // Metadata can change without affecting postings or corpus statistics.
      for (const entry of eligible) {
        const document = byId.get(entry.id);
        document.date = entry.timestamp.slice(0, 10);
        document.role = entry.message.role;
      }
      timer?.mark('worker_maintenance', { kind: changed ? 'build_or_rebuild' : 'activation', entries: eligible.length, execution: 'worker_thread' });
      return { documents: documents.length };
    },
    query(query, { mode, timer }) {
      if (!index) throw new Error('SQLite worker has not committed a corpus');
      const found = measured(timer, 'candidate_collection', () => mode === 'auto'
        ? index.search(query, { automatic: true, limit: documents.length })
        : index.searchRaw(query));
      const terms = mode === 'auto'
        ? found.queryTerms.map(term => ({ term, prefix: false }))
        : queryOperands(implicitOr(query)).flatMap(operand => operand.prefix
          ? [operand]
          : tokenize(operand.term).map(term => ({ term, prefix: false })));
      const exact = new Set(terms.filter(term => !term.prefix).map(({ term }) => term));
      const prefixes = [...new Set(terms.filter(term => term.prefix).map(({ term }) => term))];
      const results = measured(timer, 'snippet_render', () => found.results.map(row => {
        const document = byId.get(row.id);
        document.spans ??= prototypeSpans(document.text);
        const hits = document.spans.flatMap(span => {
          const matches = exact.has(span.term) ? [span] : [];
          for (const term of prefixes) {
            if (span.term.startsWith(term)) matches.push({ ...span, term });
          }
          return matches;
        });
        return { ...row, date: document.date, role: document.role,
          snippet: fts5Snippet(document.text, hits, 120, { sentenceBonus: false }) };
      }));
      return { total: found.total, results, missingTerms: mode === 'manual' ? index.missingTerms(query) : [] };
    },
    dispose() {
      index?.close();
      index = undefined;
      documents = [];
      byId.clear();
    },
  };
}
