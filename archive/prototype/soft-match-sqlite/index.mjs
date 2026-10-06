import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { queryOperands } from './query.mjs';
import { createTokenizer } from './arms.mjs';
import { STOPWORDS } from './lexical.mjs';
import { createJsStemmer } from './porter-js.mjs';
import { createStemmer, porterTerm } from './porter.mjs';
import { createInflections } from './inflect.mjs';
import { createLemmaNormalizer } from './lemma.mjs';
import { selectFts5Range } from '../../benchmark/fts5-snippet.mjs';
import { measured } from '../../../src/timing.mjs';
import { sqliteRecallPage } from '../../benchmark/retrieval-sqlite-page.mjs';
import { createHanPhraseTrial } from './han-phrase-trial.mjs';
import { compileFts5, parseQuery } from './concept-query-compiler.mjs';
export { STOPWORDS, tokenize, tokenizeSpans } from './lexical.mjs';
const HAN = /\p{Script=Han}/u;
const meaningful = /[\p{L}\p{N}\p{M}]/u;
const safeQueryData = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
  point => `\\u${point.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function weightedLength(text) {
  let length = 0;
  for (const point of text) length += HAN.test(point) ? 2 : 1;
  return length;
}

export function parseAutoGate(value = 210) {
  const gate = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(gate) || gate <= 0) {
    throw new RangeError('COMPACTION_RECALL_AUTO_GATE must be a positive safe integer');
  }
  return gate;
}

export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}


export function createIndex(documents, { arm = 'off', autoGate = 210, snippetBudget, timer: buildTimer } = {}) {
  // Temporary RSM-ZHMEM switch: 1 = raw bigrams; porter = bigrams + stems.
  const bigramOnly = process.env.COMPACTION_RECALL_SQLITE_BIGRAM_ONLY;
  if (bigramOnly === '1') arm = 'off';
  else if (bigramOnly === 'porter') arm = 'porter';
  const trialMode = process.env.COMPACTION_RECALL_SQLITE_HAN_PHRASE_TRIAL;
  const trial = createHanPhraseTrial(trialMode);
  autoGate = parseAutoGate(autoGate);
  const budget = Number.isSafeInteger(snippetBudget) && snippetBudget > 0 ? snippetBudget : 240;
  const { tokenize, tokenizeSpans } = trial.tokenizer;
  const automaticTokenizer = ['jieba', 'porter-jieba'].includes(arm) ? (trial.automaticTokenizer ?? createTokenizer(arm)) : createTokenizer(arm);
  const porter = arm === 'porter' || arm === 'porter-jieba' || arm === 'porter-js';
  const lemma = arm === 'lemma-index' ? createLemmaNormalizer() : undefined;
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
  const corpus = [...byId.values()].filter(document => document.text !== '');
  const db = new DatabaseSync(':memory:');
  let match, count, stem, inflections, rankedSql;
  try {
    db.exec(`
      PRAGMA temp_store = MEMORY;
      CREATE VIRTUAL TABLE terms USING fts5(
        tokens, ${porter ? 'stems,' : ''} content='', columnsize=1, detail=full,
        tokenize='ascii'
      );
      CREATE VIRTUAL TABLE vocabulary USING fts5vocab(terms, '${porter ? 'col' : 'row'}');
      CREATE TABLE messages(rowid INTEGER PRIMARY KEY, content_hash BLOB NOT NULL, timestamp TEXT NOT NULL, recency INTEGER NOT NULL);
      BEGIN;
    `);
    if (arm === 'porter' || arm === 'porter-jieba') stem = createStemmer(db);
    else if (arm === 'porter-js') stem = createJsStemmer();
    const insert = db.prepare(porter
      ? 'INSERT INTO terms(rowid, tokens, stems) VALUES (?, ?, ?)'
      : 'INSERT INTO terms(rowid, tokens) VALUES (?, ?)');
    const insertMessage = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)');
    let insertLongWord;
    if (trial?.jieba) {
      db.exec('CREATE TABLE han_rank(rowid INTEGER NOT NULL, term TEXT NOT NULL, PRIMARY KEY(rowid, term)) WITHOUT ROWID');
      insertLongWord = db.prepare('INSERT INTO han_rank VALUES (?, ?)');
    }
    corpus.forEach((document, i) => {
      const tokens = tokenize(document.text);
      if (lemma) for (let at = 0; at < tokens.length; at++) tokens[at] = lemma.normalize(tokens[at]);
      if (stem) insert.run(i + 1, tokens.join(' '), tokens.map(stem).filter(Boolean).join(' '));
      else insert.run(i + 1, tokens.join(' '));
      const hash = createHash('sha256').update(document.text.replace(/\s+/g, ' ').trim()).digest();
      insertMessage.run(i + 1, hash, document.timestamp, document.recency);
      if (insertLongWord) for (const word of trial.longWords(document.text)) insertLongWord.run(i + 1, word);
    });
    db.exec('COMMIT');
    if (arm === 'inflect-wink') inflections = createInflections(db.prepare('SELECT term FROM vocabulary').all().map(row => row.term));
    // MATERIALIZED keeps FTS5's bm25 auxiliary call inside its MATCH cursor.
    const scored = `SELECT terms.rowid, bm25(terms${stem ? `, 1.0, ${arm === 'porter-js' ? '1.0' : '0.5'}` : ''}) AS score,
      messages.content_hash, messages.timestamp, messages.recency
      FROM terms JOIN messages ON messages.rowid = terms.rowid WHERE terms MATCH ?`;
    rankedSql = `WITH hits AS MATERIALIZED (${scored}), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY content_hash ORDER BY score, timestamp DESC, recency DESC, rowid DESC) AS representative FROM hits
    )`;
    match = db.prepare(`${rankedSql} SELECT rowid, score FROM ranked WHERE representative = 1
      ORDER BY score, timestamp DESC, recency DESC, rowid DESC LIMIT ? OFFSET ?`);
    count = db.prepare('SELECT count(DISTINCT content_hash) AS total FROM terms JOIN messages ON messages.rowid = terms.rowid WHERE terms MATCH ?');
  } catch (error) { db.close(); throw error; }

  function compileOperands(operands, check) {
    const raw = new Map(), stems = new Map(), rawPrefixes = [], stemPrefixes = [], widths = new Set(), cache = new Map();
    const add = (map, term, index) => {
      if (!map.has(term)) map.set(term, []);
      map.get(term).push(index);
    };
    for (let i = 0; i < operands.length; i++) {
      check?.();
      const operand = operands[i];
      if (!operand.columns || operand.columns.includes('tokens')) {
        if (operand.prefix) rawPrefixes.push([operand.term, i]);
        else add(raw, operand.term, i);
      }
      if (operand.columns && !operand.columns.includes('stems')) continue;
      const alias = operand.stem ? stem(operand.term) : operand.term;
      if (alias === undefined) continue;
      if (operand.prefix) stemPrefixes.push([alias, i]);
      else { add(stems, alias, i); widths.add(alias.split(' ').length); }
    }
    return value => {
      if (cache.has(value)) return cache.get(value);
      const matched = new Set(raw.get(value));
      for (const [prefix, i] of rawPrefixes) if (value.startsWith(prefix)) matched.add(i);
      const alias = stem(value);
      if (alias !== undefined) {
        const pieces = alias.split(' ');
        for (const width of widths) for (let at = 0; at + width <= pieces.length; at++) {
          const key = width === 1 ? pieces[at] : pieces.slice(at, at + width).join(' ');
          for (const i of stems.get(key) ?? []) matched.add(i);
        }
        for (const [prefix, i] of stemPrefixes) if (` ${alias}`.includes(` ${prefix}`)) matched.add(i);
      }
      const terms = [...matched].sort((a, b) => a - b).map(i => operands[i].term);
      cache.set(value, terms);
      return terms;
    };
  }
  function materialize(native, snippetTerms, timer, check) {
    const exact = new Set(snippetTerms.filter(term => !term.prefix).map(({ term }) => term));
    const prefixes = [...new Set(snippetTerms.filter(term => term.prefix).map(({ term }) => term))];
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
            snippetMatch ??= stem ? compileOperands(snippetTerms, check) : undefined;
            document.spans ??= lemma ? tokenizeSpans(document.text).map(span => ({ ...span, term: lemma.normalize(span.term) })) : tokenizeSpans(document.text);
            const found = [];
        for (let at = 0; at < document.spans.length; at++) {
          if ((at & 255) === 0) check?.();
          const span = document.spans[at];
              if (stem) for (const term of snippetMatch(span.term)) found.push({ ...span, term });
              else {
                if (exact.has(span.term)) found.push(span);
                for (const term of prefixes) if (span.term.startsWith(term)) found.push({ ...span, term });
      }
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
  function collect(expression, snippetTerms, timer, check, { limit = -1, offset = 0 } = {}, longWords = []) {
    check?.();
    const total = measured(timer, 'native_count', () => count.get(expression).total);
    check?.();
    const native = measured(timer, 'native_query', () => {
      if (!trial.jieba || !longWords.length) return match.all(expression, limit, offset);
      // Reuse the trial SQL: fix base MATCH representatives before long-word ranking.
      const ranked = db.prepare(`${rankedSql} SELECT rowid, score,
        (SELECT count(*) FROM han_rank WHERE han_rank.rowid = ranked.rowid AND term IN (${longWords.map(() => '?').join(',')})) AS long_word_score
        FROM ranked WHERE representative = 1
        ORDER BY long_word_score DESC, score, timestamp DESC, recency DESC, rowid DESC LIMIT ? OFFSET ?`);
      return ranked.all(expression, ...longWords, limit, offset);
    });
    check?.(); // SQLite is synchronous and cannot check a deadline inside MATCH.
    return { total, results: materialize(native, snippetTerms, timer, check) };
  }
  function automaticRows(query, automatic, timer, limit, offset = 0) {
    const text = extractText(query);
    if (automatic && weightedLength(text) > autoGate) return { skipped: true, total: 0, results: [], queryTerms: [] };
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('limit must be a non-negative safe integer');
    const queryTerms = [...new Set(automaticTokenizer.tokenize(text).filter(term => !STOPWORDS.has(term)).map(term => lemma ? lemma.normalize(term) : term))];
    if (!queryTerms.length) return { skipped: false, total: 0, results: [], queryTerms };
    const terms = queryTerms.map(term => ({
      term,
      prefix: arm === 'prefix-all' || (arm === 'prefix-min4' && /^[A-Za-z0-9_]{4,}$/.test(term)),
      ...(stem ? { stem: true } : {}),
    }));
    const expression = terms.map(({ term, prefix }) => stem ? porterTerm(term, stem, prefix)
      : inflections ? `(${inflections.expand(term).map(value => `"${value}"`).join(' OR ')})`
        : `"${term.replaceAll('"', '""')}"${prefix ? '*' : ''}`).join(' OR ');
    const expanded = inflections ? queryOperands(expression) : terms;
    const longWords = trial.jieba ? queryTerms.filter(term => /^\p{Script=Han}{3,}$/u.test(term)) : [];
    const found = collect(expression, expanded, timer, undefined, { limit, offset }, longWords);
    return { skipped: false, ...found, queryTerms };
  }
  function conceptRows(query, timer, check, options) {
    check?.();
    const normalized = parseQuery(query), analyses = new Map();
    const plan = measured(timer, 'concept_query_compile', () => compileFts5(normalized, surface => {
      const spans = tokenizeSpans(surface);
      const terms = spans.map(span => lemma ? lemma.normalize(span.term) : span.term);
      analyses.set(surface, { spans, terms });
      return terms.length ? [terms] : [];
    }));
    // Compile first so zero-token surfaces retain the author's original error.
    const warnings = [];
    for (const [surface, { spans, terms }] of analyses) {
      check?.();
      const chars = Array.from(surface), covered = new Uint8Array(chars.length);
      for (const span of spans) covered.fill(1, span.start, span.end);
      if (chars.some((point, at) => meaningful.test(point) && !covered[at])) {
        warnings.push(`Warning: ${safeQueryData(surface)} → ${safeQueryData([...new Set(terms)])}. Suggestion: revise query terms or use history_grep.`);
      }
    }
    // Only positive terms select snippets; exclusions remain in MATCH alone.
    const terms = new Set(normalized.concepts.flatMap(group => group.flatMap(surface => analyses.get(surface).terms)));
    const snippets = [...terms].map(term => ({ term, prefix: false }));
    check?.();
    const longWords = trial.jieba ? [...new Set(normalized.concepts.flat().filter(surface => /^\p{Script=Han}{3,}$/u.test(surface)))] : [];
    return { ...collect(plan.match, snippets, timer, check, options, longWords), warnings };
  }
  const ranks = rows => rows.map(({ id, score }) => ({ id, score }));
  return {
    size: corpus.length,
    stats() {
      const pageSize = db.prepare('PRAGMA page_size').get().page_size;
      const pageCount = db.prepare('PRAGMA page_count').get().page_count;
      return { documents: corpus.length, contentGroups: db.prepare('SELECT count(DISTINCT content_hash) AS groups FROM messages').get().groups, pageSize, pageCount, storageBytes: pageSize * pageCount };
    },
    inflectionStats() { return inflections ? { ...inflections.stats } : undefined; },
    expansionTerms(query) {
      const text = extractText(query);
      if (weightedLength(text) > autoGate) return [];
      return [...new Set(automaticTokenizer.tokenize(text).filter(term => !STOPWORDS.has(term)))].map(term => ({ term, variants: inflections ? inflections.expand(term) : [term] }));
    },
    queryRows(query, { mode = 'manual', timer = buildTimer, check, limit, offset = 0 } = {}) {
      return mode === 'auto' ? automaticRows(query, true, timer, limit, offset) : conceptRows(query, timer, check, { limit, offset });
    },
    queryPage(query, options = {}, { timer = buildTimer, check } = {}) {
      const limit = options.limit ?? 50, offset = options.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('limit must be an integer from 1 to 50');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a nonnegative safe integer');
      const found = conceptRows(query, timer, check, { limit, offset });
      const page = sqliteRecallPage(found.results, options, { total: found.total, baseOffset: offset, warnings: found.warnings });
      check?.();
      const ids = found.results.slice(0, page.details.returned).map(row => row.id);
      return { total: found.total, page, ids };
    },
    search(query, { automatic = false, limit = 20 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative safe integer');
      if (!automatic) {
        const found = conceptRows(query, buildTimer, undefined, { limit });
        return { ...found, results: ranks(found.results) };
      }
      const found = automaticRows(query, automatic, buildTimer, limit);
      if (found.skipped) return found;
      return { ...found, results: ranks(found.results) };
    },
    close() { db.close(); },
  };
}
