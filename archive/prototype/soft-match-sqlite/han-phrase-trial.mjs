// Isolated index experiment; no query compiler or model-facing autocut switch.
import { createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import { tokenizeSpans as lexicalSpans } from './lexical.mjs';
const HAN = /^\p{Script=Han}+$/u;
const BOUNDARY = '\ue000'; // Position barrier after a Han run; not a dictionary word.
const baseSpans = text => lexicalSpans(text, () => []);
const tokenizer = {
  tokenizeSpans: baseSpans,
  tokenize(text) {
    const spans = baseSpans(text), tokens = [];
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i], next = spans[i + 1];
      tokens.push(span.term);
      if (HAN.test(span.term) && (!next || !HAN.test(next.term) || next.start !== span.start + 1)) tokens.push(BOUNDARY);
    }
    return tokens;
  },
};

export function createHanPhraseTrial(mode = isMainThread ? 'off' : 'jieba') {
  if (!['off', 'jieba'].includes(mode)) throw new SyntaxError('Han phrase trial mode must be off or jieba');
  let jieba;
  if (mode === 'jieba') {
    if (isMainThread) throw new Error('Han phrase trial jieba is worker-only');
    const require = createRequire(import.meta.url);
    const { Jieba } = require('@node-rs/jieba');
    const { dict } = require('@node-rs/jieba/dict');
    jieba = Jieba.withDict(dict);
  }
  const augmentedSpans = jieba ? text => lexicalSpans(text, word => jieba.cutForSearch(word, true)) : undefined;
  return {
    tokenizer, jieba: mode === 'jieba',
    automaticTokenizer: augmentedSpans ? { tokenize: text => augmentedSpans(text).map(span => span.term) } : undefined,
    longWords(text) {
      const words = new Set();
      if (jieba) for (const [run] of text.matchAll(/\p{Script=Han}+/gu)) {
        for (const word of jieba.cutForSearch(run, true)) if (HAN.test(word) && Array.from(word).length >= 3) words.add(word);
      }
      return words;
    },
  };
}
