import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { STOPWORDS, tokenize as tokenizeAutomatic } from './sqlite-lexical.mjs';
import { createStemmer, porterTerm } from './sqlite-porter.mjs';
import { selectFts5Range } from './fts5-snippet.mjs';
import { measured } from '../observability/timing.mjs';
import { sqliteRecallPage } from './sqlite-page.mjs';
import { createHanRanking } from './han-ranking.mjs';
import { compileFts5, parseQuery } from './concept-query-compiler.mjs';
const HAN = /\p{Script=Han}/u;
const meaningful = /[\p{L}\p{N}\p{M}]/u;
const safeQueryData = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
  point => `\\u${point.charCodeAt(0).toString(16).padStart(4, '0')}`);

function weightedLength(text) {
  let length = 0;
  for (const point of text) length += HAN.test(point) ? 2 : 1;
  return length;
}

export function parseAutoGate(value = 280) {
  const gate = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(gate) || gate <= 0) {
    throw new RangeError('COMPACTION_RECALL_AUTO_GATE must be a positive safe integer');
  }
  return gate;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}


export function createIndex(documents, { jieba = true, autoGate = 280, snippetBudget } = {}) {
  const ranking = createHanRanking(jieba);
  autoGate = parseAutoGate(autoGate);
  const budget = Number.isSafeInteger(snippetBudget) && snippetBudget > 0 ? snippetBudget : 240;
  const { tokenize, tokenizeSpans } = ranking.tokenizer;
  // Latest id wins before the empty check, so a latest empty edit hides older text.
  const byId = new Map();
  documents.forEach((document, i) => {
    const recency = document.sourcePosition ?? document.recency ?? i;
    const previous = byId.get(document.id);
    if (!previous || recency >= previous.recency) byId.set(document.id, {
      id: document.id, text: document.text, date: document.date, role: document.role, recency,
      timestamp: document.timestamp ?? document.date ?? '',
    });
  });
  const indexedIds = new Set(byId.keys());
  const corpus = [...byId.values()].filter(document => document.text !== '');
  const db = new DatabaseSync(':memory:');
  let match, count, stem, rankedSql, insert, insertMessage, insertLongWord;
  try {
    db.exec(`
      PRAGMA temp_store = MEMORY;
      CREATE VIRTUAL TABLE terms USING fts5(
        tokens, stems, content='', columnsize=1, detail=full,
        tokenize='ascii'
      );
      CREATE VIRTUAL TABLE vocabulary USING fts5vocab(terms, 'col');
      CREATE TABLE messages(rowid INTEGER PRIMARY KEY, content_hash BLOB NOT NULL, timestamp TEXT NOT NULL, recency INTEGER NOT NULL);
      BEGIN;
    `);
    stem = createStemmer(db);
    insert = db.prepare('INSERT INTO terms(rowid, tokens, stems) VALUES (?, ?, ?)');
    insertMessage = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)');
    if (ranking.longWordRanking) {
      db.exec('CREATE TABLE han_rank(rowid INTEGER NOT NULL, term TEXT NOT NULL, PRIMARY KEY(rowid, term)) WITHOUT ROWID');
      insertLongWord = db.prepare('INSERT INTO han_rank VALUES (?, ?)');
    }
    corpus.forEach((document, i) => {
      const tokens = tokenize(document.text);
      insert.run(i + 1, tokens.join(' '), tokens.map(stem).filter(Boolean).join(' '));
      const hash = createHash('sha256').update(document.text.replace(/\s+/g, ' ').trim()).digest();
      insertMessage.run(i + 1, hash, document.timestamp, document.recency);
      if (insertLongWord) for (const word of ranking.longWords(document.text)) insertLongWord.run(i + 1, word);
    });
    db.exec('COMMIT');
    // MATERIALIZED keeps FTS5's bm25 auxiliary call inside its MATCH cursor.
    const scored = `SELECT terms.rowid, bm25(terms, 1.0, 0.5) AS score,
      messages.content_hash, messages.timestamp, messages.recency
      FROM terms JOIN messages ON messages.rowid = terms.rowid
      WHERE terms MATCH ? AND (? < 0 OR messages.recency < ?)`;
    rankedSql = `WITH hits AS MATERIALIZED (${scored}), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY content_hash ORDER BY score, timestamp DESC, recency DESC, rowid DESC) AS representative FROM hits
    )`;
    match = db.prepare(`${rankedSql} SELECT rowid, score FROM ranked WHERE representative = 1
      ORDER BY score, timestamp DESC, recency DESC, rowid DESC LIMIT ? OFFSET ?`);
    count = db.prepare('SELECT count(DISTINCT content_hash) AS total FROM terms JOIN messages ON messages.rowid = terms.rowid WHERE terms MATCH ? AND (? < 0 OR messages.recency < ?)');
  } catch (error) { db.close(); throw error; }
  function appendDocuments(additions) {
    const seen = new Set(indexedIds);
    const normalized = additions.map((document, index) => {
      if (seen.has(document.id)) throw new Error('Cannot append duplicate index document id');
      seen.add(document.id);
      const recency = document.sourcePosition ?? document.recency ?? corpus.length + index;
      return { id: document.id, text: document.text, date: document.date, role: document.role, recency, timestamp: document.timestamp ?? document.date ?? '' };
    });
    const added = normalized.filter(document => document.text !== '');
    db.exec('BEGIN');
    try {
      added.forEach((document, index) => {
        const rowid = corpus.length + index + 1;
        const tokens = tokenize(document.text);
        insert.run(rowid, tokens.join(' '), tokens.map(stem).filter(Boolean).join(' '));
        const hash = createHash('sha256').update(document.text.replace(/\s+/g, ' ').trim()).digest();
        insertMessage.run(rowid, hash, document.timestamp, document.recency);
        if (insertLongWord) for (const word of ranking.longWords(document.text)) insertLongWord.run(rowid, word);
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    for (const document of normalized) indexedIds.add(document.id);
    corpus.push(...added);
  }


  function compileOperands(operands, check) {
    const raw = new Map(), stems = new Map(), widths = new Set(), cache = new Map();
    const add = (map, term, index) => {
      if (!map.has(term)) map.set(term, []);
      map.get(term).push(index);
    };
    for (let i = 0; i < operands.length; i++) {
      check?.();
      const operand = operands[i];
      add(raw, operand.term, i);
      const alias = operand.stem ? stem(operand.term) : operand.term;
      if (alias === undefined) continue;
      add(stems, alias, i); widths.add(alias.split(' ').length);
    }
    return value => {
      if (cache.has(value)) return cache.get(value);
      const matched = new Set(raw.get(value));
      const alias = stem(value);
      if (alias !== undefined) {
        const pieces = alias.split(' ');
        for (const width of widths) for (let at = 0; at + width <= pieces.length; at++) {
          const key = width === 1 ? pieces[at] : pieces.slice(at, at + width).join(' ');
          for (const i of stems.get(key) ?? []) matched.add(i);
        }
      }
      const terms = [...matched].sort((a, b) => a - b).map(i => operands[i].term);
      cache.set(value, terms);
      return terms;
    };
  }
  function materialize(native, snippetTerms, timer, check) {
    let snippetMatch;
    const results = measured(timer, 'candidate_materialization', () => native.map(({ rowid, score }) => {
        const document = corpus[rowid - 1];
      let rendered;
      return {
        id: document.id, score, date: document.date ?? '', role: document.role ?? 'user',
        get snippet() {
            check?.();
          if (rendered !== undefined) return rendered;
          const hits = measured(timer, 'snippet_hits', () => {
            snippetMatch ??= compileOperands(snippetTerms, check);
            document.spans ??= tokenizeSpans(document.text);
            const found = [];
        for (let at = 0; at < document.spans.length; at++) {
          if ((at & 255) === 0) check?.();
          const span = document.spans[at];
              for (const term of snippetMatch(span.term)) found.push({ ...span, term });
      }
            return found;
    });
          const range = measured(timer, 'snippet_selection', () => {
            document.chars ??= Array.from(document.text);
            return selectFts5Range(document.chars, hits, budget, { sentenceBonus: false, check, weighted: true });
    });
          rendered = measured(timer, 'snippet_render', () => `${range.start > 0 ? '…' : ''}${document.chars.slice(range.start, range.end).join('')}${range.end < document.chars.length ? '…' : ''}`);
      check?.();
          return rendered;
        },
      };
    }));
    check?.();
    return results;
  }
  function collect(expression, snippetTerms, timer, check, { limit = -1, offset = 0, eligibleCount = -1 } = {}, longWords = []) {
    check?.();
    const eligible = Number.isSafeInteger(eligibleCount) && eligibleCount >= 0 ? eligibleCount : -1;
    const total = measured(timer, 'native_count', () => count.get(expression, eligible, eligible).total);
    check?.();
    const native = measured(timer, 'native_query', () => {
      if (!ranking.longWordRanking || !longWords.length) return match.all(expression, eligible, eligible, limit, offset);
      // Reuse the candidate SQL: fix base MATCH representatives before long-word ranking.
      const ranked = db.prepare(`${rankedSql} SELECT rowid, score,
        (SELECT count(*) FROM han_rank WHERE han_rank.rowid = ranked.rowid AND term IN (${longWords.map(() => '?').join(',')})) AS long_word_score
        FROM ranked WHERE representative = 1
        ORDER BY long_word_score DESC, score, timestamp DESC, recency DESC, rowid DESC LIMIT ? OFFSET ?`);
      return ranked.all(expression, eligible, eligible, ...longWords, limit, offset);
    });
    check?.(); // SQLite is synchronous and cannot check a deadline inside MATCH.
    return { total, results: materialize(native, snippetTerms, timer, check) };
  }
  function automaticRows(query, timer, limit, offset = 0, eligibleCount = -1) {
    const text = extractText(query);
    if (weightedLength(text) > autoGate) return { skipped: true, total: 0, results: [], queryTerms: [] };
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('limit must be a non-negative safe integer');
    const queryTerms = [...new Set(tokenizeAutomatic(text).filter(term => !STOPWORDS.has(term)))];
    if (!queryTerms.length) return { skipped: false, total: 0, results: [], queryTerms };
    const terms = queryTerms.map(term => ({ term, stem: true }));
    const expression = terms.map(({ term }) => porterTerm(term, stem)).join(' OR ');
    const longWords = ranking.longWordRanking ? queryTerms.filter(term => /^\p{Script=Han}{3,}$/u.test(term)) : [];
    const found = collect(expression, terms, timer, undefined, { limit, offset, eligibleCount }, longWords);
    return { skipped: false, ...found, queryTerms };
  }
  function conceptRows(query, timer, check, options) {
    check?.();
    // Items past the group/alternative/exclusion limits are dropped and reported instead of failing the call.
    const clamped = [];
    const parsed = parseQuery(query, { clamped }), analyses = new Map();
    const analyze = surface => {
      let analysis = analyses.get(surface);
      if (!analysis) {
        const spans = tokenizeSpans(surface);
        analysis = { spans, terms: spans.map(span => span.term) };
        analyses.set(surface, analysis);
      }
      return analysis;
    };
    // A surface without searchable terms is dropped with a warning, like partial token loss; the query still fails
    // with the original compiler error when no positive surface remains.
    const searchable = surface => analyze(surface).terms.length > 0;
    const concepts = parsed.concepts.map(group => group.filter(searchable)).filter(group => group.length);
    const normalized = concepts.length ? { ...parsed, concepts, exclude: parsed.exclude.filter(searchable) } : parsed;
    const dropped = concepts.length ? [...new Set([...parsed.concepts.flat(), ...parsed.exclude].filter(surface => !searchable(surface)))] : [];
    const plan = measured(timer, 'concept_query_compile', () => compileFts5(normalized, surface => {
      const { terms } = analyze(surface);
      return terms.length ? [terms] : [];
    }));
    // Compile first so zero-token surfaces retain the author's original error.
    const warnings = clamped.map(({ path, max, ignored }) => `Warning: ${path} has more than ${max} items; ignored ${safeQueryData(ignored)}.`);
    if (dropped.length) warnings.push(`Warning: ${safeQueryData(dropped)} produced no searchable terms and ${dropped.length === 1 ? 'was' : 'were'} ignored. Suggestion: use other words or history_grep.`);
    for (const [surface, { spans, terms }] of analyses) {
      check?.();
      if (!terms.length) continue;
      const chars = Array.from(surface), covered = new Uint8Array(chars.length);
      for (const span of spans) covered.fill(1, span.start, span.end);
      if (chars.some((point, at) => meaningful.test(point) && !covered[at])) {
        warnings.push(`Warning: ${safeQueryData(surface)} → ${safeQueryData([...new Set(terms)])}. Suggestion: revise query terms or use history_grep.`);
      }
    }
    // Only positive terms select snippets; exclusions remain in MATCH alone.
    const terms = new Set(normalized.concepts.flatMap(group => group.flatMap(surface => analyses.get(surface).terms)));
    const snippets = [...terms].map(term => ({ term }));
    check?.();
    const longWords = ranking.longWordRanking ? [...new Set(normalized.concepts.flat().filter(surface => /^\p{Script=Han}{3,}$/u.test(surface)))] : [];
    return { ...collect(plan.match, snippets, timer, check, options, longWords), warnings };
  }
  return {
    get size() { return corpus.length; },
    append(documents) { appendDocuments(documents); },
    queryRows(query, { mode = 'manual', timer, check, limit, offset = 0, eligibleCount = -1 } = {}) {
      return mode === 'auto' ? automaticRows(query, timer, limit, offset, eligibleCount) : conceptRows(query, timer, check, { limit, offset, eligibleCount });
    },
    queryPage(query, options = {}, { timer, check } = {}) {
      const limit = options.limit ?? 50, offset = options.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('limit must be an integer from 1 to 50');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a nonnegative safe integer');
      const found = conceptRows(query, timer, check, { limit, offset, eligibleCount: options.eligibleCount });
      const page = sqliteRecallPage(found.results, options, { total: found.total, baseOffset: offset, warnings: found.warnings });
      check?.();
      const ids = found.results.slice(0, page.details.returned).map(row => row.id);
      return { total: found.total, page, ids };
    },
    close() { db.close(); },
  };
}
