import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { createInflections } from '../prototype/soft-match-sqlite/inflect.mjs';
import { createEngine } from '../benchmark/retrieval-sqlite-engine.mjs';

const require = createRequire(import.meta.url);
const helperUrl = new URL('../prototype/soft-match-sqlite/inflect.mjs', import.meta.url).href;
async function inWorker(check) {
  const worker = new Worker(`
    const assert = require('node:assert/strict');
    const { parentPort } = require('node:worker_threads');
    (async () => {
      const { createInflections } = await import(${JSON.stringify(helperUrl)});
      await (${check.toString()})(createInflections, assert);
      parentPort.postMessage('ok');
    })().catch(error => { throw error; });
  `, { eval: true, execArgv: [] });
  try {
    assert.equal(await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`Inflection worker exited without result: ${code}`)));
    }), 'ok');
  } finally { await worker.terminate(); }
}

test('inflections reject main-thread initialization without loading wink', () => {
  const loaded = () => Object.keys(require.cache).some(path => path.includes('/wink-lemmatizer/'));
  assert.equal(loaded(), false);
  assert.throws(() => createInflections(['book']), /worker-only/);
  assert.equal(loaded(), false);
});

test('wink unions irregular noun verb and adjective lemmas without derivational stemming', () => inWorker((createInflections, assert) => {
  const pairs = [['sold', 'sell'], ['led', 'lead'], ['went', 'go'], ['spent', 'spend'],
    ['children', 'child'], ['attended', 'attend'], ['pieces', 'piece'], ['better', 'good']];
  const terms = [...pairs.flat(), 'leaf', 'leave', 'leaves', 'attended', 'totally', 'theater'];
  const helper = createInflections([...terms, 'BOOK', 'book', 'foo_bar', 'abc2', '$abc', '你好']);
  for (const [inflected, base] of pairs) {
    assert.ok(helper.expand(inflected).includes(base), `${inflected} -> ${base}`);
    assert.ok(helper.expand(base).includes(inflected), `${base} -> ${inflected}`);
  }
  for (const term of ['attendance', 'totally', 'theater']) {
    assert.deepEqual(helper.expand(term), [term]);
  }
  assert.deepEqual(helper.expand('LEAVES'), ['leaves', 'leaf', 'leave']);
  assert.deepEqual(helper.expand('foo_bar'), ['foo_bar']);
  assert.equal(helper.stats.indexedWords, new Set([...terms, 'book']).size);
  assert.ok(helper.stats.lemmaLinks >= helper.stats.indexedWords);
  assert.ok(helper.stats.lemmaEntries > 0);
  assert.ok(Math.abs(helper.stats.buildMs - helper.stats.dependencyLoadMs - helper.stats.tableBuildMs) < 1e-9);
}));



test('worker engine expands automatic recall while manual search and errors stay native', async () => {
  const docs = [{ id: 'base', text: 'book padding' }, { id: 'past', text: 'booked padding' },
    { id: 'both', text: 'book booked' }, ...Array.from({ length: 7 }, (_, i) => ({ id: `noise${i}`, text: 'other padding' }))];
  const enabled = await createEngine(docs, { arm: 'inflect-wink' });
  const off = await createEngine(docs, { arm: 'off' });
  const ids = rows => rows.map(row => row.id).sort();
  try {
    assert.deepEqual(ids(await enabled.searchAuto('book')), ['base', 'both', 'past']);
    const raw = await enabled.searchRaw('book');
    assert.deepEqual(ids(raw.results), ['base', 'both']);
    for (const query of ['"book"', 'tokens:(book)', 'tokens:((book))', '^book']) {
      assert.deepEqual(ids((await enabled.searchRaw(query)).results), ['base', 'both']);
    }
    assert.deepEqual(ids(await off.searchAuto('book')), ['base', 'both']);
    assert.deepEqual(ids((await off.searchRaw('book')).results), ['base', 'both']);
    assert.equal(Object.keys(require.cache).some(path => path.includes('/wink-lemmatizer/')), false);
    await assert.rejects(enabled.searchRaw('"book'));
    await assert.rejects(enabled.searchRaw('unknown:book'));
  } finally {
    await enabled.dispose();
    await off.dispose();
  }
});
