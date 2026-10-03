import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex, extractText, tokenize, weightedLength } from '../prototype/soft-match-minisearch/index.mjs';
import { documents } from '../prototype/soft-match-minisearch/demo.mjs';

function fixture(t, docs = documents) {
  const index = createIndex(docs);
  t.after(() => index.close());
  return index;
}
const ids = response => response.results.map(result => result.id).sort();

test('Han words and adjacent bigrams share terms, ordered by position then span', () => {
  assert.deepEqual(tokenize('为什么，独角兽'), ['为什', '为什么', '什么', '独角', '独角兽', '角兽']);
  assert.deepEqual(tokenize('网关，网关'), ['网关', '网关']);
  assert.deepEqual(tokenize('独角兽 独角兽'), ['独角', '独角兽', '角兽', '独角', '独角兽', '角兽']);
  assert.deepEqual(tokenize('网，关'), []);
  assert.deepEqual(tokenize('𠀀网关'), ['𠀀网', '网关']);
});

test('English identifiers stay whole; Han adjacency and only English stopwords apply', () => {
  assert.deepEqual(tokenize('修改youer服务端配置。'), ['修改', 'youer', '服务', '务端', '端配', '配置']);
  assert.deepEqual(tokenize('CompactionResult camelCase snake_case HTTPServer X 7 _ $THE'),
    ['compactionresult', 'camelcase', 'snake_case', 'httpserver', 'x', '7', '_']);
  assert.deepEqual(tokenize('我们，之前，什么'), ['我们', '之前', '什么']);
  assert.deepEqual(tokenize('What time do I stop checking work emails and messages?'),
    ['time', 'stop', 'checking', 'work', 'emails', 'messages']);
});

test('extractText keeps only text blocks, in order, with newline separators', () => {
  assert.equal(extractText('  网关\n'), '  网关\n');
  assert.equal(extractText([
    { type: 'text', text: '网' }, { type: 'image', text: 'hidden', data: 'hidden' },
    { type: 'thinking', text: 'hidden' }, { type: 'text', text: '关' },
    { type: 'text', text: '' }, null,
  ]), '网\n关\n');
  assert.equal(extractText([{ type: 'image', text: 'gateway' }]), '');
  assert.equal(extractText(null), '');
});

test('weightedLength counts code points, including whitespace and punctuation', () => {
  assert.equal(weightedLength(''), 0);
  assert.equal(weightedLength('𠀀😀A， \n'), 7);
  assert.equal(weightedLength('GPU集群'), 7);
});

const expectedSearches = [
  ['网关重启后为什么断连？', ['a', 'b']],
  ['网关', ['a', 'b']],
  ['索引', ['d']],
  ['youer', ['e']],
  ['What time do I stop checking work emails and messages?', ['k']],
  ['vm', ['g']],
  ['kvm', ['g', 'h']],
  ['compaction', ['f']],
  ['CompactionResult', ['f']],
  ['result', []],
  ['moto', ['l']],
  ['motorcycle', ['l']],
  ['gatway', ['i', 'j']],
  ['gateway', ['i', 'j']],
  ['gateway qzxwvvnonexistent', ['i', 'j']],
  ['网关火星独角兽', ['a', 'b']],
  ['GPU集群', ['m']],
  ['gpt', ['m']],
];
for (const [query, expected] of expectedSearches) {
  test(`native OR/prefix/fuzzy: ${query}`, t => {
    const response = fixture(t).search(query);
    assert.equal(response.skipped, false);
    assert.deepEqual(ids(response), expected);
    assert.equal(response.total, expected.length);
    for (const result of response.results) {
      assert.ok(Number.isFinite(result.score) && result.score > 0);
      assert.equal(Object.hasOwn(result, 'text'), false);
    }
  });
}

test('索引 matches the adjacent bigram inside 搜索引擎, not just a later explicit 索引', t => {
  const index = fixture(t, [{ id: 'cross-word', text: '搜索引擎' }]);
  assert.deepEqual(tokenize('搜索引擎'), ['搜索', '索引', '引擎']);
  assert.deepEqual(ids(index.search('索引')), ['cross-word']);
});

test('three-Han word fuzzy matching can hit a two-Han non-adjacent deletion', t => {
  const index = fixture(t, [{ id: 'risk', text: '独兽' }]);
  const response = index.search('独角兽');
  assert.deepEqual(ids(response), ['risk']);
  assert.deepEqual(response.results[0].terms, ['独兽']);
  assert.deepEqual(response.results[0].queryTerms, ['独角兽']);
  assert.deepEqual(ids(index.search('独角')), []);
});

