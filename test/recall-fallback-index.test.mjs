import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';
const input = surface => ({ concepts: [[surface]] });
const ids = found => found.results.map(row => row.id);
for (const [surface, hit, other] of [
  ['中', '🙂中 evidence', '🙂重 distractor'],
  ['7:30', 'at 7:30 morning', 'at 8:30 morning'],
  ['café', 'CAFÉ evidence', 'caf distractor'],
  ['e\u0301', 'E\u0301 evidence', 'e distractor'],
  ['Жук', 'ЖУК evidence', 'Жаба distractor'],
  ['١٢', 'value ١٢ evidence', 'value ١٣ distractor'],
  ['.*[x]', 'literal .*[x] evidence', 'matching anything xxxx distractor'],
]) test(`unrepresentable surface ${JSON.stringify(surface)} uses its whole case-insensitive literal predicate`, t => {
  const index = createIndex([{ id: 'hit', text: hit }, { id: 'other', text: other }]);
  t.after(() => index.close());
  const found = index.queryRows(input(surface));
  assert.deepEqual(ids(found), ['hit']);
  assert.equal(found.fallback.ranking, 'rarity');
  assert.equal(found.fallback.scannedDocuments, 2);
  assert.deepEqual(found.fallback.surfaces, [surface]);
});

test('hybrid rarity uses complete surface DF and per-group maximum before all/exclude/paging', t => {
  const index = createIndex([
    { id: 'joint', text: 'harbor gap cedar common 晨' },
    { id: 'cedar', text: 'cedar common common 中' },
    { id: 'harbor', text: 'harbor common' },
    { id: 'plain1', text: 'common markerone' },
    { id: 'plain2', text: 'common markertwo' },
    { id: 'literal', text: '晨 hidden' },
    { id: 'neither', text: 'other words' },
  ]);
  t.after(() => index.close());
  // N=7; DF(common)=5, DF(cedar AND harbor)=1, DF(晨)=2.
  // The joint row takes the rarer alternative, not common+composite together.
  const q = { concepts: [['common', 'cedar harbor'], ['晨']] };
  const any = index.queryRows(q);
  assert.deepEqual(ids(any), ['joint', 'literal', 'plain2', 'plain1', 'harbor', 'cedar']);
  assert.ok(Math.abs(any.results[0].score - 4.367123614131617) < 1e-12);
  assert.ok(Math.abs(any.results[1].score - 1.9808292530117262) < 1e-12);
  for (const row of any.results.slice(2)) assert.ok(Math.abs(row.score - 1.2876820724517808) < 1e-12);
  const all = index.queryRows({ ...q, match: 'all' });
  assert.deepEqual(ids(all), ['joint']);
  assert.equal(all.results[0].score, any.results[0].score);
  const excluded = index.queryRows({ ...q, exclude: ['hidden', '中'] });
  assert.deepEqual(ids(excluded), ['joint', 'plain2', 'plain1', 'harbor']);
  assert.equal(excluded.results[0].score, any.results[0].score);
  const repeated = index.queryRows({ concepts: [['common', 'common', 'cedar harbor'], ['晨']] });
  assert.deepEqual(repeated.results.map(({ id, score }) => [id, score]), any.results.map(({ id, score }) => [id, score]));
  assert.deepEqual(index.queryRows(q, { limit: 1, offset: 1 }).results.map(({ id, score }) => [id, score]),
    any.results.slice(1, 2).map(({ id, score }) => [id, score]));
});

test('a rare literal-only row reaches the first page ahead of the complete FTS candidate set', t => {
  const index = createIndex([{ id: 'rare', text: '中 older evidence' },
    ...Array.from({ length: 100 }, (_, i) => ({ id: `common${i}`, text: `needle unique${i}` }))]);
  t.after(() => index.close());
  const page = index.queryPage({ concepts: [['needle'], ['中']] }, { limit: 1 });
  assert.equal(page.total, 101);
  assert.deepEqual(page.ids, ['rare']);
  assert.match(page.page.text, /中/);
  assert.equal(page.page.details.nextOffset, 1);
});

