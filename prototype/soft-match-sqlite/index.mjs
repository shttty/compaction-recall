import { DatabaseSync } from 'node:sqlite';
import { prefixExpression, queryOperands } from './query.mjs';
import { createTokenizer } from './arms.mjs';
import { STOPWORDS } from './lexical.mjs';
import { createJsStemmer } from './porter-js.mjs';
import { createStemmer, porterExpression, porterTerm } from './porter.mjs';
import { createInflections } from './inflect.mjs';
import { createLemmaNormalizer } from './lemma.mjs';
import { selectFts5Range } from '../../benchmark/fts5-snippet.mjs';
import { measured } from '../../src/timing.mjs';
import { sqliteRecallPage } from '../../benchmark/retrieval-sqlite-page.mjs';
export { STOPWORDS, tokenize, tokenizeSpans } from './lexical.mjs';
const HAN = /\p{Script=Han}/u;

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

// Recognize FTS5 operands, not document terms. Keep native implicit-AND grouping
// when replacing its connectors; SQLite remains responsible for syntax errors.
export function implicitOr(query, check) {
  const tokens = [];
  for (const match of query.matchAll(/"(?:[^"]|"")*"|[A-Za-z0-9_\x1a\u0080-\uffff]+|[^ \t\r\n]/g)) {
    check?.();
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  // Do not turn an unterminated quote into another error or a valid expression.
  if (tokens.some(token => token.text === '"')) return query;
  const text = i => tokens[i]?.text;
  const isString = i => tokens[i] && /^["A-Za-z0-9_\x1a\u0080-\uffff]/.test(text(i)) &&
    !['AND', 'OR', 'NOT'].includes(text(i));
  const closes = new Map();
  const delimiters = [];
  for (let i = 0; i < tokens.length; i++) {
    check?.();
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
        check?.();
        i += 2;
        if (text(i) === '*') i++;
      }
    }
    return { next: i, start: tokens[start].start, end: tokens[i - 1].end };
  }
  const inserts = [];
  const scopes = [[0, tokens.length]];
  while (scopes.length) {
    check?.();
    const [start, end] = scopes.pop();
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        inserts.push({ at: run[0].start, text: '(' });
        for (let i = 1; i < run.length; i++) {
          check?.();
          inserts.push({ at: run[i].start, text: run[i - 1].end === run[i].start ? ' OR ' : 'OR ' });
        }
        inserts.push({ at: run.at(-1).end, text: ')' });
      }
      run = [];
    };
    for (let i = start; i < end;) {
      check?.();
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
  inserts.sort((a, b) => { check?.(); return a.at - b.at; });
  let rewritten = '', offset = 0;
  for (const insert of inserts) {
    check?.();
    rewritten += query.slice(offset, insert.at) + insert.text;
    offset = insert.at;
  }
  return rewritten + query.slice(offset);
}

