import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex, tokenize, tokenizeSpans as prototypeSpans } from '../prototype/soft-match-sqlite/index.mjs';
import { countKeywords, queryTerms } from '../prototype/soft-match-sqlite/query.mjs';
import { createWorkerEngine } from '../benchmark/retrieval-sqlite-worker.mjs';
import { fts5Snippet } from '../benchmark/fts5-snippet.mjs';
import { BackgroundIndex } from '../src/background-index.mjs';
import { initialBranch, msg } from './corpus.mjs';

const entry = (id, text, sourcePosition) => ({
  type: 'message', id, sourcePosition,
  timestamp: '2026-10-04T12:00:00.000Z', message: { role: 'user', content: text }
});
const ranks = rows => rows.map(({ id, score }) => ({ id, score }));
const engineModule = new URL('../benchmark/retrieval-sqlite-worker.mjs', import.meta.url);

test('keyword limit counts input operands, not normalized/deduplicated index terms', () => {
  for (const [query, expected] of [
    ['one two three four five', 5], ['one two three four five six', 6],
    ['one one one one one one', 6], ['"one two" three four five six', 5],
    ['tokens:one AND (two OR three) NOT four', 4],
    ['{tokens}: NEAR("one two" three, 12) OR four', 3],
    ['NEAR(one two, 10) 42', 3], ['tokens : "one two"*', 1],
    ['^"one two"', 1], ['tokens:^"one two"*', 1],
    ['"one ""two"" three" four', 2], ['强迫性性行为 网关', 2],
    ['one 网关 two 重启 three', 5], [' \t\n ', 0],
    ['foo-bar foo_bar foo*', 3], ['"', 0], ['', 0],
    ['"one two three four five six', 6], ['one OR (two three', 3],
  ]) assert.equal(countKeywords(query), expected, query);
});

test('MATCH term extraction preserves literal Han and phrase constituents, ignoring grammar', () => {
  assert.deepEqual(queryTerms('{tokens}:NEAR("Alpha beta" 强迫性性行为, 10) NOT absent'),
    ['alpha', 'beta', '强迫性性行为', 'absent']);
  assert.deepEqual(queryTerms('tokens:foo_bar OR "AND OR" OR 42'), ['foo_bar', 'and', 'or', '42']);
  assert.deepEqual(queryTerms('tokens:^"one two"*'), ['one', 'two']);
});

test('vocabulary diagnostics mean absent bare terms, not absent phrase/Boolean matches', t => {
  const index = createIndex([{ id: 'a', text: 'alpha beta foo_bar 网关 强迫性性行为 42' }]);
  t.after(() => index.close());
  assert.deepEqual(index.missingTerms('ALPHA OR absent OR 网关 OR absent'), ['absent']);
  assert.deepEqual(index.missingTerms('tokens:NEAR(alpha beta, 10) NOT "absent ghost"'), ['absent', 'ghost']);
  assert.deepEqual(index.missingTerms('"beta alpha"'), []);
  assert.deepEqual(index.searchRaw('"beta alpha"').results, []);
  assert.deepEqual(index.missingTerms('ghost* OR "missing phra"*'), ['missing']);
  assert.deepEqual(index.missingTerms('tokens:^"alpha absent"'), ['absent']);
  assert.deepEqual(index.missingTerms('tokens:^"missing phra"*'), ['missing']);
  assert.deepEqual(index.missingTerms('强迫性性行为'), ['强迫性性行为']);
  assert.deepEqual(index.missingTerms('42'), []);
});

