import { createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const alphabetic = /^[a-z]+$/i;

export function createInflections(indexTerms) {
  if (isMainThread) throw new Error('inflect-wink is worker-only');
  const started = performance.now();
  const wink = require('wink-lemmatizer');
  const loaded = performance.now();
  const cache = new Map(), lemmaMap = new Map();
  function lemmas(word) {
    if (!cache.has(word)) cache.set(word, new Set([wink.noun(word), wink.verb(word), wink.adjective(word)]));
    return cache.get(word);
  }
  const words = new Set();
  for (const term of indexTerms) if (alphabetic.test(term)) words.add(term.toLowerCase());
  let lemmaLinks = 0;
  for (const word of words) {
    for (const lemma of lemmas(word)) {
      if (!lemmaMap.has(lemma)) lemmaMap.set(lemma, new Set());
      lemmaMap.get(lemma).add(word);
      lemmaLinks++;
    }
  }
  const built = performance.now();
  const stats = { indexedWords: words.size, lemmaEntries: lemmaMap.size, lemmaLinks,
    buildMs: built - started, dependencyLoadMs: loaded - started, tableBuildMs: built - loaded };
  function expand(term) {
    const word = term.toLowerCase(), matches = new Set();
    if (alphabetic.test(word)) {
      for (const lemma of lemmas(word)) for (const match of lemmaMap.get(lemma) ?? []) matches.add(match);
    }
    matches.delete(word);
    return [word, ...[...matches].sort()];
  }
  return { expand, expression: query => inflectionExpression(query, expand), stats };
}

// Follow porter's native phrase/scoped-group walk, but explicit syntax is an
// escape hatch here. SQLite, not this scanner, still validates MATCH grammar.
function inflectionExpression(query, expand) {
  const tokens = [...query.matchAll(/"(?:[^"]|"")*"|[A-Za-z0-9_\x1a\u0080-\u{10ffff}]+|[^ \t\r\n]/gu)];
  const text = i => tokens[i]?.[0];
  if (tokens.some(token => token[0] === '"')) return query;
  const string = i => tokens[i] && /^["A-Za-z0-9_\x1a\u0080-\u{10ffff}]/u.test(text(i)) && !['AND', 'OR', 'NOT'].includes(text(i));
  const closes = new Map(), stack = [];
  for (let i = 0; i < tokens.length; i++) {
    if (['(', '{'].includes(text(i))) stack.push(i);
    else if ([')', '}'].includes(text(i))) {
      if (text(stack.at(-1)) !== (text(i) === ')' ? '(' : '{')) return query;
      closes.set(stack.pop(), i);
    }
  }
  if (stack.length) return query;
  const replacements = [];
  function walk(start, end, scoped = false) {
    for (let i = start; i < end;) {
      let at = i, filtered = scoped;
      if (text(at) === '-') at++;
      const columnEnd = text(at) === '{' ? closes.get(at) : string(at) ? at : undefined;
      if (columnEnd !== undefined && text(columnEnd + 1) === ':') {
        filtered = true;
        at = columnEnd + 2;
      } else at = i;
      if (text(at) === '(') {
        const close = closes.get(at);
        if (!filtered) walk(at + 1, close);
        i = close + 1;
        continue;
      }
      const first = at;
      if (['^', '+', '-'].includes(text(at))) at++;
      if (text(at) === 'NEAR' && text(at + 1) === '(') {
        i = closes.get(at + 1) + 1;
        continue;
      }
      if (!string(at)) { i++; continue; }
      at++;
      if (text(at) === '*') at++;
      while (['+', '-'].includes(text(at)) && string(at + 1)) {
        at += 2;
        if (text(at) === '*') at++;
      }
      if (!filtered && at === first + 1 && alphabetic.test(text(first)) &&
          !['+', '-', '^', '*'].includes(text(first - 1)) && !['+', '-', '^', '*'].includes(text(at))) {
        const expanded = expand(text(first));
        // No matching indexed alternative: leave the native operand untouched.
        if (expanded.length > 1) replacements.push({ start: tokens[first].index,
          end: tokens[first].index + text(first).length,
          text: `(${expanded.map(word => `"${word}"`).join(' OR ')})` });
      }
      i = at;
    }
  }
  walk(0, tokens.length);
  let result = '', offset = 0;
  for (const replacement of replacements) {
    result += query.slice(offset, replacement.start) + replacement.text;
    offset = replacement.end;
  }
  return result + query.slice(offset);
}
