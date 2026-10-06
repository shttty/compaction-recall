import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { createTokenizer, validateArm } from '../archive/prototype/soft-match-sqlite/arms.mjs';
import { tokenize, tokenizeSpans } from '../archive/prototype/soft-match-sqlite/lexical.mjs';

const require = createRequire(import.meta.url);
const nativeModules = () => Object.keys(require.cache).filter(path => path.includes('/@node-rs/jieba'));

test('non-jieba arms preserve lexical behavior and main-thread jieba never loads native modules', () => {
  assert.deepEqual(nativeModules(), []);
  const text = '🙂南京市 getUser HTTPServer foo_bar $x $_ 𠀀𠀁';
  for (const arm of ['off', 'prefix-all', 'prefix-min4', 'porter']) {
    const tokenizer = createTokenizer(arm);
    assert.deepEqual(tokenizer.tokenize(text), tokenize(text));
    assert.deepEqual(tokenizer.tokenizeSpans(text), tokenizeSpans(text));
  }
  assert.throws(() => createTokenizer('jieba'), /worker-only/);
  assert.deepEqual(nativeModules(), []);
  for (const arm of ['jieba,porter', 'prefix-all+porter', '', 'unknown', null, ['off']]) {
    assert.throws(() => validateArm(arm), /Invalid SQLite arm/);
    assert.throws(() => createTokenizer(arm), /Invalid SQLite arm/);
  }
});

test('Han callback locates overlapping repeated words with codepoint spans and unchanged bigrams', () => {
  const seen = [];
  const spans = tokenizeSpans('🙂𠀀𠀀𠀀𠀀 getUser 南京市', word => {
    seen.push(word);
    return word.startsWith('𠀀') ? ['𠀀𠀀𠀀', '𠀀𠀀𠀀', '𠀀𠀀', 'getUser', '南京市'] : ['南京市'];
  });
  assert.deepEqual(seen, ['𠀀𠀀𠀀𠀀', '南京市']);
  assert.deepEqual(spans.filter(span => span.start < 5), [
    { term: '𠀀𠀀', start: 1, end: 3 },
    { term: '𠀀𠀀𠀀', start: 1, end: 4 },
    { term: '𠀀𠀀', start: 2, end: 4 },
    { term: '𠀀𠀀𠀀', start: 2, end: 5 },
    { term: '𠀀𠀀', start: 3, end: 5 },
  ]);
  assert.deepEqual(spans.filter(span => /^[a-z]+$/.test(span.term)).map(span => span.term), tokenize('getUser'));
});

test('native Jieba search segmentation is lazy, cached once per worker, and preserves exact spans', async () => {
  const moduleUrl = new URL('../archive/prototype/soft-match-sqlite/arms.mjs', import.meta.url).href;
  const worker = new Worker(`
    const assert = require('node:assert/strict');
    const { parentPort } = require('node:worker_threads');
    (async () => {
      const { createTokenizer } = await import(${JSON.stringify(moduleUrl)});
      createTokenizer('off');
      assert.equal(Object.keys(require.cache).some(path => path.includes('/@node-rs/jieba')), false);
      const tokenizer = createTokenizer('jieba');
      assert.equal(createTokenizer('jieba'), tokenizer);
      const text = '🙂南京市南京市 𠀀𠀁𠀂 getUser foo_bar';
      const spans = tokenizer.tokenizeSpans(text);
      assert.deepEqual(tokenizer.tokenize(text), spans.map(span => span.term));
      for (const span of spans) {
        assert.equal(Array.from(text).slice(span.start, span.end).join('').toLowerCase(), span.term);
      }
      const overlaps = tokenizer.tokenizeSpans('哈哈哈哈');
      assert.deepEqual(overlaps.filter(span => span.term === '哈哈哈'), [
        { term: '哈哈哈', start: 0, end: 3 }, { term: '哈哈哈', start: 1, end: 4 },
      ]);
      assert.equal(new Set(overlaps.map(span => JSON.stringify(span))).size, overlaps.length);
      parentPort.postMessage(spans);
    })().catch(error => { throw error; });
  `, { eval: true, execArgv: [] });
  try {
    const spans = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error('Jieba worker exited before its result: ' + code)));
    });
    assert.deepEqual(spans, [
      { term: '南京', start: 1, end: 3 },
      { term: '南京市', start: 1, end: 4 },
      { term: '京市', start: 2, end: 4 },
      { term: '市南', start: 3, end: 5 },
      { term: '南京', start: 4, end: 6 },
      { term: '南京市', start: 4, end: 7 },
      { term: '京市', start: 5, end: 7 },
      { term: '𠀀𠀁', start: 8, end: 10 },
      { term: '𠀀𠀁𠀂', start: 8, end: 11 },
      { term: '𠀁𠀂', start: 9, end: 11 },
      { term: 'get', start: 12, end: 15 },
      { term: 'user', start: 15, end: 19 },
      { term: 'foo', start: 20, end: 23 },
      { term: 'bar', start: 24, end: 27 },
    ]);
    assert.deepEqual(nativeModules(), []);
  } finally {
    await worker.terminate();
  }
});
