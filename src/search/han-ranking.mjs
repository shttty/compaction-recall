// Han position boundaries and optional worker-only long-word ranking (jieba, else Intl.Segmenter).
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
  let cut;
  if (enabled) {
    if (isMainThread) throw new Error('jieba ranking is worker-only');
    try {
      const require = createRequire(import.meta.url);
      const { Jieba } = require('@node-rs/jieba');
      const { dict } = require('@node-rs/jieba/dict');
      const jieba = Jieba.withDict(dict);
      cut = run => jieba.cutForSearch(run, true);
    } catch (error) {
      // Some hosts (e.g. compiled OMP extension workers) cannot resolve the native binding package.
      process.stderr.write(`compaction-recall: jieba unavailable (${String(error?.message ?? error).split('\n')[0]}); ranking long Chinese words with Intl.Segmenter\n`);
      const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
      cut = run => Array.from(segmenter.segment(run), part => part.segment);
    }
  }
  return {
    tokenizer, longWordRanking: enabled,
    longWords(text) {
      const words = new Set();
      if (cut) for (const [run] of text.matchAll(/\p{Script=Han}+/gu)) {
        for (const word of cut(run)) if (HAN.test(word) && Array.from(word).length >= 3) words.add(word);
      }
      return words;
    },
  };
}
