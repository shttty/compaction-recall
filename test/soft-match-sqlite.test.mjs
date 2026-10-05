import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex, extractText, tokenize, weightedLength } from '../prototype/soft-match-sqlite/index.mjs';
import { documents } from '../prototype/soft-match-sqlite/demo.mjs';

const ids = result => result.results.map(hit => hit.id);
const open = (t, docs = documents) => {
  const index = createIndex(docs);
  t.after(() => index.close());
  return index;
};

test('surface Han bigrams co-occur across punctuation and in reverse order', t => {
  const index = open(t, [
    { id: 'whole', text: '中华人民共和国 哈哈哈 𠀀𠀁𠀂' },
    { id: 'split', text: '和国，共和 哈哈 哈哈 𠀁𠀂，𠀀𠀁' },
    { id: 'partial', text: '共和 𠀀𠀁' },
  ]);
  for (const surface of ['共和国', '哈哈哈', '𠀀𠀁𠀂']) {
    assert.deepEqual(ids(index.search({ concepts: [[surface]] })).sort(), ['split', 'whole']);
  }
});

test('ASCII identifiers retain only aligned components next to Han', () => {
  assert.deepEqual(tokenize('修改youer服务端配置').filter(term => /^[a-z0-9_]+$/.test(term)), ['youer']);
  assert.deepEqual(tokenize('CompactionResult foo_BAR foo_BAR vm kvm 42 x _'),
    ['compaction', 'result', 'foo', 'bar', 'foo', 'bar', 'vm', 'kvm', '42']);
});

test('automatic synthetic examples retain machine-selected OR candidates', t => {
  const index = open(t);
  for (const [query, expected] of [
    ['网关重启后为什么断连？', ['a', 'b']],
    ['网关', ['a', 'b']],
    ['索引', ['d']],
    ['youer', ['e']],
    ['修改youer服务端配置', ['b', 'e']],
    ['GPU显存', ['m']],
    ['What time do I stop checking work emails and messages?', ['k']],
    ['vm', ['g']], ['kvm', ['h']],
    ['compaction', ['f']], ['CompactionResult', ['f']],
    ['moto', []], ['motorcycle', ['l']],
    ['gatway', []], ['gateway', ['i', 'j']],
    ['gateway nonexistentword', ['i', 'j']],
    ['网关 不存在的词', ['a', 'b']],
    ['网', []], ['', []], ['the AND is please recall', []],
  ]) {
    const result = index.search(query, { automatic: true });
    assert.equal(result.skipped, false, query);
    assert.equal(result.total, expected.length, query);
    assert.deepEqual(ids(result).sort(), expected, query);
    assert.ok(result.results.every(hit => Number.isFinite(hit.score) && hit.score < 0), query);
  }
  assert.deepEqual(index.search('gateway gateway GATEWAY', { automatic: true }), index.search('gateway', { automatic: true }));
});

test('bigrams cross dictionary boundaries but never punctuation', t => {
  const index = open(t, [
    { id: 'joined', text: '搜索引擎' },
    { id: 'punctuated', text: '搜索，引擎' },
    { id: 'country', text: '中华人民共和国' },
    { id: 'astral', text: '𠀀𠀁𠀂' },
  ]);
  assert.deepEqual(ids(index.search({ concepts: [['索引']] })), ['joined']);
  assert.deepEqual(ids(index.search({ concepts: [['共和国']] })), ['country']);
  assert.deepEqual(ids(index.search({ concepts: [['𠀀𠀁']] })), ['astral']);
  assert.deepEqual(ids(index.search({ concepts: [['𠀀']] })), ['astral']);
});

test('concept identifier components co-occur; incomplete single characters use literal lookup', t => {
  const index = open(t, [
    { id: 'identifier', text: 'foo_bar CompactionResult 42 x _' },
    { id: 'split', text: 'foo bar compaction result 4 2' },
  ]);
  for (const query of ['foo', 'bar', 'compaction', 'result']) {
    assert.deepEqual(ids(index.search({ concepts: [[query]] })).sort(), ['identifier', 'split'], query);
  }
  assert.deepEqual(ids(index.search({ concepts: [['42']] })), ['identifier']);
  assert.deepEqual(ids(index.search({ concepts: [['FOO_BAR']] })).sort(), ['identifier', 'split']);
  assert.deepEqual(ids(index.search({ concepts: [['CompactionResult']] })).sort(), ['identifier', 'split']);
  assert.deepEqual(ids(index.search({ concepts: [['foo_b']] })), ['identifier']);
  for (const [query, expected] of [['x', ['identifier']], ['_', ['identifier']],
    ['4', ['identifier', 'split']], ['2', ['identifier', 'split']]]) {
    assert.deepEqual(ids(index.search({ concepts: [[query]] })).sort(), expected);
  }
  assert.deepEqual(ids(index.search({ concepts: [['comp*']] })), []);
});


