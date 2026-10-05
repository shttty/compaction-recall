import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex, tokenize } from '../prototype/soft-match-sqlite/index.mjs';
import { STOPWORDS, tokenizeSpans } from '../prototype/soft-match-sqlite/lexical.mjs';
import { createWorkerEngine } from '../benchmark/retrieval-sqlite-worker.mjs';
import { displayRows, sqliteRecallPage } from '../benchmark/retrieval-sqlite-page.mjs';
import { BackgroundIndex } from '../src/background-index.mjs';
import { initialBranch, msg } from './corpus.mjs';

const ids = found => found.results.map(row => row.id);
const doc = (id, text, sourcePosition) => ({ id, text, sourcePosition, date: '2026-10-04', role: 'user' });
function corpus(t, documents) {
  const index = createIndex(documents);
  const worker = createWorkerEngine();
  worker.commit(documents.map((document, i) => ({
    type: 'message', id: document.id, sourcePosition: document.sourcePosition ?? i,
    timestamp: `${document.date ?? '2026-10-04'}T12:00:00.000Z`,
    message: { role: document.role ?? 'user', content: document.text },
  })), { eligibleCount: Math.max(documents.length, ...documents.map(d => (d.sourcePosition ?? 0) + 1)) });
  t.after(() => { worker.dispose(); index.close(); });
  return { index, worker };
}

test('identifier component spans align with the original codepoint ranges', () => {
  assert.deepEqual(tokenize('getUser HTTPServer foo_bar $x $_ $getUser foo$bar'),
    ['get', 'user', 'http', 'server', 'foo', 'bar', 'get', 'user', 'foo', 'bar']);
  const text = '🙂 getUser HTTPServer foo_bar $x $_ 𠀀𠀁';
  for (const span of tokenizeSpans(text)) {
    assert.equal(Array.from(text).slice(span.start, span.end).join('').toLowerCase(), span.term);
  }
});

test('identifier components retrieve their original documents through sync and worker queries', t => {
  const { index, worker } = corpus(t, [
    doc('camel', 'getUser', 0), doc('acronym', 'HTTPServer', 1),
    doc('snake', 'foo_bar', 2), doc('dollar', '$x $_', 3),
  ]);
  for (const [query, expected] of [['user', 'camel'], ['http', 'acronym'], ['server', 'acronym'],
  ['foo', 'snake'], ['bar', 'snake']]) {
    assert.deepEqual(ids(index.search(query, { automatic: true })), [expected], query);
    assert.deepEqual(ids(worker.query(query, { mode: 'auto' })), [expected], query);
  }
  for (const query of ['x', '2', 's', '$x', '$_']) {
    assert.deepEqual(ids(index.search(query, { automatic: true })), []);
    assert.deepEqual(ids(worker.query(query, { mode: 'auto' })), []);
  }
});

test('Chinese stopwords remain indexed as bigrams while automatic selection filters stopwords', t => {
  const { index, worker } = corpus(t, [doc('stop', '我们 为什么', 0)]);
  for (const query of ['我们', '为什么']) {
    assert.ok(STOPWORDS.has(query));
    assert.deepEqual(ids(index.search({ concepts: [[query]] })), ['stop']);
    assert.deepEqual(ids(worker.query({ concepts: [[query]] }, { mode: 'manual' })), ['stop']);
    const auto = index.search(query, { automatic: true });
    assert.ok(!auto.queryTerms.includes(query));
    if (query === '我们') {
      assert.deepEqual(auto.results, []);
      assert.deepEqual(worker.query(query, { mode: 'auto' }).results, []);
    }
  }
});

test('latest duplicate ids replace earlier text, and latest empty text shadows an older hit', t => {
  const { index, worker } = corpus(t, [doc('same', 'obsolete', 0), doc('gone', 'obsolete', 1),
  doc('same', 'replacement', 2), doc('gone', '', 3)]);
  for (const query of ['obsolete', 'replacement']) {
    const expected = query === 'replacement' ? ['same'] : [];
    assert.deepEqual(ids(index.search({ concepts: [[query]] })), expected);
    assert.deepEqual(ids(worker.query({ concepts: [[query]] }, { mode: 'manual' })), expected);
  }
});

test('normalized content duplicates retain score/time representatives before total, limit and pagination', t => {
  const { index, worker } = corpus(t, [doc('a-old', 'aurora red', 0), doc('unique', 'aurora blue', 1),
  doc('z-new', 'aurora  red', 2)]);
  const found = worker.query({ concepts: [['aurora']] }, { mode: 'manual' });
  assert.equal(found.total, 2);
  assert.deepEqual(ids(found), ['z-new', 'unique']);
  const limited = index.search({ concepts: [['aurora']] }, { limit: 1 });
  assert.equal(limited.total, 2);
  assert.deepEqual(ids(limited), ['z-new']);
  assert.equal(index.search('aurora', { automatic: true, limit: 1 }).total, 2);
  const page = sqliteRecallPage(found.results, { limit: 1 });
  assert.equal(page.details.total, 2);
  assert.equal(page.details.nextOffset, 1);
  const next = sqliteRecallPage(found.results, { limit: 1, offset: page.details.nextOffset });
  assert.equal(next.details.returned, 1);
  assert.equal(next.details.nextOffset, null);
  assert.ok(next.text.includes('unique'));
});

