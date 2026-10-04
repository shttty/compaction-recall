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
      const { DatabaseSync } = require('node:sqlite');
      await (${check.toString()})(createInflections, assert, DatabaseSync);
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
    assert.equal(helper.expression(term), term);
  }
  assert.deepEqual(helper.expand('LEAVES'), ['leaves', 'leaf', 'leave']);
  assert.deepEqual(helper.expand('foo_bar'), ['foo_bar']);
  assert.equal(helper.stats.indexedWords, new Set([...terms, 'book']).size);
  assert.ok(helper.stats.lemmaLinks >= helper.stats.indexedWords);
  assert.ok(helper.stats.lemmaEntries > 0);
  assert.ok(Math.abs(helper.stats.buildMs - helper.stats.dependencyLoadMs - helper.stats.tableBuildMs) < 1e-9);
}));

test('only bare operands expand; native phrases, filters and malformed syntax remain native', () => inWorker((createInflections, assert, DatabaseSync) => {
  const helper = createInflections(['book', 'booked', 'books']);
  const group = '("book" OR "booked" OR "books")';
  assert.equal(helper.expression('book AND (book NOT book)'), `${group} AND (${group} NOT ${group})`);
  for (const query of ['"book"', '"book booked"', 'book*', '^book', '^book + booked',
    'book + booked', 'book-booked', '-book', '+book', 'NEAR(book booked, 2)',
    'tokens:book', 'tokens:(book OR (booked AND books))', '{tokens other}:(book OR booked)',
    '-tokens:(book OR booked)', '"tokens":(book OR booked)',
    'tokens:(other:(book OR booked) OR (book AND books))',
    '"book', '(book', 'book)', 'book +', 'book ^', 'book AND']) {
    const actual = helper.expression(query);
    if (query !== 'book AND') assert.equal(actual, query, query);
  }
  assert.equal(helper.expression('tokens:(book OR booked) OR book'), `tokens:(book OR booked) OR ${group}`);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE terms USING fts5(tokens)');
    const search = db.prepare('SELECT rowid FROM terms WHERE terms MATCH ?');
    for (const query of ['"book', '(book', 'book)', 'book +', 'book ^', 'book AND',
      'unknown:book', 'tokens:()', 'NEAR(book, nope)']) {
      assert.throws(() => search.all(query));
      assert.throws(() => search.all(helper.expression(query)), query);
    }
  } finally { db.close(); }
}));

test('native BM25 OR adds both inflections exactly without changing the index', () => inWorker((createInflections, assert, DatabaseSync) => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE terms USING fts5(tokens, tokenize='ascii')");
    const insert = db.prepare('INSERT INTO terms(tokens) VALUES (?)');
    for (const text of ['book booked', 'book padding', 'booked padding', ...Array(7).fill('other padding')]) insert.run(text);
    const helper = createInflections(['book', 'booked', 'padding', 'other']);
    const query = db.prepare('SELECT rowid, bm25(terms) AS score FROM terms WHERE terms MATCH ? ORDER BY score, rowid');
    const actual = query.all(helper.expression('book'));
    assert.deepEqual(actual, query.all('"book" OR "booked"'));
    assert.deepEqual(actual.map(row => row.rowid), [1, 2, 3]);
    assert.ok(Math.abs(actual[0].score - (-2.4475508632442313)) < 1e-12);
    const book = query.all('book').find(row => row.rowid === 1).score;
    const booked = query.all('booked').find(row => row.rowid === 1).score;
    assert.ok(Math.abs(actual[0].score - book - booked) < 1e-12);
    assert.deepEqual(query.all('book').map(row => row.rowid), [1, 2]);
    assert.deepEqual(query.all('booked').map(row => row.rowid), [1, 3]);
  } finally { db.close(); }
}));

test('worker engine expands automatic and raw search while off and native escapes stay exact', async () => {
  const docs = [{ id: 'base', text: 'book padding' }, { id: 'past', text: 'booked padding' },
    { id: 'both', text: 'book booked' }, ...Array.from({ length: 7 }, (_, i) => ({ id: `noise${i}`, text: 'other padding' }))];
  const enabled = await createEngine(docs, { arm: 'inflect-wink' });
  const off = await createEngine(docs, { arm: 'off' });
  const ids = rows => rows.map(row => row.id).sort();
  try {
    assert.deepEqual(ids(await enabled.searchAuto('book')), ['base', 'both', 'past']);
    const raw = await enabled.searchRaw('book');
    assert.deepEqual(ids(raw.results), ['base', 'both', 'past']);
    assert.ok(Math.abs(raw.results.find(row => row.id === 'both').score - (-2.4475508632442313)) < 1e-12);
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
