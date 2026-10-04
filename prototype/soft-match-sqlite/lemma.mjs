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
  function expression(query) {
    const tokens = [...query.matchAll(/"(?:[^"]|"")*"|[A-Za-z0-9_$\u0080-\u{10ffff}]+|[^ \t\r\n]/gu)];
    if (tokens.some(token => token[0] === '"')) return query;
    const scopedNames = new Set();
    // Braced column lists and single column names are syntax, not terms.
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i][0] === ':' && i > 0) {
        if (tokens[i - 1][0] === '}') {
          for (let at = i - 2; at >= 0 && tokens[at][0] !== '{'; at--) scopedNames.add(at);
        } else scopedNames.add(i - 1);
      }
    }
    let output = '', offset = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i], text = token[0], prefixed = tokens[i + 1]?.[0] === '*';
      let replacement = text;
      if (!scopedNames.has(i) && !['AND', 'OR', 'NOT', 'NEAR'].includes(text)) {
        if (text.startsWith('"')) {
          const words = [...text.matchAll(/[A-Za-z0-9_$\u0080-\u{10ffff}]+/gu)];
          let phrase = '', start = 0;
          for (let j = 0; j < words.length; j++) {
            const word = words[j];
            phrase += text.slice(start, word.index) + (prefixed && j === words.length - 1 ? word[0] : normalize(word[0]));
            start = word.index + word[0].length;
          }
          replacement = phrase + text.slice(start);
        } else if (!prefixed) replacement = normalize(text);
      }
      output += query.slice(offset, token.index) + replacement;
      offset = token.index + text.length;
    }
    return output + query.slice(offset);
  }
  return { normalize, expression };
}
