import { DatabaseSync } from 'node:sqlite';
import { queryOperands } from './query.mjs';

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
      tokens.push(run.toLowerCase());
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

// Recognize FTS5 operands, not document terms. Keep native implicit-AND grouping
// when replacing its connectors; SQLite remains responsible for syntax errors.
export function implicitOr(query) {
  const tokens = [...query.matchAll(/"(?:[^"]|"")*"|[A-Za-z0-9_\x1a\u0080-\uffff]+|[^ \t\r\n]/g)]
    .map(match => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
  // Do not turn an unterminated quote into another error or a valid expression.
  if (tokens.some(token => token.text === '"')) return query;
  const text = i => tokens[i]?.text;
  const isString = i => tokens[i] && /^["A-Za-z0-9_\x1a\u0080-\uffff]/.test(text(i)) &&
    !['AND', 'OR', 'NOT'].includes(text(i));
  const closes = new Map();
  const delimiters = [];
  for (let i = 0; i < tokens.length; i++) {
    if (text(i) === '(' || text(i) === '{') delimiters.push(i);
    else if ((text(i) === ')' && text(delimiters.at(-1)) === '(') ||
      (text(i) === '}' && text(delimiters.at(-1)) === '{')) {
      closes.set(delimiters.pop(), i);
    }
  }
  function operand(start, end) {
    let i = start;
    if (text(i) === '-') i++;
    const columnEnd = text(i) === '{' ? closes.get(i) : isString(i) ? i : undefined;
    if (columnEnd !== undefined && text(columnEnd + 1) === ':') i = columnEnd + 2;
    else if (i !== start || text(i) === '{') return;
    const anchored = text(i) === '^';
    if (anchored) i++;
    if (!anchored && text(i) === '(') {
      const close = closes.get(i) ?? end;
      return { next: Math.min(close + 1, end), inner: [i + 1, close] };
    }
    if (!anchored && text(i) === 'NEAR' && text(i + 1) === '(') {
      // The spaces inside NEAR separate proximity phrases, not boolean queries.
      i = Math.min((closes.get(i + 1) ?? end) + 1, end);
    } else {
      if (!isString(i)) return;
      i++;
      if (text(i) === '*') i++;
      while (text(i) === '+' && isString(i + 1)) {
        i += 2;
        if (text(i) === '*') i++;
      }
    }
    return { next: i, start: tokens[start].start, end: tokens[i - 1].end };
  }
  const inserts = [];
  const scopes = [[0, tokens.length]];
  while (scopes.length) {
    const [start, end] = scopes.pop();
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        inserts.push({ at: run[0].start, text: '(' });
        for (let i = 1; i < run.length; i++) {
          inserts.push({ at: run[i].start, text: run[i - 1].end === run[i].start ? ' OR ' : 'OR ' });
        }
        inserts.push({ at: run.at(-1).end, text: ')' });
      }
      run = [];
    };
    for (let i = start; i < end;) {
      const found = operand(i, end);
      if (!found) {
        flush();
        // Even malformed column lists stay opaque; do not OR their names.
        i = text(i) === '{' ? Math.min((closes.get(i) ?? end) + 1, end) : i + 1;
      } else if (found.inner) {
        flush();
        scopes.push(found.inner);
        i = found.next;
      } else {
        run.push(found);
        i = found.next;
      }
    }
    flush();
  }
  if (!inserts.length) return query;
  inserts.sort((a, b) => a.at - b.at);
  let rewritten = '', offset = 0;
  for (const insert of inserts) {
    rewritten += query.slice(offset, insert.at) + insert.text;
    offset = insert.at;
  }
  return rewritten + query.slice(offset);
}

export function createIndex(documents) {
  const db = new DatabaseSync(':memory:');
  const ids = [];
  let match;
  let vocabulary;
  try {
    db.exec(`
      PRAGMA temp_store = MEMORY;
      CREATE VIRTUAL TABLE terms USING fts5(
        tokens, content='', columnsize=1, detail=full,
        tokenize="ascii tokenchars '_'"
      );
      CREATE VIRTUAL TABLE vocabulary USING fts5vocab(terms, 'row');
      BEGIN;
    `);
    const insert = db.prepare('INSERT INTO terms(rowid, tokens) VALUES (?, ?)');
    for (const { id, text } of documents) {
      ids.push(id);
      insert.run(ids.length, tokenize(text).join(' '));
    }
    db.exec('COMMIT');
    match = db.prepare('SELECT rowid, bm25(terms) AS score FROM terms WHERE terms MATCH ?');
    vocabulary = db.prepare('SELECT 1 FROM vocabulary WHERE term = ?');
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    missingTerms(query) {
      // Prefix expressions are not absent bare terms. Phrase constituents are
      // checked independently; this does not promise phrase/Boolean matches.
      const terms = queryOperands(implicitOr(query)).filter(({ prefix }) => !prefix);
      return [...new Set(terms.map(({ term }) => term))].filter(term => !vocabulary.get(term));
    },
    search(query, { automatic = false, limit = 20 } = {}) {
      const text = extractText(query);
      if (automatic && weightedLength(text) > 210) {
        return { skipped: true, total: 0, results: [], queryTerms: [] };
      }
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError('limit must be a non-negative safe integer');
      }
      const queryTerms = [...new Set(tokenize(text).filter(term => !STOPWORDS.has(term)))];
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
      const candidates = match.all(implicitOr(query))
        .map(({ rowid, score }) => ({ id: ids[rowid - 1], score }));
      candidates.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { total: candidates.length, results: limit === undefined ? candidates : candidates.slice(0, limit) };
    },
    close() {
      db.close();
    },
  };
}
