import assert from 'node:assert/strict';
import test from 'node:test';
import { compileQuery, createIndex } from '../prototype/structured-tool-query/index.mjs';

const group = (...any_of) => ({ any_of });
const ids = found => found.results.map(row => row.id);
const sortedIds = found => ids(found).sort();
function corpus(t, documents) {
  const index = createIndex(documents);
  t.after(() => index.close());
  return index;
}

// Every fixture is independent synthetic text, not a benchmark question or answer.
test('must ANDs concept groups while any_of ORs whole literal alternatives', t => {
  const index = corpus(t, [
    { id: 'cedar', text: 'cedar harbor' },
    { id: 'maple', text: 'maple harbor' },
    { id: 'first-only', text: 'cedar inland' },
    { id: 'second-only', text: 'willow harbor' },
    { id: 'phrase-gap', text: 'cedar winding trail harbor' },
    { id: 'phrase', text: 'cedar trail harbor' },
  ]);
  assert.deepEqual(sortedIds(index.search({ must: [group('cedar', 'maple'), group('harbor')] })),
    ['cedar', 'maple', 'phrase', 'phrase-gap']);
  assert.deepEqual(ids(index.search({ must: [group('cedar trail'), group('harbor')] })), ['phrase']);
});

test('prefer ranks but never removes must candidates, even with no preference hits', t => {
  const index = corpus(t, [
    { id: 'plain', text: 'harbor cedar' },
    { id: 'preferred', text: 'harbor violet' },
    { id: 'outside', text: 'meadow violet' },
  ]);
  const found = index.search({ must: [group('harbor')], prefer: [group('violet')] });
  assert.equal(found.total, 2);
  assert.deepEqual(ids(found), ['preferred', 'plain']);
  assert.deepEqual(found.results.map(row => row.preferGroups), [1, 0]);
  const absent = index.search({ must: [group('harbor')], prefer: [group('absent')] });
  assert.deepEqual(sortedIds(absent), ['plain', 'preferred']);
  assert.deepEqual(absent.results.map(row => row.preferGroups), [0, 0]);
});

test('prefer-only candidates are the union of groups and their alternatives', t => {
  const index = corpus(t, [
    { id: 'both', text: 'violet silver' },
    { id: 'alternative', text: 'amber cedar' },
    { id: 'second', text: 'silver cedar' },
    { id: 'neither', text: 'cedar willow' },
  ]);
  for (const must of [undefined, []]) {
    const input = { prefer: [group('violet', 'amber'), group('silver')] };
    if (must !== undefined) input.must = must;
    const found = index.search(input);
    assert.equal(found.total, 3);
    assert.deepEqual(sortedIds(found), ['alternative', 'both', 'second']);
    assert.equal(found.results[0].id, 'both');
    assert.deepEqual(found.results.map(row => row.preferGroups), [2, 1, 1]);
  }
});

test('exclude removes a match to any literal without changing surviving base scores', t => {
  const index = corpus(t, [
    { id: 'keep-short', text: 'harbor cedar' },
    { id: 'remove-one', text: 'harbor mobile' },
    { id: 'keep-long', text: 'harbor cedar willow maple birch' },
    { id: 'remove-two', text: 'harbor tablet' },
  ]);
  const input = { must: [group('harbor')] };
  const baseline = index.search(input);
  const excluded = index.search({ ...input, exclude: ['mobile', 'tablet'] });
  assert.equal(excluded.total, 2);
  assert.deepEqual(excluded.results, baseline.results.filter(row => row.id.startsWith('keep-')));
  assert.deepEqual(index.search({ ...input, exclude: ['absent'] }), baseline);
});

test('exclude phrases remain literal and also filter prefer-only candidates', t => {
  const index = corpus(t, [
    { id: 'literal', text: 'violet mobile OR tablet' },
    { id: 'single', text: 'violet mobile' },
    { id: 'other', text: 'silver tablet' },
  ]);
  const found = index.search({ prefer: [group('violet'), group('silver')], exclude: ['mobile OR tablet'] });
  assert.equal(found.total, 2);
  assert.deepEqual(sortedIds(found), ['other', 'single']);
});

