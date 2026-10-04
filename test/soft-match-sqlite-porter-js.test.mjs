import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStemmer } from '../prototype/soft-match-sqlite/porter.mjs';
import { createJsStemmer } from '../prototype/soft-match-sqlite/porter-js.mjs';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';

test('JS Porter agrees with native porter ascii on inflections and identifier segmentation', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const native = createStemmer(db), js = createJsStemmer();
  for (const word of ['booked', 'booking', 'book', 'attended', 'attending', 'workshops', 'played', 'assembled',
    'acquired', 'hours', 'months', 'leading', 'sold', 'foo_bar', 'booked$booking', 'foo_foo', '2023', '预约']) {
    assert.equal(js(word), native(word), word);
  }
  assert.equal(js('played'), 'plai');
});

test('JS Porter shares native Porter query semantics and keeps Han outside stems', t => {
  const docs = [{ id: 'past', text: 'booked tickets 预约' }, { id: 'base', text: 'book padding' }, { id: 'next', text: 'booking noise' }];
  const js = createIndex(docs, { arm: 'porter-js' }), native = createIndex(docs, { arm: 'porter' });
  t.after(() => { js.close(); native.close(); });
  for (const query of ['booked', 'book', 'booking', 'booked AND tickets', 'booked NOT tickets',
    '"booked"', 'tokens:booked', 'stems:book', 'stems:预约', 'NEAR(booked tickets, 2)', '"booked tickets"']) {
    assert.deepEqual(js.searchRaw(query).results.map(r => r.id).sort(), native.searchRaw(query).results.map(r => r.id).sort(), query);
    assert.deepEqual(js.missingTerms(query), native.missingTerms(query), query);
  }
  assert.deepEqual(js.searchRaw('stems:预约').results, []);
});

test('JS Porter applies native BM25 column weights 1/1 rather than the old 1/0.5', t => {
  const docs = [{ id: 'a', text: 'book book' }, { id: 'b', text: 'booked padding' }, { id: 'c', text: 'booking noise padding' }];
  const js = createIndex(docs, { arm: 'porter-js' }); t.after(() => js.close());
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE VIRTUAL TABLE terms USING fts5(tokens,stems,content='',columnsize=1,detail=full,tokenize="ascii tokenchars '_$'");`);
  const insert = db.prepare('INSERT INTO terms(rowid,tokens,stems) VALUES (?,?,?)');
  insert.run(1, 'book book', 'book book'); insert.run(2, 'booked padding', 'book pad'); insert.run(3, 'booking noise padding', 'book nois pad');
  const native = db.prepare('SELECT rowid,bm25(terms,1.0,1.0) AS score FROM terms WHERE terms MATCH ?');
  for (const [query, expression] of [['book', '{tokens stems}:"book"'], ['booked', '(tokens:"booked" OR stems:"book")']]) {
    const actual = new Map(js.searchRaw(query).results.map(r => [r.id, r.score]));
    for (const row of native.all(expression)) assert.equal(actual.get(docs[row.rowid - 1].id), row.score);
  }
});
