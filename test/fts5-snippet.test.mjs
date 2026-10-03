import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fts5Snippet, selectFts5Window } from '../benchmark/fts5-snippet.mjs';

// Equal-width ASCII words make three-token SQLite windows correspond exactly
// to eleven-codepoint windows for these odd-width match clusters. This is not
// a tokenizer for the production selector; all production hits are supplied.
const sqliteCases = [
  ['first token', 'red aaa bbb ccc ddd', ['red'], 0, 'red aaa bbb…'],
  ['first sentence bonus', 'aaa red bbb ccc ddd', ['red'], 0, 'aaa red bbb…'],
  ['interior centered match', 'aaa bbb ccc red ddd eee fff', ['red'], 8, '…ccc red ddd…'],
  ['document end clamp', 'aaa bbb ccc ddd eee red fff', ['red'], 16, '…eee red fff'],
  ['distinct terms beat opening match', 'red aaa bbb ccc fox red fox ddd eee', ['red', 'fox'], 16, '…fox red fox…'],
  ['repeated term cluster', 'aaa bbb ccc red aaa red ddd eee', ['red'], 12, '…red aaa red…'],
];
for (const [name, text, terms, start, expected] of sqliteCases) {
  test(`real SQLite snippet parity: ${name}`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE docs USING fts5(body, tokenize="ascii")');
      db.prepare('INSERT INTO docs(body) VALUES (?)').run(text);
      const row = db.prepare("SELECT snippet(docs, 0, '', '', '…', 3) AS excerpt FROM docs WHERE docs MATCH ?")
        .get(terms.join(' OR '));
      assert.equal(row.excerpt, expected);
      const hits = [...text.matchAll(/[a-z]+/g)]
        .filter(match => terms.includes(match[0]))
        .map(match => ({ term: match[0], start: match.index, end: match.index + match[0].length }));
      const selected = selectFts5Window(text, hits, 11);
      assert.equal(selected.start, start);
      assert.equal(selected.snippet, expected);
      assert.equal(selected.snippet, row.excerpt);
    } finally {
      db.close();
    }
  });
}

test('real SQLite variable-length words demonstrate the declared token/codepoint difference', () => {
  const text = 'alpha bicycle extraordinarilylongidentifier gamma delta theta omega';
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE docs USING fts5(body, tokenize="ascii")');
    db.prepare('INSERT INTO docs(body) VALUES (?)').run(text);
    const row = db.prepare("SELECT snippet(docs,0,'','','…',3) AS excerpt FROM docs WHERE docs MATCH ?").get('gamma');
    assert.equal(row.excerpt, '…extraordinarilylongidentifier gamma delta…');
    const start = text.indexOf('gamma');
    const selected = selectFts5Window(text, [{ term: 'gamma', start, end: start + 5 }], 14);
    assert.equal(selected.end - selected.start, 14);
    assert.ok(selected.snippet.includes('gamma'));
    assert.notEqual(selected.snippet, row.excerpt);
  } finally { db.close(); }
});

test('Chinese sentence bonus keeps the answer start without requiring spaces', () => {
  const text = '甲甲甲甲甲甲甲甲。网关重启完成。乙乙乙乙乙乙';
  assert.deepEqual(selectFts5Window(text, [
    { term: '网关', start: 9, end: 11 }, { term: '重启', start: 11, end: 13 },
  ], 8), { start: 9, end: 17, score: 2100, snippet: '…网关重启完成。乙…' });
});

test('overlapping caller bigrams retain distinct query identity', () => {
  const selected = selectFts5Window('零零零零零搜索引擎末末末末末', [
    { term: '搜索', start: 5, end: 7 },
    { term: '索引', start: 6, end: 8 },
    { term: '引擎', start: 7, end: 9 },
  ], 6);
  assert.deepEqual(selected, { start: 4, end: 10, score: 3000, snippet: '…零搜索引擎末…' });
});