test('worker preserves complete synchronous ranks/scores, query gate and native failures', t => {
  const entries = Array.from({ length: 65 }, (_, i) => entry(String(i).padStart(2, '0'),
    (i % 3 ? 'alpha alpha beta 网关 重启 foo_bar' : 'beta padding 网关 网关') + ` row${String(i).padStart(2, '0')}`, i));
  const worker = createWorkerEngine();
  const sync = createIndex(entries.map(e => ({ id: e.id, text: e.message.content })));
  t.after(() => { worker.dispose(); sync.close(); });
  worker.commit(entries, { eligibleCount: entries.length, append: false });
  for (const query of ['alpha beta', '网关 OR 重启', 'tokens:alpha NOT padding', 'NEAR(alpha beta, 3)', '"alpha alpha"', 'foo*', 'absent']) {
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

test('live entries never affect ranks/vocabulary; activation and edits replace searchable text', t => {
  const worker = createWorkerEngine();
  t.after(() => worker.dispose());
  const entries = [entry('a', 'alpha alpha', 0), entry('b', 'alpha beta', 2), entry('live', 'liveonly alpha', 9)];
  worker.commit(entries, { eligibleCount: 3, append: false });
  const baseline = worker.query('alpha', { mode: 'manual' });
  worker.commit([...entries, entry('live2', 'alpha '.repeat(1000), 10)], { eligibleCount: 3, append: true });
  assert.deepEqual(worker.query('alpha', { mode: 'manual' }), baseline);
  assert.deepEqual(worker.query('liveonly', { mode: 'manual' }).missingTerms, ['liveonly']);
  worker.commit(entries, { eligibleCount: 10, append: true });
  assert.deepEqual(worker.query('liveonly', { mode: 'manual' }).results.map(row => row.id), ['live']);
  worker.commit([entry('a', 'replacement', 0), entries[1], entries[2]], { eligibleCount: 3, append: false });
  assert.deepEqual(worker.query('alpha', { mode: 'manual' }).results.map(row => row.id), ['b']);
  assert.deepEqual(worker.query('replacement', { mode: 'manual' }).results.map(row => row.id), ['a']);
  assert.deepEqual(worker.query('liveonly', { mode: 'manual' }).missingTerms, ['liveonly']);
});

test('aligned spans retain codepoint positions and whole identifiers', t => {
  const text = '🙂𠀀𠀁 foo_BAR foo_barista 中华人民共和国 ' + 'noise '.repeat(40) + '🙂 NeedleID foo_BAR';
  const spans = prototypeSpans(text);
  for (const span of spans) assert.equal(Array.from(text).slice(span.start, span.end).join('').toLowerCase(), span.term);
  assert.deepEqual(spans.find(span => span.term === '𠀀𠀁'), { term: '𠀀𠀁', start: 1, end: 3 });
  const worker = createWorkerEngine();
  t.after(() => worker.dispose());
  worker.commit([entry('a', text, 0)], { eligibleCount: 1 });
  const raw = worker.query('NeedleID foo_BAR', { mode: 'manual' }).results[0];
  const wantedRaw = new Set(tokenize('NeedleID foo_BAR'));
  const hits = spans.filter(span => wantedRaw.has(span.term));
  assert.equal(raw.snippet, fts5Snippet(text, hits, 120, { sentenceBonus: false }));
  assert.ok(raw.snippet.includes('NeedleID foo_BAR'));
  assert.deepEqual(worker.query('bar', { mode: 'manual' }).results.map(row => row.id), ['a']);
  assert.equal(worker.query('foo_b*', { mode: 'manual' }).results[0].snippet,
    fts5Snippet(text, spans.filter(span => span.term.startsWith('foo_b')).map(span => ({ ...span, term: 'foo_b' })), 120, { sentenceBonus: false }));
  const wantedAuto = new Set(tokenize('NeedleID'));
  assert.equal(worker.query('where NeedleID', { mode: 'auto' }).results[0].snippet,
    fts5Snippet(text, spans.filter(span => wantedAuto.has(span.term)), 120, { sentenceBonus: false }));
  const hanQuery = worker.query('中华人民共和国 OR NeedleID', { mode: 'manual' });
  assert.deepEqual(hanQuery.missingTerms, ['中华人民共和国']);
  const wanted = new Set(tokenize('中华人民共和国 NeedleID'));
  assert.equal(hanQuery.results[0].snippet,
    fts5Snippet(text, spans.filter(span => wanted.has(span.term)), 120, { sentenceBonus: false }));
});

test('BackgroundIndex transports full SQLite ranks and vocabulary extras, survives malformed MATCH', async () => {
  const index = new BackgroundIndex({ engineModule });
  const branch = initialBranch(Array.from({ length: 55 }, (_, i) => msg(i, `alpha beta 网关 row${String(i).padStart(2, '0')}`)));
  try {
    await index.prepare(branch, { preindexLive: true });
    const found = await index.queryRanked('alpha absent', branch, { mode: 'manual', options: { limit: 1, offset: 10 } });
    assert.equal(found.total, 55);
    assert.equal(found.results.length, 55);
    assert.deepEqual(found.missingTerms, ['absent']);
    assert.deepEqual(found.results.map(row => row.id), branch.slice(0, 55).map(e => e.id).reverse());
    await assert.rejects(index.queryRanked('"', branch, { mode: 'manual' }), /unterminated string/);
    assert.equal((await index.queryRanked('网关', branch, { mode: 'auto' })).total, 55);
  } finally { await index.dispose(); }
});
