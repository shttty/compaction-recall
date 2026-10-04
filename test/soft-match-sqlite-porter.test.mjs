import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';
import { createStemmer } from '../prototype/soft-match-sqlite/porter.mjs';

const documents = [
  { id: 'past', text: 'Yesterday we booked tickets.' },
  { id: 'base', text: 'Read the book today.' },
  { id: 'progress', text: 'The booking opens tomorrow.' },
  { id: 'han', text: '预约 网关重启' },
];
const ids = result => result.results.map(row => row.id).sort();
function open(t, docs = documents, arm = 'porter') {
  const index = createIndex(docs, { arm });
  t.after(() => index.close());
  return index;
}

test('Porter recalls inflections, exact quotes and explicit native columns stay exact', t => {
  const index = open(t);
  for (const word of ['book', 'booked', 'booking']) {
    assert.deepEqual(ids(index.search(word)), ['base', 'past', 'progress']);
    assert.deepEqual(ids(index.searchRaw(word)), ['base', 'past', 'progress']);
    assert.deepEqual(index.missingTerms(word), []);
  }
  assert.deepEqual(ids(index.searchRaw('"booked"')), ['past']);
  assert.deepEqual(ids(index.searchRaw('tokens:booked')), ['past']);
  assert.deepEqual(ids(index.searchRaw('stems:book')), ['base', 'past', 'progress']);
  assert.deepEqual(ids(index.searchRaw('stems:booked')), []);
  assert.deepEqual(ids(index.searchRaw('"book"')), ['base']);
  assert.deepEqual(ids(index.searchRaw('booked tickets')), ['base', 'past', 'progress']);
  assert.deepEqual(ids(index.searchRaw('booked AND tickets')), ['past']);
  assert.deepEqual(ids(index.searchRaw('booked NOT tickets')), ['base', 'progress']);
  assert.deepEqual(ids(index.searchRaw('tokens:(booked OR booking)')), ['past', 'progress']);
  assert.deepEqual(ids(index.searchRaw('NEAR(booked tickets, 2)')), ['past']);
  assert.deepEqual(ids(index.searchRaw('"booked tickets"')), ['past']);
  assert.throws(() => index.searchRaw('unknown:book'), /no such column/);
  assert.throws(() => index.searchRaw('"book'), /unterminated|syntax/);
});

test('Porter excludes Han from the stem channel and resolves missing stem vocabulary', t => {
  const index = open(t, [{ id: 'one', text: 'booking 预约' }]);
  assert.deepEqual(ids(index.searchRaw('预约')), ['one']);
  assert.deepEqual(ids(index.searchRaw('tokens:预约')), ['one']);
  assert.deepEqual(ids(index.searchRaw('stems:预约')), []);
  assert.deepEqual(index.missingTerms('booked'), []);
  assert.deepEqual(index.missingTerms('"booked"'), ['booked']);
  assert.deepEqual(index.missingTerms('tokens:booked'), ['booked']);
  assert.deepEqual(index.missingTerms('stems:book'), []);
  assert.deepEqual(index.missingTerms('stems:预约'), ['预约']);
});

test('Porter stem hits anchor snippets at original inflected spans', t => {
  const index = open(t, [{ id: 'one', text: `${'unrelated '.repeat(80)}The booking is confirmed.${' unrelated'.repeat(80)}` }]);
  const row = index.queryRows('booked').results[0];
  assert.match(row.snippet, /booking/);
  assert.equal(row.snippet.includes('booked'), false);
});

test('Porter uses one weighted native phrase for identical aliases and additive phrases otherwise', t => {
  const docs = [
    { id: 'one', text: 'book book' },
    { id: 'two', text: 'booked padding' },
    { id: 'three', text: 'booking noise padding' },
  ];
  const index = open(t, docs);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE VIRTUAL TABLE terms USING fts5(tokens, stems, content='', columnsize=1, detail=full, tokenize="ascii tokenchars '_$'");`);
  const insert = db.prepare('INSERT INTO terms(rowid,tokens,stems) VALUES (?,?,?)');
  insert.run(1, 'book book', 'book book');
  insert.run(2, 'booked padding', 'book pad');
  insert.run(3, 'booking noise padding', 'book nois pad');
  const native = db.prepare('SELECT rowid, bm25(terms,1.0,0.5) AS score FROM terms WHERE terms MATCH ? ORDER BY score, rowid');
  for (const [query, expression] of [
    ['book', '{tokens stems}:"book"'],
    ['booked', '(tokens:"booked" OR stems:"book")'],
  ]) {
    const actual = new Map(index.searchRaw(query).results.map(row => [row.id, row.score]));
    for (const row of native.all(expression)) assert.equal(actual.get(docs[row.rowid - 1].id), row.score);
  }
  // Native BM25 saturates weighted term frequency once, rather than adding two
  // independently saturated token/stem scores for an unchanged alias.
  assert.notEqual(native.all('{tokens stems}:"book"')[0].score,
    native.all('(tokens:"book" OR stems:"book")')[0].score);
});

test('default keeps exact S5 recall without stemming or index stopword removal', t => {
  const index = createIndex(documents);
  t.after(() => index.close());
  assert.deepEqual(ids(index.search('booked')), ['past']);
  assert.deepEqual(ids(index.searchRaw('book')), ['base']);
  assert.deepEqual(ids(index.searchRaw('the')), ['base', 'progress']);
  assert.deepEqual(index.missingTerms('books'), ['books']);
  assert.throws(() => createIndex(documents, { arm: 'unknown' }), /Invalid SQLite arm/);
});

test('Porter preserves native ascii identifier token order and duplicate occurrences', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const stem = createStemmer(db);
  assert.equal(stem('foo_bar'), 'foo bar');
  assert.equal(stem('booked$booking'), 'book book');
  assert.equal(stem('foo_foo'), 'foo foo');
  assert.equal(stem('预约'), undefined);
  const index = open(t, [
    { id: 'identifier', text: 'foo_bar booked$booking' },
    { id: 'separate', text: 'foo bar book book' },
    { id: 'reverse', text: 'bar foo book' },
  ]);
  assert.deepEqual(ids(index.searchRaw('foo_bar')), ['identifier', 'separate']);
  assert.deepEqual(ids(index.searchRaw('"foo_bar"')), ['identifier']);
  assert.deepEqual(ids(index.searchRaw('stems:"foo bar"')), ['identifier', 'separate']);
  assert.deepEqual(index.missingTerms('foo_bar'), []);
  const separate = open(t, [{ id: 'separate', text: 'foo bar' }]);
  assert.deepEqual(separate.missingTerms('foo_bar'), []);
  assert.deepEqual(separate.missingTerms('foo_missing'), ['foo_missing']);
});