test('empty positive conditions reject rather than searching the entire corpus', t => {
  const index = corpus(t, [{ id: 'one', text: 'harbor cedar' }]);
  for (const input of [{}, { must: [] }, { prefer: [] }, { must: [], prefer: [] },
    { exclude: ['cedar'] }, { must: [], prefer: [], exclude: ['cedar'], limit: 1 }]) {
    assert.throws(() => compileQuery(input), Error);
    assert.throws(() => index.search(input), Error);
  }
});

test('default limit is 20, total counts all candidates, and positive limits are not capped', t => {
  const index = corpus(t, Array.from({ length: 27 }, (_, i) => ({ id: `row-${i}`, text: 'harbor cedar' })));
  const input = { must: [group('harbor')] };
  const found = index.search(input);
  assert.equal(found.total, 27);
  assert.equal(found.limit, 20);
  assert.deepEqual(ids(found), Array.from({ length: 20 }, (_, i) => `row-${i}`));
  const one = index.search({ ...input, limit: 1 });
  assert.equal(one.total, 27);
  assert.equal(one.limit, 1);
  assert.deepEqual(ids(one), ['row-0']);
  const all = index.search({ ...input, limit: 40 });
  assert.equal(all.total, 27);
  assert.equal(all.limit, 40);
  assert.deepEqual(ids(all), Array.from({ length: 27 }, (_, i) => `row-${i}`));
});

test('preference ranking sees the entire candidate set before the final limit', t => {
  const documents = Array.from({ length: 36 }, (_, i) => ({ id: `early-${i}`, text: 'harbor cedar' }));
  documents.push({ id: 'late-winner', text: 'harbor violet ' + 'padding '.repeat(60) });
  const index = corpus(t, documents);
  const found = index.search({ must: [group('harbor')], prefer: [group('violet')], limit: 1 });
  assert.equal(found.total, 37);
  assert.deepEqual(ids(found), ['late-winner']);
  assert.equal(found.results[0].preferGroups, 1);
});

test('preference counts matched groups, not alternatives or occurrence frequency', t => {
  const index = corpus(t, [
    { id: 'many-alternatives', text: 'harbor violet amber violet amber violet amber' },
    { id: 'two-groups', text: 'harbor violet silver ' + 'padding '.repeat(20) },
    { id: 'one-occurrence', text: 'harbor amber' },
  ]);
  const found = index.search({ must: [group('harbor')], prefer: [group('violet', 'amber'), group('silver')] });
  assert.equal(found.results[0].id, 'two-groups');
  assert.deepEqual(Object.fromEntries(found.results.map(row => [row.id, row.preferGroups])),
    { 'two-groups': 2, 'one-occurrence': 1, 'many-alternatives': 1 });
});

test('equal preference counts use base-candidate BM25 before insertion order', t => {
  const index = corpus(t, [
    { id: 'long-first', text: 'harbor violet ' + 'padding '.repeat(40) },
    { id: 'short-later', text: 'harbor violet' },
    { id: 'no-preference', text: 'harbor cedar' },
  ]);
  const baseline = index.search({ must: [group('harbor')] });
  const ranked = index.search({ must: [group('harbor')], prefer: [group('violet')] });
  assert.deepEqual(ids(ranked), ['short-later', 'long-first', 'no-preference']);
  assert.ok(ranked.results[0].score < ranked.results[1].score);
  const baseScores = new Map(baseline.results.map(row => [row.id, row.score]));
  for (const row of ranked.results) assert.equal(row.score, baseScores.get(row.id));
});

