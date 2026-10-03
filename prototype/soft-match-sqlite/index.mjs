import { DatabaseSync } from 'node:sqlite';

// English-only value copy of src/locator.mjs; deliberately no production lexer import.
const STOPWORDS = new Set((
  'a an and are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our please so than that the their them then there these they this to us was we were what when where which who why will with would you your ' +
  'please tell help about find show recall remember previous earlier history'
).split(/\s+/));
const HAN = /\p{Script=Han}/u;
const PURE_HAN = /^\p{Script=Han}+$/u;
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

export function tokenize(text) {
  const tokens = [];
  for (const [run] of text.matchAll(/\p{Script=Han}+|[A-Za-z0-9_]+/gu)) {
    if (!PURE_HAN.test(run)) {
      const term = run.toLowerCase();
      if (!STOPWORDS.has(term)) tokens.push(term);
      continue;
    }

    const chars = Array.from(run);
    const spans = [];
    let offset = 0;
    for (let i = 0; i + 1 < chars.length; i++) {
      spans.push({ term: chars[i] + chars[i + 1], start: offset, length: 2 });
      offset += chars[i].length;
    }
    for (const { segment, index, isWordLike } of SEGMENTER.segment(run)) {
      if (!isWordLike || !PURE_HAN.test(segment)) continue;
      const length = Array.from(segment).length;
      // Every two-Han word already exists at this exact span as a bigram.
      if (length > 2) spans.push({ term: segment, start: index, length });
    }
    spans.sort((a, b) => a.start - b.start || a.length - b.length);
    for (const { term } of spans) tokens.push(term);
  }
  return tokens;
}

export function weightedLength(text) {
  let length = 0;
  for (const point of text) length += HAN.test(point) ? 2 : 1;
  return length;
}

export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

export function createIndex(documents) {
  const db = new DatabaseSync(':memory:');
  const ids = [];
  let match;
  try {
    db.exec(`
      PRAGMA temp_store = MEMORY;
      CREATE VIRTUAL TABLE terms USING fts5(
        tokens, content='', columnsize=1, detail=full,
        tokenize="ascii tokenchars '_'"
      );
      BEGIN;
    `);
    const insert = db.prepare('INSERT INTO terms(rowid, tokens) VALUES (?, ?)');
    for (const { id, text } of documents) {
      ids.push(id);
      insert.run(ids.length, tokenize(text).join(' '));
    }
    db.exec('COMMIT');
    match = db.prepare('SELECT rowid, bm25(terms) AS score FROM terms WHERE terms MATCH ?');
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    search(query, { automatic = false, limit = 20 } = {}) {
      const text = extractText(query);
      if (automatic && weightedLength(text) > 210) {
        return { skipped: true, total: 0, results: [], queryTerms: [] };
      }
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError('limit must be a non-negative safe integer');
      }
      const queryTerms = [...new Set(tokenize(text))];
      if (queryTerms.length === 0) {
        return { skipped: false, total: 0, results: [], queryTerms };
      }
      const expression = queryTerms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      const candidates = match.all(expression)
        .map(({ rowid, score }) => ({ id: ids[rowid - 1], score }));
      // SQLite's native BM25 is negative: lower scores rank first.
      candidates.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        skipped: false,
        total: candidates.length,
        results: candidates.slice(0, limit),
        queryTerms,
      };
    },
    searchRaw(query, { limit } = {}) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
        throw new RangeError('limit must be a non-negative safe integer');
      }
      const candidates = match.all(query)
        .map(({ rowid, score }) => ({ id: ids[rowid - 1], score }));
      candidates.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { total: candidates.length, results: limit === undefined ? candidates : candidates.slice(0, limit) };
    },
    close() {
      db.close();
    },
  };
}