test('literal snippets show the original Unicode evidence across chunks instead of an unrelated FTS anchor', t => {
  const source = 'needle ' + '🙂İ𠀁 padding '.repeat(500) + 'at 7:30 after';
  const boundary = '.'.repeat(8191) + '🙂C++ original';
  const index = createIndex([{ id: 'far', text: source }, { id: 'boundary', text: boundary }], { snippetBudget: 80 });
  t.after(() => index.close());
  const far = index.queryRows({ concepts: [['needle'], ['7:30']], match: 'all' });
  assert.deepEqual(ids(far), ['far']);
  assert.match(far.results[0].snippet, /7:30/);
  assert.ok(source.includes(far.results[0].snippet.replace(/^…|…$/gu, '')));
  const crossing = index.queryRows(input('🙂c++'));
  assert.deepEqual(ids(crossing), ['boundary']);
  assert.match(crossing.results[0].snippet, /🙂C\+\+/u);
});

test('literal fallback preserves internal whitespace and never rescues invalid parameters', t => {
  const index = createIndex([{ id: 'spaced', text: 'at 7 点 now' }, { id: 'joined', text: 'at 7点 now' }]);
  t.after(() => index.close());
  assert.deepEqual(ids(index.queryRows(input(' 7 点 '))), ['spaced']);
  assert.deepEqual(ids(index.queryRows(input('7点'))), ['joined']);
  for (const [q, code] of [[input(' '), 'EMPTY_TEXT'], [input('中\0'), 'INVALID_TEXT'],
    [input('\ud800'), 'INVALID_TEXT'], [{ concepts: [['中']], extra: true }, 'UNKNOWN_FIELD'],
    [{ concepts: [['中']], match: 'invalid' }, 'INVALID_MODE'],
    [{ concepts: [['中', '中', '中', '中', '中']] }, 'INVALID_ARRAY']]) {
    assert.throws(() => index.queryRows(q), { name: 'QueryError', code });
  }
});

test('a normal FTS zero stays zero despite a literal substring, and native database errors propagate', () => {
  const index = createIndex([{ id: 'substring-only', text: 'prefixneedle suffix' }]);
  try {
    assert.equal(index.queryRows(input('needle')).total, 0);
  } finally { index.close(); }
  assert.throws(() => index.queryRows(input('needle')), { code: 'ERR_INVALID_STATE' });
});

test('redundant analyzed alternatives and their order preserve full ranks, tie order and pages', t => {
  const index = createIndex([{ id: 'common', text: 'common value' },
    { id: 'literal', text: '晨 value' }, { id: 'none', text: 'other value' }]);
  t.after(() => index.close());
  const variants = [
    [['common'], ['common'], ['晨']],
    [['common', 'COMMON'], ['common'], ['晨']],
    [['COMMON', 'common'], ['common'], ['晨']],
    [['COMMON', 'common', 'common'], ['COMMON'], ['晨']],
  ];
  // N=3, both actual predicates have DF=1: equal rarity and recency tie-break.
  const expected = [{ id: 'literal', score: 1.6931471805599454 },
    { id: 'common', score: 1.6931471805599454 }];
  for (const concepts of variants) {
    const q = { concepts };
    assert.deepEqual(index.queryRows(q).results.map(({ id, score }) => ({ id, score })), expected);
    const first = index.queryPage(q, { limit: 1 });
    assert.equal(first.total, 2);
    assert.deepEqual(first.ids, ['literal']);
    assert.equal(first.page.details.nextOffset, 1);
    const next = index.queryPage(q, { limit: 1, offset: first.page.details.nextOffset });
    assert.deepEqual(next.ids, ['common']);
    assert.equal(next.page.details.nextOffset, null);
    assert.deepEqual(index.queryPage(q, { limit: 1, offset: 2 }).ids, []);
  }
});

test('different predicates in different groups still add even with identical current hit sets', t => {
  const index = createIndex([{ id: 'both', text: 'common additional 晨' },
    { id: 'indexed', text: 'common additional' }, { id: 'literal', text: '晨 solitary' }]);
  t.after(() => index.close());
  // common/additional have identical hit sets, but are different predicates.
  // N=3 and DF=2 for all three predicates; the joint row hits three groups.
  const expected = [{ id: 'both', score: 3.8630462173553424 },
    { id: 'indexed', score: 2.5753641449035616 }, { id: 'literal', score: 1.2876820724517808 }];
  for (const concepts of [[['common'], ['additional'], ['晨']],
    [['COMMON', 'common'], ['additional', 'ADDITIONAL'], ['晨']]]) {
    const found = index.queryRows({ concepts });
    assert.deepEqual(ids(found), expected.map(row => row.id));
    for (let at = 0; at < expected.length; at++) assert.ok(Math.abs(found.results[at].score - expected[at].score) < 1e-12);
  }
});