test('different full messages survive even when their query snippets coincide', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const documents = [doc('older', 'needle '.repeat(100), 0), doc('newer', 'needle '.repeat(25), 1)];
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE VIRTUAL TABLE terms USING fts5(tokens, content='', columnsize=1, detail=full, tokenize=\"ascii tokenchars '_$'\")");
  const insert = db.prepare('INSERT INTO terms(rowid,tokens) VALUES (?,?)');
  documents.forEach((d, i) => insert.run(i + 1, tokenize(d.text).join(' ')));
  const scores = db.prepare('SELECT rowid,bm25(terms) AS score FROM terms WHERE terms MATCH ? ORDER BY rowid').all('needle');
  assert.ok(scores[0].score < scores[1].score, 'older native score must be better');
  const { index, worker } = corpus(t, documents);
  const found = index.search({ concepts: [['needle']] });
  assert.equal(found.total, 2);
  assert.deepEqual(ids(found), ['older', 'newer']);
  assert.equal(found.results[0].score, scores[0].score);
  assert.deepEqual(ids(worker.query({ concepts: [['needle']] }, { mode: 'manual' })), ['older', 'newer']);
});

test('exact native score ties prefer source recency rather than lexicographic id', t => {
  const { index, worker } = corpus(t, [doc('a-old', 'aurora red', 0), doc('z-new', 'aurora blue', 1)]);
  const found = index.search({ concepts: [['aurora']] });
  assert.equal(found.results[0].score, found.results[1].score, 'fixture must exercise an exact BM25 tie');
  assert.deepEqual(ids(found), ['z-new', 'a-old']);
  assert.deepEqual(ids(worker.query({ concepts: [['aurora']] }, { mode: 'manual' })), ['z-new', 'a-old']);
});

test('exact BM25 ties use source time rather than distinct-term count', t => {
  const { index, worker } = corpus(t, [
    doc('older-two', 'alpha beta ' + 'padding '.repeat(47), 0),
    doc('newer-one', 'alpha ' + 'padding '.repeat(4), 1),
  ]);
  const found = index.search({ concepts: [['alpha'], ['beta']] });
  assert.equal(found.results[0].score, found.results[1].score);
  assert.deepEqual(ids(found), ['newer-one', 'older-two']);
  assert.deepEqual(ids(worker.query({ concepts: [['alpha'], ['beta']] }, { mode: 'manual' })), ['newer-one', 'older-two']);
});

test('apostrophe single-letter fragments use literal lookup without becoming FTS tokens', t => {
  const { index, worker } = corpus(t, [doc('friend', "friend's", 0)]);
  assert.deepEqual(ids(index.search({ concepts: [['friend']] })), ['friend']);
  assert.deepEqual(ids(index.search({ concepts: [['s']] })), ['friend']);
  assert.deepEqual(ids(worker.query({ concepts: [['s']] }, { mode: 'manual' })), ['friend']);
});

test('empty documents do not change native BM25 corpus scores', t => {
  const documents = [doc('match', 'aurora sky', 0), doc('other', 'violet meadow', 1)];
  const baseline = corpus(t, documents);
  const padded = corpus(t, [...documents, doc('empty', '', 2)]);
  assert.deepEqual(padded.index.search({ concepts: [['aurora']] }), baseline.index.search({ concepts: [['aurora']] }));
  assert.deepEqual(padded.worker.query({ concepts: [['aurora']] }, { mode: 'manual' }), baseline.worker.query({ concepts: [['aurora']] }, { mode: 'manual' }));
});

test('single-letter dollar fragments match literal surfaces without FTS syntax errors', t => {
  const { index, worker } = corpus(t, [doc('dollar', '$x $_', 0)]);
  for (const surface of ['$x', '$_']) {
    const query = { concepts: [[surface]] };
    assert.deepEqual(ids(index.search(query)), ['dollar']);
    assert.deepEqual(ids(worker.query(query, { mode: 'manual' })), ['dollar']);
  }
});

test('actual display projection strips scores from retrieved rows and rendered pages', t => {
  const { worker } = corpus(t, [doc('visible', 'aurora', 0)]);
  const found = worker.query({ concepts: [['aurora']] }, { mode: 'manual' });
  assert.equal(typeof found.results[0].score, 'number');
  const projected = displayRows(found.results);
  assert.deepEqual(Object.keys(projected[0]).sort(), ['date', 'id', 'role', 'snippet']);
  assert.deepEqual(projected[0], { id: 'visible', date: '2026-10-04', role: 'user', snippet: 'aurora' });
  const page = sqliteRecallPage(found.results);
  assert.ok(!page.text.includes('"score"'));
  assert.ok(page.text.includes('"id":"visible"'));
});


test('real background worker transports aligned aliases, deduped totals and internal ranks', async () => {
  const texts = ['getUser aurora red', 'HTTPServer aurora blue', 'getUser aurora red'];
  const branch = initialBranch(texts.map((text, i) => msg(i, text)));
  const background = new BackgroundIndex({ engineModule: new URL('../benchmark/retrieval-sqlite-worker.mjs', import.meta.url) });
  const sync = createIndex(branch.slice(0, texts.length).map((entry, i) => ({ id: entry.id, text: texts[i], sourcePosition: i })));
  try {
    await background.prepare(branch, { preindexLive: true });
    for (const [query, mode] of [['user', 'auto'], ['server', 'manual'], ['aurora', 'manual']]) {
      const found = await background.queryRanked(mode === 'auto' ? query : { concepts: [[query]] }, branch, { mode });
      const expected = mode === 'auto' ? sync.search(query, { automatic: true }) : sync.search({ concepts: [[query]] });
      assert.deepEqual(found.results.map(({ id, score }) => ({ id, score })), expected.results);
      assert.equal(found.total, query === 'aurora' ? 2 : 1);
      for (const row of displayRows(found.results)) assert.deepEqual(Object.keys(row).sort(), ['date', 'id', 'role', 'snippet']);
    }
  } finally { sync.close(); await background.dispose(); }
});