test('contentless BM25 preserves true term frequency and document-length normalization', t => {
  for (const [term, padding] of [['gateway', 'padding'], ['网关', '噪音']]) {
    const index = open(t, [
      { id: 'z-frequent', text: `${term} ${term}` },
      { id: 'a-once', text: `${term} ${padding}` },
      { id: 'short', text: 'needle' },
      { id: 'long', text: 'needle padding padding padding' },
      { id: 'irrelevant', text: 'other' },
    ]);
    const frequency = index.search({ concepts: [[term]] });
    assert.deepEqual(ids(frequency), ['z-frequent', 'a-once']);
    assert.ok(frequency.results[0].score < frequency.results[1].score);
    const length = index.search({ concepts: [['needle']] });
    assert.deepEqual(ids(length), ['short', 'long']);
    assert.ok(length.results[0].score < length.results[1].score);
  }
});

test('ties prefer newest distinct snippets and limits apply after snippet deduplication', t => {
  const index = open(t, [
    { id: 'z', text: 'gateway red' }, { id: 'a', text: 'gateway blue' }, { id: 'A', text: 'gateway green' },
  ]);
  assert.deepEqual(ids(index.search({ concepts: [['gateway']] })), ['A', 'a', 'z']);
  const limited = index.search({ concepts: [['gateway']] }, { limit: 1 });
  assert.equal(limited.total, 3);
  assert.deepEqual(ids(limited), ['A']);
  const zero = index.search({ concepts: [['gateway']] }, { limit: 0 });
  assert.equal(zero.total, 3);
  assert.deepEqual(zero.results, []);
  assert.throws(() => index.search({ concepts: [['gateway']] }, { limit: -1 }), RangeError);
  assert.equal(open(t, []).search({ concepts: [['gateway']] }).total, 0);
  assert.equal(open(t, [{ id: 'empty', text: '' }]).search({ concepts: [['gateway']] }).total, 0);
});

test('weighted length counts Han as two and every other Unicode code point as one', () => {
  assert.equal(weightedLength('A网𠀀🙂_ \n。'), 10);
  assert.equal(weightedLength('网'.repeat(105)), 210);
  assert.equal(weightedLength('🙂'.repeat(210)), 210);
  assert.equal(weightedLength('e\u0301'), 2);
  assert.equal(weightedLength(''), 0);
});

test('automatic 210 gate applies before stopwords/deduplication, without truncation', t => {
  const index = open(t);
  for (const [name, boundary, over, expected] of [
    ['ASCII', 'gateway' + ' '.repeat(203), 'gateway' + ' '.repeat(204), ['i', 'j']],
    ['Han', '网关' + '网'.repeat(103), '网关' + '网'.repeat(104), ['a', 'b']],
    ['mixed', '网关 gateway' + ' '.repeat(198), '网关 gateway' + ' '.repeat(199), ['a', 'b', 'i', 'j']],
    ['stopwords', 'gateway ' + 'the '.repeat(50) + 'is', 'gateway ' + 'the '.repeat(50) + 'is ', ['i', 'j']],
    ['duplicates', 'vm '.repeat(70), 'vm '.repeat(70) + ' ', ['g']],
    ['non-BMP Han', 'gateway ' + '𠀀'.repeat(101), 'gateway ' + '𠀀'.repeat(101) + ' ', ['i', 'j']],
    ['emoji', 'gateway ' + '🙂'.repeat(202), 'gateway ' + '🙂'.repeat(203), ['i', 'j']],
  ]) {
    assert.equal(weightedLength(boundary), 210, name);
    const allowed = index.search(boundary, { automatic: true });
    assert.equal(allowed.skipped, false, name);
    assert.deepEqual(ids(allowed).sort(), expected, name);
    assert.ok(weightedLength(over) > 210, name);
    assert.deepEqual(index.search(over, { automatic: true }),
      { skipped: true, total: 0, results: [], queryTerms: [] }, name);
  }
  const long = 'x '.repeat(106) + 'gateway';
  assert.deepEqual(ids(index.search({ concepts: [['gateway' + ' '.repeat(long.length)]] })).sort(), ['i', 'j']);
  assert.equal(index.search(long, { automatic: true }).skipped, true);
  assert.equal(index.search('the '.repeat(53), { automatic: true }).skipped, true);
});