export function createIndex(documents, { arm = 'off', autoGate = 210, snippetBudget, timer: buildTimer } = {}) {
  autoGate = parseAutoGate(autoGate);
  const weightedSnippet = Number.isSafeInteger(snippetBudget) && snippetBudget > 0;
  const budget = weightedSnippet ? snippetBudget : 120;
  const { tokenize, tokenizeSpans } = createTokenizer(arm);
  const porter = arm === 'porter' || arm === 'porter-jieba' || arm === 'porter-js';
  const lemma = arm === 'lemma-index' ? createLemmaNormalizer() : undefined;
  // Latest id wins before the empty check, so a latest empty edit hides older text.
  const byId = new Map();
  documents.forEach((document, i) => {
    const recency = document.sourcePosition ?? document.recency ?? i;
    const previous = byId.get(document.id);
    if (!previous || recency >= previous.recency) byId.set(document.id, {
      id: document.id, text: document.text, date: document.date, role: document.role, recency,
    });
  });
  const corpus = [...byId.values()].filter(document => document.text !== '');
  const db = new DatabaseSync(':memory:');
  let match, vocabulary, stem, inflections;
  try {
    db.exec(`
      PRAGMA temp_store = MEMORY;
      CREATE VIRTUAL TABLE terms USING fts5(
        tokens, ${porter ? 'stems,' : ''} content='', columnsize=1, detail=full,
        tokenize="ascii tokenchars '_$'"
      );
      CREATE VIRTUAL TABLE vocabulary USING fts5vocab(terms, '${porter ? 'col' : 'row'}');
      BEGIN;
    `);
    if (arm === 'porter' || arm === 'porter-jieba') stem = createStemmer(db);
    else if (arm === 'porter-js') stem = createJsStemmer();
    const insert = db.prepare(porter
      ? 'INSERT INTO terms(rowid, tokens, stems) VALUES (?, ?, ?)'
      : 'INSERT INTO terms(rowid, tokens) VALUES (?, ?)');
    corpus.forEach((document, i) => {
      const tokens = tokenize(document.text);
      if (lemma) for (let at = 0; at < tokens.length; at++) tokens[at] = lemma.normalize(tokens[at]);
      if (stem) insert.run(i + 1, tokens.join(' '), tokens.map(stem).filter(Boolean).join(' '));
      else insert.run(i + 1, tokens.join(' '));
    });
    db.exec('COMMIT');
    if (arm === 'inflect-wink') inflections = createInflections(db.prepare('SELECT term FROM vocabulary').all().map(row => row.term));
    match = db.prepare(`SELECT rowid, bm25(terms${stem ? `, 1.0, ${arm === 'porter-js' ? '1.0' : '0.5'}` : ''}) AS score FROM terms WHERE terms MATCH ?`);
    vocabulary = db.prepare(stem ? 'SELECT 1 FROM vocabulary WHERE term = ? AND col = ?' : 'SELECT 1 FROM vocabulary WHERE term = ?');
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
  function collect(expression, actualTerms, snippetTerms, timer, check) {
    check?.();
    const native = measured(timer, 'native_query', () => match.all(expression));
    check?.(); // SQLite is synchronous and cannot check a deadline inside MATCH.
    const exact = new Set(snippetTerms.filter(term => !term.prefix).map(({ term }) => term));
    const prefixes = [...new Set(snippetTerms.filter(term => term.prefix).map(({ term }) => term))];
    const candidates = measured(timer, 'candidate_materialization', () => {
      const actualMatch = stem ? compileOperands(actualTerms, check) : undefined;
      const snippetMatch = stem ? actualTerms === snippetTerms ? actualMatch : compileOperands(snippetTerms, check) : undefined;
      const phrases = stem ? actualTerms.map(operand => ({ operand, alias: operand.stem ? stem(operand.term) : undefined }))
        .filter(({ alias }) => alias?.includes(' ')) : [];
      const rows = [];
      for (const { rowid, score } of native) {
        check?.();
        const document = corpus[rowid - 1];
        document.spans ??= lemma ? tokenizeSpans(document.text).map(span => ({ ...span, term: lemma.normalize(span.term) })) : tokenizeSpans(document.text);
        const matches = new Set(), hits = [];
        if (!stem) {
          document.terms ??= new Set(document.spans.map(span => span.term));
          for (const { term, prefix } of actualTerms) {
            check?.();
            if (!prefix && document.terms.has(term)) matches.add(term);
            if (prefix) for (const value of document.terms) if (value.startsWith(term)) { matches.add(term); break; }
          }
        }
        for (let at = 0; at < document.spans.length; at++) {
          if ((at & 255) === 0) check?.();
          const span = document.spans[at];
          if (!stem) {
            if (exact.has(span.term)) hits.push(span);
            for (const term of prefixes) if (span.term.startsWith(term)) hits.push({ ...span, term });
          } else {
            for (const term of actualMatch(span.term)) matches.add(term);
            for (const term of snippetMatch(span.term)) hits.push({ ...span, term });
          }
        }
        for (const { operand, alias } of phrases) {
          check?.();
          if (matches.has(operand.term)) continue;
          document.stemText ??= ` ${document.spans.map(span => stem(span.term)).filter(Boolean).join(' ')} `;
          if (document.stemText.includes(` ${alias}${operand.prefix ? '' : ' '}`)) matches.add(operand.term);
        }
        rows.push({ document, score, matches: matches.size, hits });
      }
      return rows;
    });
    measured(timer, 'snippet_selection', () => {
      for (const candidate of candidates) {
        check?.();
        candidate.document.chars ??= Array.from(candidate.document.text);
        candidate.range = selectFts5Range(candidate.document.chars, candidate.hits, budget, { sentenceBonus: false, check, weighted: weightedSnippet });
        candidate.hits = undefined;
      }
    });
    const snippet = candidate => {
      const { document, range } = candidate;
      return `${range.start > 0 ? '…' : ''}${document.chars.slice(range.start, range.end).join('')}${range.end < document.chars.length ? '…' : ''}`;
    };
    const dedupKey = candidate => {
      const { document, range } = candidate;
      let key = range.start > 0 ? '…' : '', space = false;
      for (let at = range.start; at < range.end; at++) {
        if ((at & 255) === 0) check?.();
        const char = document.chars[at];
        if (/\s/u.test(char)) space = key.length > 0;
        else { key += (space ? ' ' : '') + char; space = false; }
      }
      if (range.end < document.chars.length) key += (space ? ' ' : '') + '…';
      return key;
    };
    const distinct = measured(timer, 'deduplicate', () => {
      const snippets = new Map();
      for (const candidate of candidates) {
        check?.();
        // The key must retain the old query-selected window, not the full text
        // or highest-scoring duplicate. Only the newest representative wins.
        const key = dedupKey(candidate);
        const previous = snippets.get(key);
        if (!previous || candidate.document.recency > previous.document.recency) snippets.set(key, candidate);
      }
      return [...snippets.values()];
    });
    measured(timer, 'mechanical_rank', () => distinct.sort((a, b) => {
      check?.();
      return a.score - b.score || b.matches - a.matches || b.document.recency - a.document.recency;
    }));
    check?.();
    return distinct.map(candidate => ({
      id: candidate.document.id, score: candidate.score,
      date: candidate.document.date ?? '', role: candidate.document.role ?? 'user',
      get snippet() { check?.(); return measured(timer, 'snippet_render', () => snippet(candidate)); },
    }));
  }
  function automaticRows(query, automatic, timer, limit) {
    const text = extractText(query);
    if (automatic && weightedLength(text) > autoGate) return { skipped: true, total: 0, results: [], queryTerms: [] };
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('limit must be a non-negative safe integer');
    const queryTerms = [...new Set(tokenize(text).filter(term => !STOPWORDS.has(term)).map(term => lemma ? lemma.normalize(term) : term))];
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
    const results = collect(expression, expanded, expanded, timer);
    return { skipped: false, total: results.length, results, queryTerms };
  }
  function rawRows(query, timer, check) {
    check?.();
    const prepared = measured(timer, 'expression_rewrite', () => {
      const effective = prefixExpression(query, arm, check);
      const grouped = implicitOr(effective, check);
      const porter = stem ? porterExpression(grouped, stem, check) : undefined;
      const expression = lemma ? lemma.expression(grouped) : inflections ? inflections.expression(grouped) : porter?.expression ?? grouped;
      const actual = porter?.operands ?? queryOperands(expression, check);
      const snippets = actual.flatMap(operand => {
        check?.();
        return operand.prefix ? [operand] : tokenize(operand.term).map(term => ({ ...operand, term, prefix: false }));
      });
      return { expression, actual, snippets };
    });
    check?.();
    const results = collect(prepared.expression, prepared.actual, prepared.snippets, timer, check);
    return { total: results.length, results };
  }
  const ranks = rows => rows.map(({ id, score }) => ({ id, score }));
  return {
    size: corpus.length,
    inflectionStats() { return inflections ? { ...inflections.stats } : undefined; },
    expansionTerms(query) {
      const text = extractText(query);
      if (weightedLength(text) > autoGate) return [];
      return [...new Set(tokenize(text).filter(term => !STOPWORDS.has(term)))].map(term => ({ term, variants: inflections ? inflections.expand(term) : [term] }));
    },
    missingTerms(query, { timer = buildTimer, check } = {}) {
      return measured(timer, 'missing_terms', () => {
        check?.();
        const effective = prefixExpression(query, arm, check);
        const grouped = implicitOr(effective, check);
        const terms = (stem ? porterExpression(effective, stem, check).operands : queryOperands(lemma ? lemma.expression(grouped) : inflections ? inflections.expression(grouped) : grouped, check)).filter(({ prefix }) => !prefix);
        const missing = new Set();
        for (const operand of terms) {
          check?.();
          const columns = operand.columns ?? ['tokens', 'stems'];
          const available = !stem ? vocabulary.get(operand.term) : columns.some(column => {
            const term = column === 'stems' && operand.stem ? stem(operand.term) : operand.term;
            return term !== undefined && (column === 'stems' && operand.stem ? term.split(' ') : [term]).every(value => { check?.(); return vocabulary.get(value, column); });
          });
          if (!available) missing.add(operand.term);
        }
        check?.();
        return [...missing];
      });
    },
    queryRows(query, { mode = 'manual', timer = buildTimer, check } = {}) {
      return mode === 'auto' ? automaticRows(query, true, timer) : rawRows(query, timer, check);
    },
    queryPage(query, options = {}, { timer = buildTimer, check } = {}) {
      const found = rawRows(query, timer, check);
      const missingTerms = this.missingTerms(query, { timer, check });
      const page = sqliteRecallPage(found.results, options, missingTerms);
      check?.();
      const ids = found.results.slice(page.details.offset, page.details.offset + page.details.returned).map(row => row.id);
      return { total: found.total, page, ids, missingTerms };
    },
    search(query, { automatic = false, limit = 20 } = {}) {
      const found = automaticRows(query, automatic, buildTimer, limit);
      if (found.skipped) return found;
      return { ...found, results: ranks(found.results.slice(0, limit)) };
    },
    searchRaw(query, { limit } = {}) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('limit must be a non-negative safe integer');
      const found = rawRows(query, buildTimer);
      return { total: found.total, results: ranks(limit === undefined ? found.results : found.results.slice(0, limit)) };
    },
    close() { db.close(); },
  };
}
