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
  return { expand, stats };
}
