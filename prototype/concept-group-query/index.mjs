// Isolated trial of the uploaded compiler; no production registration.
import { DatabaseSync } from 'node:sqlite';
import { Type } from 'typebox';
import { compileFts5 } from './original/query.ts';
import { createHanPhraseTrial } from '../soft-match-sqlite/han-phrase-trial.mjs';

const { tokenizer } = createHanPhraseTrial('off');
const BOUNDARY = '\ue000';

// The shared index stores split identifiers, NOT their unsplit spelling.
// Its Han position barriers are not positive query terms. No replacement dictionary.
export function analyzeQuery(surface) {
  const terms = tokenizer.tokenize(surface).filter(term => term !== BOUNDARY);
  return terms.length ? [terms] : [];
}
export const compileQuery = input => compileFts5(input, analyzeQuery);

export const description = 'Search the supplied document collection by lexical concept groups, not semantic similarity. '
  + 'concepts contains 1 to 5 groups, each with 1 to 4 alternative surface forms for the same retrieval clue. '
  + 'Any alternative satisfies its group. Do not put independent simultaneous requirements in one group: that makes them alternatives. '
  + 'match defaults to any: any group can supply a candidate, suitable for initial recall. all requires every group in the same indexed record, not across records. '
  + 'exclude defaults to empty and removes a whole record matching any listed surface form; it is not a ranking penalty or semantic negation and can remove relevant transition history. '
  + 'A multiword surface is analyzed as alternative paths of co-occurring indexed terms, without order or adjacency requirements. '
  + 'All strings are data, including OR, quotes and punctuation, never SQL or FTS syntax. '
  + 'This backend uses Han bigrams and case-insensitive split Latin identifiers, discards punctuation and single-character components; a surface with no indexed terms is an error. '
  + 'No phrase, exact substring, regex, prefix, NEAR, field selection, weights, synonym inference or automatic fallback. '
  + 'There is no soft-preference or requested-result-count parameter. The wrapper returns at most 20 records, ordered by BM25 ascending then document order, not concept coverage. '
  + 'Up to 5 exclusions; each surface at most 256 Unicode code points, total 2048. Backend analysis and compiled query also have bounded resource limits.';
const surface = Type.String({ minLength: 1, maxLength: 256, description: 'Literal surface form; backend terms co-occur, not necessarily adjacent or ordered.' });
export const parameters = Type.Object({
  concepts: Type.Array(Type.Array(surface, { minItems: 1, maxItems: 4 }), {
    minItems: 1, maxItems: 5, description: 'Different retrieval clues; each inner array contains alternatives for one clue, not independent requirements.',
  }),
  match: Type.Optional(Type.Union([Type.Literal('any'), Type.Literal('all')], {
    default: 'any', description: 'any admits any group; all requires every group in the same indexed record. Default any.',
  })),
  exclude: Type.Optional(Type.Array(surface, { maxItems: 5, default: [], description: 'Hard exclusions, not lower priority or semantic negation; any match removes the record.' })),
}, { additionalProperties: false });

export function createIndex(documents) {
  const db = new DatabaseSync(':memory:');
  const corpus = [];
  try {
    db.exec("CREATE VIRTUAL TABLE terms USING fts5(tokens, content='', tokenize='ascii'); BEGIN");
    const insert = db.prepare('INSERT INTO terms(rowid, tokens) VALUES (?, ?)');
    const ids = new Set();
    for (const [i, document] of documents.entries()) {
      if (!document || typeof document.id !== 'string' || !document.id || typeof document.text !== 'string' || ids.has(document.id)) {
        throw new TypeError(`documents[${i}]: expected unique nonempty string id and string text`);
      }
      ids.add(document.id);
      corpus.push({ id: document.id, text: document.text });
      insert.run(i + 1, tokenizer.tokenize(document.text).join(' '));
    }
    db.exec('COMMIT');
  } catch (error) { db.close(); throw error; }
  return {
    search(input) {
      const plan = compileQuery(input);
      // Materialize BM25 while its FTS cursor is active, before window counting.
      const rows = db.prepare(`WITH candidates AS MATERIALIZED (
          SELECT rowid, bm25(terms) AS score FROM terms WHERE terms MATCH ?
        ) SELECT rowid, score, count(*) OVER () AS total FROM candidates
        ORDER BY score ASC, rowid ASC LIMIT 20`).all(plan.match);
      return { total: rows[0]?.total ?? 0, limit: 20,
        results: rows.map(row => ({ ...corpus[row.rowid - 1], score: row.score })) };
    },
    close() { db.close(); },
  };
}

export function createTool(index) {
  return {
    name: 'structured_recall', label: 'Concept group recall trial', description, parameters,
    async execute(_toolCallId, input) {
      const result = index.search(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