test('exact preference and BM25 ties retain insertion order, not lexical id order', t => {
  const index = corpus(t, [
    { id: 'z-first', text: 'harbor violet' },
    { id: 'a-second', text: 'harbor violet' },
    { id: 'm-third', text: 'harbor violet' },
  ]);
  const found = index.search({ must: [group('harbor')], prefer: [group('violet')] });
  assert.deepEqual(ids(found), ['z-first', 'a-second', 'm-third']);
  assert.equal(found.results[0].score, found.results[1].score);
  assert.equal(found.results[1].score, found.results[2].score);
});

test('Chinese long literals require every adjacent bigram in sequence, including inside longer runs', t => {
  const index = corpus(t, [
    { id: 'whole', text: '珊瑚灯塔' },
    { id: 'embedded', text: '旧珊瑚灯塔入口' },
    { id: 'fragment', text: '珊瑚' },
    { id: 'separated', text: '珊瑚 灯塔' },
    { id: 'pieces', text: '瑚灯 珊瑚 灯塔' },
    { id: 'different', text: '珊瑚石塔' },
  ]);
  assert.deepEqual(sortedIds(index.search({ must: [group('珊瑚灯塔')] })), ['embedded', 'whole']);
});

test('repeated Chinese bigrams retain multiplicity and cannot cross run boundaries', t => {
  const index = corpus(t, [
    { id: 'two', text: '哈哈' },
    { id: 'three', text: '哈哈哈' },
    { id: 'four', text: '哈哈哈哈' },
    { id: 'separated', text: '哈哈 哈哈' },
  ]);
  assert.deepEqual(sortedIds(index.search({ must: [group('哈哈哈')] })), ['four', 'three']);
  assert.deepEqual(ids(index.search({ must: [group('哈哈哈哈')] })), ['four']);
});

test('camel, acronym and snake components casefold and remain adjacent to Han tokens', t => {
  const index = corpus(t, [
    { id: 'acronym', text: 'HTTPServer缓存池' },
    { id: 'spaced', text: 'http server 缓存' },
    { id: 'snake', text: 'cache_store缓存池' },
    { id: 'camel', text: 'cacheStore缓存池' },
    { id: 'gap', text: 'HTTP relay Server缓存' },
    { id: 'han-first', text: '缓存HTTPServer' },
    { id: 'han-extended', text: '缓存池HTTPServer' },
  ]);
  assert.deepEqual(sortedIds(index.search({ must: [group('HTTPServer缓存')] })), ['acronym', 'spaced']);
  assert.deepEqual(sortedIds(index.search({ must: [group('CACHE_STORE缓存')] })), ['camel', 'snake']);
  assert.deepEqual(ids(index.search({ must: [group('缓存HTTPServer')] })), ['han-first']);
});

test('Han spaces and punctuation preserve run barriers, while ASCII separators are not exact text', t => {
  const index = corpus(t, [
    { id: 'space', text: '紫藤 花园' },
    { id: 'punctuation', text: '紫藤，花园' },
    { id: 'last-extended', text: '紫藤 花园入口' },
    { id: 'joined', text: '紫藤花园' },
    { id: 'first-extended', text: '紫藤蔓 花园' },
    { id: 'ascii-space', text: 'cedar maple' },
    { id: 'ascii-punctuation', text: 'cedar-maple' },
    { id: 'ascii-gap', text: 'cedar willow maple' },
  ]);
  for (const literal of ['紫藤 花园', '紫藤，花园']) {
    assert.deepEqual(sortedIds(index.search({ must: [group(literal)] })), ['last-extended', 'punctuation', 'space']);
  }
  assert.deepEqual(ids(index.search({ must: [group('紫藤花园')] })), ['joined']);
  assert.deepEqual(sortedIds(index.search({ must: [group('cedar-maple')] })), ['ascii-punctuation', 'ascii-space']);
});