test('empty, all-stopword, single-Han and image-only queries return normal empty results', t => {
  const index = fixture(t);
  for (const query of ['', '网', '𠀀', 'the AND is please', '!?', [{ type: 'image', data: 'gateway' }]]) {
    assert.deepEqual(index.search(query, { automatic: true }),
      { skipped: false, total: 0, results: [], queryTerms: [] });
  }
});

test('query repetition is deduplicated without changing scores', t => {
  const index = fixture(t);
  assert.deepEqual(index.search('gateway gateway gateway'), index.search('gateway'));
  assert.deepEqual(index.search('网关，网关'), index.search('网关'));
});

test('real document term frequency affects native BM25+ score', t => {
  const index = fixture(t, [
    { id: 'single', text: '网关' },
    { id: 'repeat', text: '网关 网关 网关' },
  ]);
  const { results } = index.search('网关');
  assert.deepEqual(results.map(result => result.id), ['repeat', 'single']);
  assert.ok(results[0].score > results[1].score);
});

test('total counts all candidates before limit and ties use id, not insertion order', t => {
  const docs = Array.from({ length: 25 }, (_, i) => ({ id: String(24 - i).padStart(2, '0'), text: 'gateway' }));
  const index = fixture(t, docs);
  const response = index.search('gateway');
  assert.equal(response.total, 25);
  assert.deepEqual(response.results.map(result => result.id), Array.from({ length: 20 }, (_, i) => String(i).padStart(2, '0')));
  const limited = index.search('gateway', { limit: 1 });
  assert.equal(limited.total, 25);
  assert.deepEqual(ids(limited), ['00']);
  const zero = index.search('gateway', { limit: 0 });
  assert.equal(zero.total, 25);
  assert.deepEqual(zero.results, []);
});

for (const [name, atBoundary, overBoundary, expected] of [
  ['ASCII', 'gateway' + ' '.repeat(203), 'gateway' + ' '.repeat(204), ['i', 'j']],
  ['Han', '网关' + '汉'.repeat(103), '网关' + '汉'.repeat(104), ['a', 'b']],
  ['mixed', '网关gateway' + ' '.repeat(199), '网关gateway' + ' '.repeat(200), ['a', 'b', 'i', 'j']],
]) {
  test(`${name}: automatic accepts weight 210, skips greater; active remains unrestricted`, t => {
    const index = fixture(t);
    assert.equal(weightedLength(atBoundary), 210);
    assert.ok(weightedLength(overBoundary) > 210);
    const accepted = index.search(atBoundary, { automatic: true });
    assert.equal(accepted.skipped, false);
    assert.deepEqual(ids(accepted), expected);
    assert.deepEqual(index.search(overBoundary, { automatic: true }), { skipped: true, total: 0, results: [] });
    const active = index.search(overBoundary);
    assert.equal(active.skipped, false);
    assert.deepEqual(ids(active), expected);
  });
}

test('automatic gate precedes stopword filtering and query deduplication', t => {
  const index = fixture(t);
  for (const query of ['the '.repeat(53), 'gateway '.repeat(27), ' '.repeat(211), '网'.repeat(106)]) {
    assert.deepEqual(index.search(query, { automatic: true }), { skipped: true, total: 0, results: [] });
  }
  assert.deepEqual(ids(index.search(' '.repeat(211) + 'gateway')), ['i', 'j']);
});

test('image blocks are excluded; joined newlines and attachment text count at the gate', t => {
  const index = fixture(t);
  const image = { type: 'image', text: 'x'.repeat(1000), data: 'x'.repeat(1000) };
  const blocks = [image, { type: 'text', text: 'gateway' }, { type: 'text', text: ' '.repeat(202) }];
  assert.equal(weightedLength(extractText(blocks)), 210);
  assert.deepEqual(ids(index.search(blocks, { automatic: true })), ['i', 'j']);
  const over = [...blocks, { type: 'text', text: '' }];
  assert.equal(weightedLength(extractText(over)), 211);
  assert.deepEqual(index.search(over, { automatic: true }), { skipped: true, total: 0, results: [] });
  const attachment = [{ type: 'text', text: 'gateway\n[attachment]\n' + 'x'.repeat(211) }];
  assert.equal(weightedLength(extractText(attachment)), 232);
  assert.deepEqual(index.search(attachment, { automatic: true }), { skipped: true, total: 0, results: [] });
  assert.deepEqual(ids(index.search(attachment)), ['i', 'j']);
});

test('close is idempotent and prevents later use; empty indexes return no candidates', t => {
  const index = fixture(t, []);
  assert.deepEqual(index.search('gateway'), { skipped: false, total: 0, results: [], queryTerms: ['gateway'] });
  index.close();
  index.close();
  assert.throws(() => index.search('gateway'), /Index is closed/);
});
