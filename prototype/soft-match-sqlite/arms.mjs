import { createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import { tokenize, tokenizeSpans } from './lexical.mjs';

const ARMS = new Set(['off', 'prefix-all', 'prefix-min4', 'jieba', 'porter', 'porter-js']);
const lexical = { tokenize, tokenizeSpans };
let jiebaTokenizer;

export function validateArm(arm) {
  if (!ARMS.has(arm)) throw new Error(`Invalid SQLite arm: ${String(arm)}; expected off, prefix-all, prefix-min4, jieba, porter, or porter-js`);
  return arm;
}

export function createTokenizer(arm = 'off') {
  validateArm(arm);
  if (arm !== 'jieba') return lexical;
  if (isMainThread) throw new Error('SQLite jieba arm is worker-only; create its index inside a worker thread');
  if (!jiebaTokenizer) {
    const require = createRequire(import.meta.url);
    const { Jieba } = require('@node-rs/jieba');
    const { dict } = require('@node-rs/jieba/dict');
    const jieba = Jieba.withDict(dict);
    const spans = text => tokenizeSpans(text, word => jieba.cutForSearch(word, true));
    jiebaTokenizer = { tokenize: text => spans(text).map(span => span.term), tokenizeSpans: spans };
  }
  return jiebaTokenizer;
}
