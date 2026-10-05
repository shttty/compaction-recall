import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex, tokenizeSpans as prototypeSpans, weightedLength } from '../prototype/soft-match-sqlite/index.mjs';
import { createWorkerEngine } from '../benchmark/retrieval-sqlite-worker.mjs';
import { BackgroundIndex } from '../src/background-index.mjs';
import { initialBranch, msg } from './corpus.mjs';

const entry = (id, text, sourcePosition) => ({
  type: 'message', id, sourcePosition,
  timestamp: '2026-10-04T12:00:00.000Z', message: { role: 'user', content: text }
});
const ranks = rows => rows.map(({ id, score }) => ({ id, score }));
const engineModule = new URL('../benchmark/retrieval-sqlite-worker.mjs', import.meta.url);



test('worker preserves complete ranks/scores, automatic gate and author errors', t => {
  const entries = Array.from({ length: 65 }, (_, i) => entry(String(i).padStart(2, '0'),
    (i % 3 ? 'alpha alpha beta 网关 重启 foo_bar' : 'beta padding 网关 网关') + ` row${String(i).padStart(2, '0')}`, i));
  const worker = createWorkerEngine();
  const sync = createIndex(entries.map(e => ({ id: e.id, text: e.message.content })));
  t.after(() => { worker.dispose(); sync.close(); });
  worker.commit(entries, { eligibleCount: entries.length, append: false });
  for (const query of [{ concepts: [['alpha'], ['beta']] }, { concepts: [['网关', '重启']] },
    { concepts: [['alpha']], exclude: ['padding'] }, { concepts: [['alpha beta']] },
    { concepts: [['foo']] }, { concepts: [['absent']] }]) {
    const found = worker.query(query, { mode: 'manual', options: { limit: 1, offset: 8 } });
    const expected = sync.search(query, { limit: entries.length });
    assert.deepEqual(ranks(found.results), expected.results);
    assert.equal(found.total, expected.total);
  }
  for (const query of ['where alpha beta', '网关重启', 'alpha' + ' '.repeat(205), 'alpha' + ' '.repeat(206)]) {
    assert.deepEqual(ranks(worker.query(query, { mode: 'auto' }).results),
      sync.search(query, { automatic: true, limit: entries.length }).results, query);
  }
  let expectedError;
  try { sync.search({ concepts: [] }); } catch (error) { expectedError = error; }
  assert.throws(() => worker.query({ concepts: [] }, { mode: 'manual' }),
    error => error.name === expectedError.name && error.code === expectedError.code && error.message === expectedError.message);
  assert.deepEqual(ranks(worker.query({ concepts: [['alpha']] }, { mode: 'manual' }).results), sync.search({ concepts: [['alpha']] }, { limit: entries.length }).results);
});

test('live entries never affect ranks; activation and edits replace searchable text', t => {
  const worker = createWorkerEngine();
  t.after(() => worker.dispose());
  const entries = [entry('a', 'alpha alpha', 0), entry('b', 'alpha beta', 2), entry('live', 'liveonly alpha', 9)];
  worker.commit(entries, { eligibleCount: 3, append: false });
  const baseline = worker.query({ concepts: [['alpha']] }, { mode: 'manual' });
  worker.commit([...entries, entry('live2', 'alpha '.repeat(1000), 10)], { eligibleCount: 3, append: true });
  assert.deepEqual(worker.query({ concepts: [['alpha']] }, { mode: 'manual' }), baseline);
  assert.equal(worker.query({ concepts: [['liveonly']] }, { mode: 'manual' }).total, 0);
  worker.commit(entries, { eligibleCount: 10, append: true });
  assert.deepEqual(worker.query({ concepts: [['liveonly']] }, { mode: 'manual' }).results.map(row => row.id), ['live']);
  worker.commit([entry('a', 'replacement', 0), entries[1], entries[2]], { eligibleCount: 3, append: false });
  assert.deepEqual(worker.query({ concepts: [['alpha']] }, { mode: 'manual' }).results.map(row => row.id), ['b']);
  assert.deepEqual(worker.query({ concepts: [['replacement']] }, { mode: 'manual' }).results.map(row => row.id), ['a']);
  assert.equal(worker.query({ concepts: [['liveonly']] }, { mode: 'manual' }).total, 0);
});

test('aligned component spans retain codepoint positions and anchor original identifiers', t => {
  const text = '🙂𠀀𠀁 foo_BAR foo_barista 中华人民共和国 ' + 'noise '.repeat(40) + '🙂 NeedleID foo_BAR';
  const spans = prototypeSpans(text);
  for (const span of spans) assert.equal(Array.from(text).slice(span.start, span.end).join('').toLowerCase(), span.term);
  assert.deepEqual(spans.find(span => span.term === '𠀀𠀁'), { term: '𠀀𠀁', start: 1, end: 3 });
  const worker = createWorkerEngine();
  t.after(() => worker.dispose());
  worker.commit([entry('a', text, 0)], { eligibleCount: 1 });
  const raw = worker.query({ concepts: [['NeedleID'], ['foo_BAR']], match: 'all' }, { mode: 'manual' }).results[0];
  assert.ok(raw.snippet.includes('NeedleID foo_BAR'));
  assert.ok(weightedLength(raw.snippet.replace(/^…|…$/gu, '')) <= 240);
  assert.deepEqual(worker.query({ concepts: [['bar']] }, { mode: 'manual' }).results.map(row => row.id), ['a']);
  assert.ok(worker.query('where NeedleID', { mode: 'auto' }).results[0].snippet.includes('NeedleID'));
  const hanQuery = worker.query({ concepts: [['中华人民共和国'], ['NeedleID']] }, { mode: 'manual' });
  assert.deepEqual(hanQuery.results.map(row => row.id), ['a']);
});

test('BackgroundIndex transports full SQLite ranks and survives invalid concepts', async () => {
  const index = new BackgroundIndex({ engineModule });
  const branch = initialBranch(Array.from({ length: 55 }, (_, i) => msg(i, `alpha beta 网关 row${String(i).padStart(2, '0')}`)));
  try {
    await index.prepare(branch, { preindexLive: true });
    const found = await index.queryRanked({ concepts: [['alpha'], ['absent']] }, branch, { mode: 'manual', options: { limit: 1, offset: 10 } });
    assert.equal(found.total, 55);
    assert.equal(found.results.length, 55);
    assert.deepEqual(found.results.map(row => row.id), branch.slice(0, 55).map(e => e.id).reverse());
    await assert.rejects(index.queryRanked({ concepts: [] }, branch, { mode: 'manual' }), { name: 'QueryError', code: 'INVALID_ARRAY' });
    assert.equal((await index.queryRanked('网关', branch, { mode: 'auto' })).total, 55);
  } finally { await index.dispose(); }
});