test('OR, AND, NOT and NEAR inside a literal never become query operators', t => {
  const documents = ['OR', 'AND', 'NOT', 'NEAR'].map(operator => ({ id: operator, text: `cedar ${operator} maple` }));
  documents.push({ id: 'left-only', text: 'cedar' }, { id: 'right-only', text: 'maple' },
    { id: 'adjacent', text: 'cedar maple' }, { id: 'gap', text: 'cedar willow maple' });
  const index = corpus(t, documents);
  for (const operator of ['OR', 'AND', 'NOT', 'NEAR']) {
    assert.deepEqual(ids(index.search({ must: [group(`cedar ${operator} maple`)] })), [operator]);
  }
  assert.deepEqual(ids(index.search({ must: [group('NEAR(cedar maple)')] })), []);
});

test('quotes, parentheses and wildcard punctuation are literal separators, not FTS syntax', t => {
  const index = corpus(t, [
    { id: 'adjacent', text: 'cedar maple' },
    { id: 'quoted', text: 'cedar "maple"' },
    { id: 'gap', text: 'cedar willow maple' },
    { id: 'prefix', text: 'cedar maples' },
  ]);
  for (const literal of ['cedar "maple"', '"cedar maple"', 'cedar (maple)', 'cedar maple*']) {
    assert.deepEqual(sortedIds(index.search({ must: [group(literal)] })), ['adjacent', 'quoted']);
  }
});

test('zero hits do not stem, invent synonyms, or relax the literal phrase', t => {
  const index = corpus(t, [{ id: 'one', text: 'running cedar distant maple' }]);
  for (const literal of ['run', 'jogging', 'cedar maple']) {
    const found = index.search({ must: [group(literal)] });
    assert.equal(found.total, 0);
    assert.deepEqual(found.results, []);
  }
});

test('limit validation rejects null, coercion, fractions and unsafe or nonpositive numbers', () => {
  for (const limit of [null, '2', true, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => compileQuery({ must: [group('harbor')], limit }), error =>
      error instanceof Error && error.message.includes('limit'));
  }
});

test('unsupported query and group shapes reject with the offending field path', () => {
  for (const input of [null, [], 'harbor', 2, true]) assert.throws(() => compileQuery(input), Error);
  const cases = [
    [{ must: [group('harbor')], query: 'harbor' }, 'query'],
    [{ must: null }, 'must'],
    [{ must: 'harbor' }, 'must'],
    [{ must: [['harbor']] }, 'must'],
    [{ must: [null] }, 'must'],
    [{ must: [{ any_of: ['harbor'], extra: true }] }, 'must'],
    [{ must: [{}] }, 'must'],
    [{ must: [{ any_of: [] }] }, 'must'],
    [{ must: [{ any_of: 'harbor' }] }, 'must'],
    [{ must: [{ any_of: [null] }] }, 'must'],
    [{ prefer: null }, 'prefer'],
    [{ prefer: [group(42)] }, 'prefer'],
    [{ must: [group('harbor')], exclude: null }, 'exclude'],
    [{ must: [group('harbor')], exclude: 'cedar' }, 'exclude'],
    [{ must: [group('harbor')], exclude: [group('cedar')] }, 'exclude'],
  ];
  for (const [input, field] of cases) {
    assert.throws(() => compileQuery(input), error => error instanceof Error && error.message.includes(field));
  }
});

test('unsupported literals reject even a partially valid phrase or alternative and identify their location', () => {
  const unsupported = ['', '   ', '!!!', '山', '山 harbor', 'harbor 山', '紫藤 山 花园',
    'x', 'harbor x', 'HTTPServerX', 'cache_x', '42 a', 'café', 'harbor Ω', '紫藤かな',
    'harbor ١٢', 'harbor \u0301', 'harbor\0cedar', 'harbor\ue000cedar'];
  for (const literal of unsupported) {
    for (const field of ['must', 'prefer']) {
      assert.throws(() => compileQuery({ [field]: [group('harbor', literal)] }), error =>
        error instanceof Error && error.message.includes(field) && error.message.includes('any_of'),
      `${field}: ${JSON.stringify(literal)}`);
    }
    assert.throws(() => compileQuery({ must: [group('harbor')], exclude: [literal] }), error =>
      error instanceof Error && error.message.includes('exclude'), JSON.stringify(literal));
  }
});
