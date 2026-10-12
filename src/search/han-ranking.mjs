// Bigram position boundaries and optional worker-only long-word ranking (jieba-wasm, else Intl.Segmenter).
import { createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import { BIGRAM_TERM, tokenizeSpans as lexicalSpans } from './sqlite-lexical.mjs';
const HAN = /^\p{Script=Han}+$/u;
const BOUNDARY = '\ue000'; // Position barrier after a Han/kana run; not a dictionary word.
const baseSpans = text => lexicalSpans(text);
const tokenizer = {
  tokenizeSpans: baseSpans,
  tokenize(text) {
    const spans = baseSpans(text), tokens = [];
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i], next = spans[i + 1];
      tokens.push(span.term);
      if (BIGRAM_TERM.test(span.term) && (!next || !BIGRAM_TERM.test(next.term) || next.start !== span.start + 1)) tokens.push(BOUNDARY);
    }
    return tokens;
  },
};
const firstLine = error => String(error?.message ?? error).split('\n')[0];
let cutter; // Loaded once per worker.

function requireWasm(require) {
  try { return require('jieba-wasm'); } catch (bare) {
    // Compiled OMP extension hosts ignore package.json main/exports for bare names and jieba-wasm has no root
    // index.js; its explicit Node entry resolves there, while Node itself rejects that unexported path.
    try { return require('jieba-wasm/pkg/nodejs/jieba_rs_wasm.js'); } catch (path) {
      throw new Error(`${firstLine(bare)}; ${firstLine(path)}`);
    }
  }
}

function loadCutter() {
  try {
    const wasm = requireWasm(createRequire(import.meta.url));
    wasm.cut_for_search('分词', true); // Load the dictionary here so its failures also fall back.
    return run => wasm.cut_for_search(run, true);
  } catch (error) {
    process.stderr.write(`compaction-recall: jieba unavailable (${firstLine(error)}); ranking long Chinese words with Intl.Segmenter\n`);
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    return run => Array.from(segmenter.segment(run), part => part.segment);
  }
}

export function createHanRanking(enabled = !isMainThread) {
  if (typeof enabled !== 'boolean') throw new TypeError('jieba must be a boolean');
  if (enabled && isMainThread) throw new Error('jieba ranking is worker-only');
  if (enabled) cutter ??= loadCutter();
  const cut = enabled ? cutter : undefined;
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