test('content extraction excludes images, joins text blocks, and counts attachment text normally', t => {
  const index = open(t);
  assert.equal(extractText('  网关\n '), '  网关\n ');
  const blocks = [
    { type: 'image', data: 'x'.repeat(500), text: 'gateway' },
    { type: 'text', text: 'youer' },
    { type: 'thinking', text: 'gateway' },
    { type: 'text', text: 'vm' },
    { type: 'text', text: 42 }, null,
  ];
  assert.equal(extractText(blocks), 'youer\nvm');
  assert.equal(weightedLength(extractText(blocks)), 8);
  assert.deepEqual(ids(index.search(blocks, { automatic: true })).sort(), ['e', 'g']);
  const imageOnly = index.search([{ type: 'image', data: 'x'.repeat(500), text: 'gateway' }], { automatic: true });
  assert.deepEqual(imageOnly, { skipped: false, total: 0, results: [], queryTerms: [] });
  assert.equal(extractText(undefined), '');
  const attachment = [
    { type: 'text', text: 'gateway' },
    { type: 'text', text: '[attachment]\n' + 'x'.repeat(189) },
  ];
  assert.equal(weightedLength(extractText(attachment)), 210);
  assert.deepEqual(ids(index.search(attachment, { automatic: true })).sort(), ['i', 'j']);
  attachment[1].text += '!';
  assert.equal(weightedLength(extractText(attachment)), 211);
  assert.equal(index.search(attachment, { automatic: true }).skipped, true);
});

test('manual concepts retrieve Chinese surface forms and alternatives', t => {
  const index = open(t, [
    { id: 'gateway', text: '网关' }, { id: 'restart', text: '重启' },
    { id: 'country', text: '中华人民共和国' },
  ]);
  assert.deepEqual(ids(index.search({ concepts: [['网关', '重启']] })).sort(), ['gateway', 'restart']);
  assert.deepEqual(ids(index.search({ concepts: [['中华人民']] })), ['country']);
});

test('manual case folding preserves complete ranking, recency and optional limit', t => {
  const docs = Array.from({ length: 25 }, (_, i) => ({ id: String(i).padStart(2, '0'), text: `Gateway color${String(i).padStart(2, '0')}` }));
  const index = open(t, docs.reverse());
  const full = index.search({ concepts: [['GATEWAY']] }, { limit: docs.length });
  assert.deepEqual(full, index.search({ concepts: [['gateway']] }, { limit: docs.length }));
  assert.equal(full.total, 25);
  assert.deepEqual(ids(full), docs.map(d => d.id).reverse());
  assert.deepEqual(index.search({ concepts: [['gateway']] }, { limit: 1 }).results, full.results.slice(0, 1));
  assert.deepEqual(index.search({ concepts: [['gateway']] }, { limit: 0 }).results, []);
  assert.deepEqual(index.search({ concepts: [[' '.repeat(211) + 'gateway']] }, { limit: docs.length }), full);
  assert.equal(index.search({ concepts: [['gateway']], exclude: ['gateway'] }).total, 0);
  assert.throws(() => index.search({ concepts: [['gateway']] }, { limit: -1 }), RangeError);
});

test('manual concepts and validation do not alter automatic query selection', t => {
  const index = open(t);
  const queries = ['网关重启后为什么断连？', 'gateway nonexistentword', 'vm NOT kvm', '', 'gateway' + ' '.repeat(204)];
  const before = queries.map(query => index.search(query, { automatic: true }));
  const manual = index.search({ concepts: [['gateway']] });
  assert.equal(manual.total, 2);
  index.search({ concepts: [['网关'], ['gateway']] });
  assert.throws(() => index.search({ concepts: [] }), { name: 'QueryError', code: 'INVALID_ARRAY' });
  assert.deepEqual(queries.map(query => index.search(query, { automatic: true })), before);
});

