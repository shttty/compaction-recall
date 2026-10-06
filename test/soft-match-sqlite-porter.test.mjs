import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createIndex } from '../archive/prototype/soft-match-sqlite/index.mjs';
import { createStemmer } from '../archive/prototype/soft-match-sqlite/porter.mjs';

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

test('Porter concepts match existing stem atoms without adding query stemming', t => {
  const index = open(t);
  for (const [word, expected] of [['book', ['base', 'past', 'progress']], ['booked', ['past']], ['booking', ['progress']]]) {
    assert.deepEqual(ids(index.search({ concepts: [[word]] })), expected);
  }
  assert.deepEqual(ids(index.search({ concepts: [['booked', 'tickets']] })), ['past']);
  assert.deepEqual(ids(index.search({ concepts: [['booked'], ['tickets']], match: 'all' })), ['past']);
  assert.deepEqual(ids(index.search({ concepts: [['book']], exclude: ['tickets'] })), ['base', 'progress']);
  assert.deepEqual(ids(index.search({ concepts: [['booked', 'booking']] })), ['past', 'progress']);
  assert.deepEqual(ids(index.search({ concepts: [['booked tickets']] })), ['past']);
  assert.deepEqual(ids(index.search({ concepts: [['stems:book']] })), []);
  assert.throws(() => index.search('book'), { name: 'QueryError', code: 'INVALID_QUERY' });
});

test('Porter Han concepts use the unchanged token channel', t => {
  const index = open(t, [{ id: 'one', text: 'booking 预约' }]);
  assert.deepEqual(ids(index.search({ concepts: [['预约']] })), ['one']);
});

test('Porter stem hits anchor snippets at original inflected spans', t => {
  const index = open(t, [{ id: 'one', text: `${'unrelated '.repeat(80)}The booking is confirmed.${' unrelated'.repeat(80)}` }]);
  const row = index.queryRows({ concepts: [['book']] }).results[0];
  assert.match(row.snippet, /booking/);
  assert.equal(row.snippet.includes('booked'), false);
});

test('unqualified Porter atoms preserve native weighted BM25 scores', t => {
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
  const actual = new Map(index.search({ concepts: [['book']] }).results.map(row => [row.id, row.score]));
  for (const row of native.all('"book"')) assert.equal(actual.get(docs[row.rowid - 1].id), row.score);
  // Native BM25 saturates weighted term frequency once, rather than adding two
  // independently saturated token/stem scores for an unchanged alias.
  assert.notEqual(native.all('{tokens stems}:"book"')[0].score,
    native.all('(tokens:"book" OR stems:"book")')[0].score);
});

test('default keeps exact S5 recall without stemming or index stopword removal', t => {
  const index = createIndex(documents);
  t.after(() => index.close());
  assert.deepEqual(ids(index.search({ concepts: [['booked']] })), ['past']);
  assert.deepEqual(ids(index.search({ concepts: [['book']] })), ['base']);
  assert.deepEqual(ids(index.search({ concepts: [['the']] })), ['base', 'progress']);
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
  assert.deepEqual(ids(index.search({ concepts: [['foo_bar']] })), ['identifier', 'reverse', 'separate']);
});
