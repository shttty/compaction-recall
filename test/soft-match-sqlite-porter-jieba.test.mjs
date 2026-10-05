import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createTokenizer, validateArm } from '../prototype/soft-match-sqlite/arms.mjs';

const armsURL = new URL('../prototype/soft-match-sqlite/arms.mjs', import.meta.url).href;
const indexURL = new URL('../prototype/soft-match-sqlite/index.mjs', import.meta.url).href;

// Native Jieba stays in the worker even when exercising the synchronous index.
test('porter-jieba reuses both token channels for English, Han and mixed queries', async () => {
  const worker = new Worker(`
    const assert = require('node:assert/strict');
    const { parentPort } = require('node:worker_threads');
    (async () => {
      const { createTokenizer } = await import(${JSON.stringify(armsURL)});
      const { createIndex } = await import(${JSON.stringify(indexURL)});
      const tokenizer = createTokenizer('porter-jieba');
      assert.equal(tokenizer, createTokenizer('jieba'));
      assert.deepEqual(tokenizer.tokenize('booked booking'), ['booked', 'booking']);
      assert.deepEqual(tokenizer.tokenize('南京市'), ['南京', '南京市', '京市']);
      const mixed = '🙂booked 南京市 booking';
      assert.deepEqual(tokenizer.tokenize(mixed), ['booked', '南京', '南京市', '京市', 'booking']);
      for (const span of tokenizer.tokenizeSpans(mixed)) {
        assert.equal(Array.from(mixed).slice(span.start, span.end).join('').toLowerCase(), span.term);
      }
      const english = [{ id: 'past', text: 'booked tickets rowpast' },
        { id: 'present', text: 'booking tickets rowpresent' }, { id: 'base', text: 'book ticket rowbase' }];
      const porter = createIndex(english, { arm: 'porter' });
      const combo = createIndex(english, { arm: 'porter-jieba' });
      const han = createIndex([{ id: 'city', text: '南京市' }, { id: 'split', text: '南京，京市' }], { arm: 'porter-jieba' });
      const mixedIndex = createIndex([{ id: 'both', text: 'booking 南京市' },
        { id: 'english', text: 'booked tickets' }, { id: 'han', text: '南京市' }], { arm: 'porter-jieba' });
      const ids = found => found.results.map(row => row.id).sort();
      try {
        for (const query of ['book', 'booked', 'booking', 'tickets']) {
          assert.deepEqual(combo.search(query), porter.search(query));
          assert.deepEqual(combo.searchRaw(query), porter.searchRaw(query));
        }
        assert.deepEqual(ids(combo.searchRaw('stems:book')), ['base', 'past', 'present']);
        assert.deepEqual(ids(combo.searchRaw('stems:ticket')), ['base', 'past', 'present']);
        assert.deepEqual(ids(combo.searchRaw('stems:booking')), []);
        assert.deepEqual(ids(combo.searchRaw('"booked"')), ['past']);
        assert.deepEqual(ids(han.searchRaw('"南京 京市"')), ['city']);
        assert.deepEqual(ids(han.searchRaw('南京')), ['city', 'split']);
        assert.deepEqual(ids(han.searchRaw('京市')), ['city', 'split']);
        assert.deepEqual(ids(han.searchRaw('stems:南京市')), []);
        assert.deepEqual(han.search('南京市', { automatic: true }).queryTerms, ['南京', '南京市', '京市']);
        assert.deepEqual(ids(mixedIndex.search('booked 南京市', { automatic: true })), ['both', 'english', 'han']);
        assert.deepEqual(ids(mixedIndex.searchRaw('stems:book AND "南京 京市"')), ['both']);
        const row = mixedIndex.queryRows('stems:book AND "南京 京市"').results[0];
        assert.equal(row.snippet, 'booking 南京市');
      } finally { porter.close(); combo.close(); han.close(); mixedIndex.close(); }
      parentPort.postMessage('passed');
    })().catch(error => { throw error; });
  `, { eval: true, execArgv: [] });
  try {
    assert.equal(await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error('Combination worker exited before result: ' + code)));
    }), 'passed');
  } finally { await worker.terminate(); }
});

test('porter-jieba remains a mutually exclusive, worker-only opt-in', () => {
  assert.equal(validateArm('porter-jieba'), 'porter-jieba');
  assert.throws(() => createTokenizer('porter-jieba'), /worker-only/);
  for (const arm of ['porter,jieba', 'porter+jieba', ['porter', 'jieba']]) {
    assert.throws(() => validateArm(arm), /Invalid SQLite arm/);
  }
});
