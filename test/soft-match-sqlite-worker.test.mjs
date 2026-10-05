import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex, tokenizeSpans as prototypeSpans, weightedLength } from '../prototype/soft-match-sqlite/index.mjs';
import { queryTerms } from '../prototype/soft-match-sqlite/query.mjs';
import { createWorkerEngine } from '../benchmark/retrieval-sqlite-worker.mjs';
import { BackgroundIndex } from '../src/background-index.mjs';
import { initialBranch, msg } from './corpus.mjs';

const entry = (id, text, sourcePosition) => ({
  type: 'message', id, sourcePosition,
  timestamp: '2026-10-04T12:00:00.000Z', message: { role: 'user', content: text }
});
const ranks = rows => rows.map(({ id, score }) => ({ id, score }));
const engineModule = new URL('../benchmark/retrieval-sqlite-worker.mjs', import.meta.url);

test('MATCH term extraction preserves literal Han and phrase constituents, ignoring grammar', () => {
  assert.deepEqual(queryTerms('{tokens}:NEAR("Alpha beta" 强迫性性行为, 10) NOT absent'),
    ['alpha', 'beta', '强迫性性行为', 'absent']);
  assert.deepEqual(queryTerms('tokens:foo_bar OR "AND OR" OR 42'), ['foo', 'bar', 'and', 'or', '42']);
  assert.deepEqual(queryTerms('tokens:^"one two"*'), ['one', 'two']);
});


test('worker preserves complete synchronous ranks/scores, query gate and native failures', t => {
  const entries = Array.from({ length: 65 }, (_, i) => entry(String(i).padStart(2, '0'),
    (i % 3 ? 'alpha alpha beta 网关 重启 foo_bar' : 'beta padding 网关 网关') + ` row${String(i).padStart(2, '0')}`, i));
  const worker = createWorkerEngine();
  const sync = createIndex(entries.map(e => ({ id: e.id, text: e.message.content })));
  t.after(() => { worker.dispose(); sync.close(); });
  worker.commit(entries, { eligibleCount: entries.length, append: false });
  for (const query of ['alpha OR beta', '网关 OR 重启', 'tokens:alpha NOT padding', 'NEAR(alpha beta, 3)', '"alpha alpha"', 'foo*', 'absent']) {
    const found = worker.query(query, { mode: 'manual', options: { limit: 1, offset: 8 } });
    const expected = sync.searchRaw(query);
    assert.deepEqual(ranks(found.results), expected.results, query);
    assert.equal(found.total, expected.total);
  }
  for (const query of ['where alpha beta', '网关重启', 'alpha' + ' '.repeat(205), 'alpha' + ' '.repeat(206)]) {
    assert.deepEqual(ranks(worker.query(query, { mode: 'auto' }).results),
      sync.search(query, { automatic: true, limit: entries.length }).results, query);
  }
  let native;
  try { sync.searchRaw('"'); } catch (error) { native = error; }
  assert.throws(() => worker.query('"', { mode: 'manual' }), error => error.name === native.name && error.message === native.message);
  assert.deepEqual(ranks(worker.query('alpha', { mode: 'manual' }).results), sync.searchRaw('alpha').results);
});

test('live entries never affect ranks; activation and edits replace searchable text', t => {
  const worker = createWorkerEngine();
  t.after(() => worker.dispose());
  const entries = [entry('a', 'alpha alpha', 0), entry('b', 'alpha beta', 2), entry('live', 'liveonly alpha', 9)];
  worker.commit(entries, { eligibleCount: 3, append: false });
  const baseline = worker.query('alpha', { mode: 'manual' });
  worker.commit([...entries, entry('live2', 'alpha '.repeat(1000), 10)], { eligibleCount: 3, append: true });
  assert.deepEqual(worker.query('alpha', { mode: 'manual' }), baseline);
  assert.equal(worker.query('liveonly', { mode: 'manual' }).total, 0);
  worker.commit(entries, { eligibleCount: 10, append: true });
  assert.deepEqual(worker.query('liveonly', { mode: 'manual' }).results.map(row => row.id), ['live']);
  worker.commit([entry('a', 'replacement', 0), entries[1], entries[2]], { eligibleCount: 3, append: false });
  assert.deepEqual(worker.query('alpha', { mode: 'manual' }).results.map(row => row.id), ['b']);
  assert.deepEqual(worker.query('replacement', { mode: 'manual' }).results.map(row => row.id), ['a']);
  assert.equal(worker.query('liveonly', { mode: 'manual' }).total, 0);
});

test('aligned component spans retain codepoint positions and anchor original identifiers', t => {
  const text = '🙂𠀀𠀁 foo_BAR foo_barista 中华人民共和国 ' + 'noise '.repeat(40) + '🙂 NeedleID foo_BAR';
  const spans = prototypeSpans(text);
  for (const span of spans) assert.equal(Array.from(text).slice(span.start, span.end).join('').toLowerCase(), span.term);
  assert.deepEqual(spans.find(span => span.term === '𠀀𠀁'), { term: '𠀀𠀁', start: 1, end: 3 });
  const worker = createWorkerEngine();
  t.after(() => worker.dispose());
  worker.commit([entry('a', text, 0)], { eligibleCount: 1 });
  const raw = worker.query('"needle id" AND "foo bar"', { mode: 'manual' }).results[0];
  assert.ok(raw.snippet.includes('NeedleID foo_BAR'));
  assert.ok(weightedLength(raw.snippet.replace(/^…|…$/gu, '')) <= 240);
  assert.deepEqual(worker.query('bar', { mode: 'manual' }).results.map(row => row.id), ['a']);
  assert.ok(worker.query('bar*', { mode: 'manual' }).results[0].snippet.includes('foo_BAR'));
  assert.ok(worker.query('where NeedleID', { mode: 'auto' }).results[0].snippet.includes('NeedleID'));
  const hanQuery = worker.query('"中华 华人 人民 民共 共和 和国" OR "needle id"', { mode: 'manual' });
  assert.deepEqual(hanQuery.results.map(row => row.id), ['a']);
});

test('BackgroundIndex transports full SQLite ranks and survives malformed MATCH', async () => {
  const index = new BackgroundIndex({ engineModule });
  const branch = initialBranch(Array.from({ length: 55 }, (_, i) => msg(i, `alpha beta 网关 row${String(i).padStart(2, '0')}`)));
  try {
    await index.prepare(branch, { preindexLive: true });
    const found = await index.queryRanked('alpha OR absent', branch, { mode: 'manual', options: { limit: 1, offset: 10 } });
    assert.equal(found.total, 55);
    assert.equal(found.results.length, 55);
    assert.deepEqual(found.results.map(row => row.id), branch.slice(0, 55).map(e => e.id).reverse());
    await assert.rejects(index.queryRanked('"', branch, { mode: 'manual' }), /unterminated string/);
    assert.equal((await index.queryRanked('网关', branch, { mode: 'auto' })).total, 55);
  } finally { await index.dispose(); }
});
