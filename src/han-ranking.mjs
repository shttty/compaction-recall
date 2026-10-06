// Han position boundaries and optional worker-only dictionary ranking.
import { createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import { tokenizeSpans as lexicalSpans } from './sqlite-lexical.mjs';
const HAN = /^\p{Script=Han}+$/u;
const BOUNDARY = '\ue000'; // Position barrier after a Han run; not a dictionary word.
const baseSpans = text => lexicalSpans(text);
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

export function createHanRanking(enabled = !isMainThread) {
  if (typeof enabled !== 'boolean') throw new TypeError('jieba must be a boolean');
  let jieba;
  if (enabled) {
    if (isMainThread) throw new Error('jieba ranking is worker-only');
    const require = createRequire(import.meta.url);
    const { Jieba } = require('@node-rs/jieba');
    const { dict } = require('@node-rs/jieba/dict');
    jieba = Jieba.withDict(dict);
  }
  return {
    tokenizer, jieba: enabled,
    longWords(text) {
      const words = new Set();
      if (jieba) for (const [run] of text.matchAll(/\p{Script=Han}+/gu)) {
        for (const word of jieba.cutForSearch(run, true)) if (HAN.test(word) && Array.from(word).length >= 3) words.add(word);
      }
      return words;
    },
  };
}