test('codepoint slicing does not split astral characters and ellipses require cuts', () => {
  assert.deepEqual(selectFts5Window('😀𠀀𠀁甲乙', [{ term: '𠀀𠀁', start: 1, end: 3 }], 3),
    { start: 0, end: 3, score: 1120, snippet: '😀𠀀𠀁…' });
  assert.equal(fts5Snippet('😀𠀀𠀁', [{ term: '𠀁', start: 2, end: 3 }]), '😀𠀀𠀁');
  assert.deepEqual(selectFts5Window('', []), { start: 0, end: 0, score: 0, snippet: '' });
  assert.deepEqual(selectFts5Window('abcdef', [], 3), { start: 0, end: 3, score: 0, snippet: 'abc…' });
});

test('adjustment retains the original forward score even when it excludes a scored hit', () => {
  const result = selectFts5Window('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', [
    { term: 'long', start: 10, end: 21 },
  ], 4);
  // (4 - 11) / 2 truncates to -3, not -4. The scored start is now outside.
  assert.deepEqual(result, { start: 13, end: 17, score: 1000, snippet: '…xxxx…' });
});

test('end-exclusive forward bounds and first-wins ties follow position order', () => {
  const text = 'x'.repeat(40);
  const hits = [{ term: 'b', start: 14, end: 15 }, { term: 'a', start: 10, end: 11 }];
  assert.deepEqual(selectFts5Window(text, hits, 4),
    { start: 9, end: 13, score: 1000, snippet: '…xxxx…' });
  assert.equal(hits[0].term, 'b', 'sorting must not mutate caller hits');
});

test('last instance extent follows SQLite rather than maximum overlapping end', () => {
  const selected = selectFts5Window('x'.repeat(40), [
    { term: 'wide', start: 10, end: 25 }, { term: 'narrow', start: 11, end: 12 },
  ], 6);
  assert.equal(selected.start, 8);
  assert.equal(selected.score, 2000);
});

test('every sentence is considered even with a hit exactly at its start', () => {
  const result = selectFts5Window('xxxxx。答案甲乙丙丁', [{ term: '答案', start: 6, end: 8 }], 4);
  assert.deepEqual(result, { start: 6, end: 10, score: 1100, snippet: '…答案甲乙…' });
});

test('sentence punctuation, closing quotes and line breaks are deterministic', () => {
  for (const prefix of ['xxxxx. ', 'xxxxx: ', 'xxxxx! ', 'xxxxx? ', 'xxxxx。', 'xxxxx！', 'xxxxx？', 'xxxxx：', 'xxxxx\n', 'xxxxx\r\n', 'xxxxx。” ', 'xxxxx!" ']) {
    const start = Array.from(prefix).length;
    const result = selectFts5Window(`${prefix}答案甲乙丙丁`, [{ term: '答案', start, end: start + 2 }], 4);
    assert.equal(result.start, start, JSON.stringify(prefix));
    assert.equal(result.score, 1100, JSON.stringify(prefix));
  }
  assert.equal(selectFts5Window('xxxxx!答案甲乙丙丁', [{ term: '答案', start: 6, end: 8 }], 4).start, 5);
});

test('empty sentences do not beat no-hit fallback and first sentence earns 120', () => {
  assert.deepEqual(selectFts5Window('甲。乙。丙。丁。', [], 2),
    { start: 0, end: 2, score: 0, snippet: '甲。…' });
  assert.equal(selectFts5Window('答案甲乙。答案丙丁', [
    { term: '答案', start: 0, end: 2 }, { term: '答案', start: 5, end: 7 },
  ], 4).score, 1120);
});

test('invalid budgets and caller ranges fail explicitly', () => {
  for (const budget of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => selectFts5Window('abc', [], budget), RangeError);
  }
  for (const [start, end] of [[-1, 1], [1, 1], [2, 4], [0.5, 1], [0, NaN]]) {
    assert.throws(() => selectFts5Window('abc', [{ term: 'a', start, end }]), RangeError);
  }
});
