import { createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';

export function createLemmaNormalizer() {
  if (isMainThread) throw new Error('lemma-index is worker-only');
  const wink = createRequire(import.meta.url)('wink-lemmatizer');
  const cache = new Map();
  function normalize(term) {
    if (!/^[a-z]+$/i.test(term)) return term;
    const word = term.toLowerCase();
    if (!cache.has(word)) {
      let lemma = word;
      for (const fn of [wink.verb, wink.noun, wink.adjective]) {
        const result = fn(word);
        if (result !== word) { lemma = result; break; }
      }
      cache.set(word, lemma);
    }
    return cache.get(word);
  }
  return { normalize };
}
