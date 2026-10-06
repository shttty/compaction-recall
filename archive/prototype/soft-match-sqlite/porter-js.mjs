import { createRequire } from 'node:module';

// Load only when the evaluation arm is enabled. Match native porter-ascii
// lexeme boundaries for identifiers: '_'/'$' separate component positions.
export function createJsStemmer() {
  const { stemmer } = createRequire(import.meta.url)('@orama/stemmers/english');
  const cache = new Map();
  return term => {
    if (!/^[a-z0-9_$]+$/i.test(term)) return undefined;
    if (!cache.has(term)) {
      const words = term.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      cache.set(term, words.map(stemmer).join(' ') || undefined);
    }
    return cache.get(term);
  };
}
