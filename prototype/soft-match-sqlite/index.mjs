import { DatabaseSync } from 'node:sqlite';
import { prefixExpression, queryOperands } from './query.mjs';
import { createTokenizer } from './arms.mjs';
import { STOPWORDS } from './lexical.mjs';
import { createJsStemmer } from './porter-js.mjs';
import { createStemmer, porterExpression, porterTerm } from './porter.mjs';
import { createInflections } from './inflect.mjs';
import { createLemmaNormalizer } from './lemma.mjs';
import { fts5Snippet } from '../../benchmark/fts5-snippet.mjs';
import { measured } from '../../src/timing.mjs';
export { STOPWORDS, tokenize, tokenizeSpans } from './lexical.mjs';
const HAN = /\p{Script=Han}/u;

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

export function createIndex(documents, { arm = 'off', timer: buildTimer } = {}) {
  const { tokenize, tokenizeSpans } = createTokenizer(arm);
  const porter = arm === 'porter' || arm === 'porter-js';
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
    if (arm === 'porter') stem = createStemmer(db);
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

  function collect(expression, actualTerms, snippetTerms, timer) {
    const native = measured(timer, 'native_query', () => match.all(expression));
    const exact = new Set(snippetTerms.filter(term => !term.prefix).map(({ term }) => term));
    const prefixes = [...new Set(snippetTerms.filter(term => term.prefix).map(({ term }) => term))];
    const candidates = measured(timer, 'candidate_materialization', () => native.map(({ rowid, score }) => {
      const document = corpus[rowid - 1];
      document.spans ??= lemma ? tokenizeSpans(document.text).map(span => ({ ...span, term: lemma.normalize(span.term) })) : tokenizeSpans(document.text);
      document.terms ??= new Set(document.spans.map(span => span.term));
      const matches = new Set();
      for (const { term, prefix } of stem ? [] : actualTerms) {
        if (!prefix && document.terms.has(term)) matches.add(term);
        if (prefix) for (const value of document.terms) {
          if (value.startsWith(term)) { matches.add(term); break; }
        }
      }
      const hits = [];
      for (const span of document.spans) {
        if (!stem) {
          if (exact.has(span.term)) hits.push(span);
          for (const term of prefixes) if (span.term.startsWith(term)) hits.push({ ...span, term });
        } else {
          for (const operand of actualTerms) if (matchesOperand(span.term, operand)) matches.add(operand.term);
          for (const operand of snippetTerms) if (matchesOperand(span.term, operand)) hits.push({ ...span, term: operand.term });
        }
      }
      if (stem) {
        let stemText;
        for (const operand of actualTerms) {
          const alias = operand.stem ? stem(operand.term) : undefined;
          if (!alias?.includes(' ') || matches.has(operand.term)) continue;
          stemText ??= ` ${document.spans.map(span => stem(span.term)).filter(Boolean).join(' ')} `;
          if (stemText.includes(` ${alias}${operand.prefix ? '' : ' '}`)) matches.add(operand.term);
        }
      }
      return { document, score, matches: matches.size, hits };
    }));
    measured(timer, 'snippet_render', () => {
      for (const candidate of candidates) candidate.snippet = fts5Snippet(candidate.document.text, candidate.hits, 120, { sentenceBonus: false });
    });
    const distinct = measured(timer, 'deduplicate', () => {
      const snippets = new Map();
      for (const candidate of candidates) {
        const key = candidate.snippet.replace(/\s+/g, ' ').trim();
        const previous = snippets.get(key);
        if (!previous || candidate.document.recency > previous.document.recency) snippets.set(key, candidate);
      }
      return [...snippets.values()];
    });
    measured(timer, 'mechanical_rank', () => distinct.sort((a, b) =>
      a.score - b.score || b.matches - a.matches || b.document.recency - a.document.recency));
    return distinct.map(({ document, score, snippet }) => ({
      id: document.id, score,
      date: document.date ?? '', role: document.role ?? 'user', snippet
    }));
  }
  function matchesOperand(value, operand) {
    const compare = candidate => candidate !== undefined && (operand.prefix ? candidate.startsWith(operand.term) : candidate === operand.term);
    if ((!operand.columns || operand.columns.includes('tokens')) && compare(value)) return true;
    if (operand.columns && !operand.columns.includes('stems')) return false;
    const alias = stem(value);
    const target = operand.stem ? stem(operand.term) : operand.term;
    if (alias === undefined || target === undefined) return false;
    return operand.prefix ? ` ${alias}`.includes(` ${target}`) : ` ${alias} `.includes(` ${target} `);
  }
  function automaticRows(query, automatic, timer, limit) {
    const text = extractText(query);
    if (automatic && weightedLength(text) > 210) return { skipped: true, total: 0, results: [], queryTerms: [] };
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
  function rawRows(query, timer) {
    const effective = prefixExpression(query, arm);
    const grouped = implicitOr(effective);
    const porter = stem ? porterExpression(grouped, stem) : undefined;
    const expression = lemma ? lemma.expression(grouped) : inflections ? inflections.expression(grouped) : porter?.expression ?? grouped;
    const actual = porter?.operands ?? queryOperands(expression);
    const snippets = actual.flatMap(operand => operand.prefix ? [operand] :
      tokenize(operand.term).map(term => ({ ...operand, term, prefix: false })));
    const results = collect(expression, actual, snippets, timer);
    return { total: results.length, results };
  }
  const ranks = rows => rows.map(({ id, score }) => ({ id, score }));
  return {
    size: corpus.length,
    inflectionStats() { return inflections ? { ...inflections.stats } : undefined; },
    expansionTerms(query) {
      const text = extractText(query);
      if (weightedLength(text) > 210) return [];
      return [...new Set(tokenize(text).filter(term => !STOPWORDS.has(term)))].map(term => ({ term, variants: inflections ? inflections.expand(term) : [term] }));
    },
    missingTerms(query) {
      const effective = prefixExpression(query, arm);
      const grouped = implicitOr(effective);
      const terms = (stem ? porterExpression(effective, stem).operands : queryOperands(lemma ? lemma.expression(grouped) : inflections ? inflections.expression(grouped) : grouped)).filter(({ prefix }) => !prefix);
      if (!stem) return [...new Set(terms.map(({ term }) => term))].filter(term => !vocabulary.get(term));
      return [...new Set(terms.filter(operand => {
        const columns = operand.columns ?? ['tokens', 'stems'];
        return !columns.some(column => {
          const term = column === 'stems' && operand.stem ? stem(operand.term) : operand.term;
          return term !== undefined && (column === 'stems' && operand.stem ? term.split(' ') : [term])
            .every(value => vocabulary.get(value, column));
        });
      }).map(({ term }) => term))];
    },
    queryRows(query, { mode = 'manual', timer = buildTimer } = {}) {
      return mode === 'auto' ? automaticRows(query, true, timer) : rawRows(query, timer);
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