test('all concepts retain indexed stopwords as required terms', t => {
  const index = open(t, [
    { id: 'with-where', text: 'Sophia met at a coffee shop where the city lights shine' },
    { id: 'without-where', text: 'Sophia met at a coffee shop under the city lights' },
  ]);
  assert.deepEqual(ids(index.search({ concepts: [['Sophia'], ['coffee shop'], ['city'], ['where met']], match: 'all' })), ['with-where']);
  assert.deepEqual(ids(index.search({ concepts: [['WHERE']] })), ['with-where']);
  assert.deepEqual(ids(index.search({ concepts: [['where the city']] })), ['with-where']);
});

test('manual concepts retain both automatic stopword groups', t => {
  const words = ('a an and are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our please so than that the their them then there these they this to us was we were what when where which who why will with would you your ' +
    'please tell help about find show recall remember previous earlier history').split(/\s+/);
  const index = open(t, [
    { id: 'all-words', text: 'needle ' + words.join(' ') },
    { id: 'no-stopwords', text: 'needle' },
  ]);
  for (const word of new Set(words)) {
    if (word.length < 2) continue; // Mainline drops single-character terms, not only stopwords.
    assert.deepEqual(ids(index.search({ concepts: [['needle'], [word]], match: 'all' })), ['all-words'], word);
  }
});

test('automatic queries still filter stopwords while documents retain them', t => {
  const words = 'where history find please tell help about show recall remember previous earlier';
  const index = open(t, [
    { id: 'gateway', text: 'gateway ' + words },
    { id: 'stopwords-only', text: words },
  ]);
  const automatic = index.search(words + ' GATEWAY gateway', { automatic: true });
  assert.deepEqual(automatic, index.search('gateway', { automatic: true }));
  assert.deepEqual(automatic.queryTerms, ['gateway']);
  assert.deepEqual(ids(automatic), ['gateway']);
  assert.deepEqual(index.search(words, { automatic: true }),
    { skipped: false, total: 0, results: [], queryTerms: [] });
  assert.deepEqual(ids(index.search({ concepts: [['history']] })).sort(), ['gateway', 'stopwords-only']);
});



const booleanDocuments = [
  { id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }, { id: 'c', text: 'gamma' },
  { id: 'ab', text: 'alpha beta' }, { id: 'bc', text: 'beta gamma' },
  { id: 'abc', text: 'alpha beta gamma' },
];

test('any, all, alternatives and hard exclusions operate within one record', t => {
  const index = open(t, booleanDocuments);
  for (const [query, expected] of [
    [{ concepts: [['alpha'], ['beta']] }, ['a', 'ab', 'abc', 'b', 'bc']],
    [{ concepts: [['alpha'], ['beta']], match: 'all' }, ['ab', 'abc']],
    [{ concepts: [['alpha']], exclude: ['beta', 'gamma'] }, ['a']],
    [{ concepts: [['alpha', 'beta'], ['gamma']], match: 'all' }, ['abc', 'bc']],
    [{ concepts: [['alpha', 'beta']], exclude: ['gamma'] }, ['a', 'ab', 'b']],
    [{ concepts: [['alpha'], ['beta'], ['gamma']] }, ['a', 'ab', 'abc', 'b', 'bc', 'c']],
    [{ concepts: [['alpha'], ['beta', 'gamma']], match: 'all' }, ['ab', 'abc']],
    [{ concepts: [['beta alpha']] }, ['ab', 'abc']],
  ]) assert.deepEqual(ids(index.search(query)).sort(), expected);
});



test('automatic selection and its gate remain separate from manual concepts', t => {
  const index = open(t, booleanDocuments);
  const automatic = index.search('alpha AND beta', { automatic: true });
  assert.deepEqual(automatic.queryTerms, ['alpha', 'beta']);
  assert.deepEqual(ids(automatic).sort(), ['a', 'ab', 'abc', 'b', 'bc']);
  assert.deepEqual(automatic, index.search('alpha beta', { automatic: true }));
  assert.deepEqual(ids(index.search({ concepts: [['alpha'], ['beta']], match: 'all' })).sort(), ['ab', 'abc']);
  const long = 'alpha beta' + ' '.repeat(211);
  assert.equal(index.search(long, { automatic: true }).skipped, true);
  assert.deepEqual(ids(index.search({ concepts: [['alpha' + ' '.repeat(211)], ['beta']] })).sort(), ['a', 'ab', 'abc', 'b', 'bc']);
});
