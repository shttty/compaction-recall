// Throwaway structured tool-call prototype. No production registration or persistent data.
import { DatabaseSync } from 'node:sqlite';
import { Type } from 'typebox';
import { createHanPhraseTrial } from '../soft-match-sqlite/han-phrase-trial.mjs';

const { tokenizer } = createHanPhraseTrial('off');
const HAN = /^\p{Script=Han}+$/u;
const BOUNDARY = '\ue000';
const quote = text => '"' + text.replaceAll('"', '""') + '"';
const fail = (path, reason) => { throw new TypeError(`${path}: ${reason}`); };
function object(value, path, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected a JSON object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unsupported field');
}
function array(value, path) {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value;
}
function literal(value, path) {
  if (typeof value !== 'string') fail(path, 'expected literal text, not an expression/object');
  if (value.includes('\0') || value.includes(BOUNDARY)) fail(path, 'NUL and reserved index boundary U+E000 are unsupported');
  for (const char of value) {
    if (!HAN.test(char) && /[^\x00-\x7f]/.test(char) && /[\p{L}\p{N}\p{M}]/u.test(char)) {
      fail(path, 'only Han and ASCII word components are indexed; non-ASCII letters, numbers and combining marks are unsupported');
    }
  }
  for (const [word] of value.matchAll(/\p{Script=Han}+|[A-Za-z0-9_$]+/gu)) {
    if (HAN.test(word)) {
      if (Array.from(word).length < 2) fail(path, 'single Han characters are not indexed; choose an explicit multi-character term');
    } else {
      const parts = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').split(/[_$\s]+/).filter(Boolean);
      if (parts.some(part => part.length < 2)) fail(path, 'single-character ASCII components are not indexed; they cannot be silently discarded');
    }
  }
  const tokens = tokenizer.tokenize(value);
  // Keep internal source-run barriers, but a final Han phrase may occur inside a longer run.
  if (tokens.at(-1) === BOUNDARY) tokens.pop();
  if (!tokens.length) fail(path, 'text produces zero indexed tokens');
  return quote(tokens.join(' '));
}

export function compileQuery(input) {
  object(input, 'input', ['must', 'prefer', 'exclude', 'limit']);
  const groups = key => array(Object.hasOwn(input, key) ? input[key] : [], key).map((group, i) => {
    const path = `${key}[${i}]`;
    object(group, path, ['any_of']);
    const alternatives = array(group.any_of, `${path}.any_of`);
    if (!alternatives.length) fail(`${path}.any_of`, 'must contain at least one literal');
    return '(' + alternatives.map((text, j) => literal(text, `${path}.any_of[${j}]`)).join(' OR ') + ')';
  });
  const must = groups('must'), prefer = groups('prefer');
  const exclude = array(Object.hasOwn(input, 'exclude') ? input.exclude : [], 'exclude')
    .map((text, i) => literal(text, `exclude[${i}]`));
  const limit = Object.hasOwn(input, 'limit') ? input.limit : 20;
  if (!Number.isSafeInteger(limit) || limit < 1) fail('limit', 'expected a positive safe integer; default is 20');
  if (!must.length && !prefer.length) fail('must/prefer', 'at least one positive concept group is required; no full-corpus scan');
  return { candidate: must.length ? must.join(' AND ') : prefer.join(' OR '), prefer, exclude, limit };
}

export const description = 'Search the supplied document collection by literal text, not semantic similarity. '
  + 'Use named must/prefer/exclude/limit arguments, not a query string. Each group is {any_of: [literal alternatives]}. '
  + 'Every must group must match; put only certain requirements there. Uncertain memories and helpful clues belong in prefer, or use only prefer if nothing is certain. '
  + 'With must, prefer only orders candidates and never removes them. Without must, the union of prefer groups supplies candidates. At least one positive group is required. '
  + 'Results are ordered globally by number of matching prefer groups, then lexical relevance, then document order; limit is applied last. '
  + 'exclude removes a document matching any listed literal, not a semantic negation. '
  + 'Each string is one consecutive indexed-token phrase: OR, quotes and other punctuation cannot introduce operators. '
  + 'Han text uses adjacent two-character tokens; Latin identifiers split at camel-case, acronym, underscore and dollar boundaries, ignoring case. '
  + 'Punctuation and spaces are token separators, not exact punctuation matching; Han runs cannot be glued across separators. '
  + 'Single Han characters, single-character Latin/digit components, unsupported alphabets and zero-token strings are errors, including inside longer input. '
  + 'Supply alternative wording explicitly; there is no synonym inference or automatic broadening on zero hits.';
const groupSchema = Type.Object({
  any_of: Type.Array(Type.String({ minLength: 1, description: 'One literal token phrase per string; alternatives for the same concept.' }), { minItems: 1 }),
}, { additionalProperties: false });
export const parameters = Type.Object({
  must: Type.Optional(Type.Array(groupSchema, { description: 'Certain requirements only. All groups must match; any alternative within a group suffices.' })),
  prefer: Type.Optional(Type.Array(groupSchema, { description: 'Helpful or uncertain clues. Ranking only when must exists; otherwise their union supplies candidates.' })),
  exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: 'Exclude documents containing any of these literal phrases.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 20, description: 'Maximum returned documents, applied after global ranking; default 20.' })),
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
        fail(`documents[${i}]`, 'expected unique nonempty string id and string text');
      }
      ids.add(document.id);
      corpus.push({ id: document.id, text: document.text });
      insert.run(i + 1, tokenizer.tokenize(document.text).join(' '));
    }
    db.exec('COMMIT');
  } catch (error) { db.close(); throw error; }
  return {
    search(input) {
      const query = compileQuery(input);
      // Each FTS cursor emits at most one row per document/group, regardless of term frequency.
      const preferred = query.prefer.length
        ? query.prefer.map(() => 'SELECT rowid FROM terms WHERE terms MATCH ?').join(' UNION ALL ')
        : 'SELECT rowid FROM terms WHERE 0';
      const exclusion = query.exclude.length
        ? 'WHERE candidates.rowid NOT IN (SELECT rowid FROM terms WHERE terms MATCH ?)'
        : '';
      const sql = `WITH candidates AS MATERIALIZED (
          SELECT rowid, bm25(terms) AS score FROM terms WHERE terms MATCH ?
        ), preferred AS (${preferred}), counts AS (
          SELECT rowid, count(*) AS matched FROM preferred GROUP BY rowid
        )
        SELECT candidates.rowid, candidates.score, coalesce(counts.matched, 0) AS preferGroups,
          count(*) OVER () AS total
        FROM candidates LEFT JOIN counts ON counts.rowid = candidates.rowid ${exclusion}
        ORDER BY preferGroups DESC, score ASC, candidates.rowid ASC LIMIT ?`;
      const bindings = [query.candidate, ...query.prefer];
      if (query.exclude.length) bindings.push(query.exclude.join(' OR '));
      // No pre-LIMIT candidate truncation, and exclusions never enter BM25's MATCH expression.
      const rows = db.prepare(sql).all(...bindings, query.limit);
      return {
        total: rows[0]?.total ?? 0, limit: query.limit,
        results: rows.map(row => ({ ...corpus[row.rowid - 1], preferGroups: row.preferGroups, score: row.score })),
      };
    },
    close() { db.close(); },
  };
}

export function createTool(index) {
  return {
    name: 'structured_recall', label: 'Structured recall prototype', description, parameters,
    async execute(_toolCallId, input) {
      const result = index.search(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
