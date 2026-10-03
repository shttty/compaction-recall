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

test('Han spans merge bigrams and dictionary words in position/short-span order, preserving frequency', () => {
  assert.deepEqual(tokenize('中华人民共和国'), ['中华', '华人', '人民', '民共', '共和', '共和国', '和国']);
  assert.deepEqual(tokenize('搜索 搜索 网关网关'), ['搜索', '搜索', '网关', '关网', '网关']);
  assert.deepEqual(tokenize('网，关。网!关\n网 关'), []);
  assert.deepEqual(tokenize('𠀀𠀁𠀂'), ['𠀀𠀁', '𠀁𠀂']);
  assert.deepEqual(tokenize('我们 可以 是否'), ['我们', '可以', '是否']);
});

test('ASCII identifiers stay whole and lowercase next to Han; English stopwords alone are removed', () => {
  assert.deepEqual(tokenize('修改youer服务端配置').filter(term => /^[a-z0-9_]+$/.test(term)), ['youer']);
  assert.deepEqual(tokenize('CompactionResult foo_BAR foo_BAR vm kvm 42 x _ THE please'),
    ['compactionresult', 'foo_bar', 'foo_bar', 'vm', 'kvm', '42', 'x', '_']);
  assert.deepEqual(tokenize('a an and are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our please so than that the their them then there these they this to us was we were what when where which who why will with would you your tell help about find show recall remember previous earlier history'), []);
});

test('shared synthetic examples use exact OR candidates, including natural questions with missing terms', t => {
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
    ['compaction', []], ['CompactionResult', ['f']],
    ['moto', []], ['motorcycle', ['l']],
    ['gatway', []], ['gateway', ['i', 'j']],
    ['gateway nonexistentword', ['i', 'j']],
    ['网关 不存在的词', ['a', 'b']],
    ['网', []], ['', []], ['the AND is please recall', []],
  ]) {
    const result = index.search(query);
    assert.equal(result.skipped, false, query);
    assert.equal(result.total, expected.length, query);
    assert.deepEqual(ids(result).sort(), expected, query);
    assert.ok(result.results.every(hit => Number.isFinite(hit.score) && hit.score < 0), query);
  }
  assert.deepEqual(index.search('gateway gateway GATEWAY'), index.search('gateway'));
});

test('bigrams cross dictionary boundaries but never punctuation; dictionary words share the same index', t => {
  const index = open(t, [
    { id: 'joined', text: '搜索引擎' },
    { id: 'punctuated', text: '搜索，引擎' },
    { id: 'country', text: '中华人民共和国' },
    { id: 'astral', text: '𠀀𠀁𠀂' },
  ]);
  assert.deepEqual(ids(index.search('索引')), ['joined']);
  assert.deepEqual(ids(index.search('共和国')), ['country']);
  assert.ok(index.search('共和国').queryTerms.includes('共和国'));
  assert.deepEqual(ids(index.search('𠀀𠀁')), ['astral']);
  assert.deepEqual(ids(index.search('𠀀')), []);
});

test('FTS keeps underscores, single ASCII tokens and whole identifiers without prefix or substring fallbacks', t => {
  const index = open(t, [
    { id: 'identifier', text: 'foo_bar CompactionResult 42 x _' },
    { id: 'split', text: 'foo bar compaction result 4 2' },
  ]);
  for (const query of ['FOO_BAR', 'CompactionResult', '42', 'x', '_']) {
    assert.deepEqual(ids(index.search(query)), ['identifier'], query);
  }
  for (const query of ['foo', 'bar', 'compaction', 'result', '4', '2']) {
    assert.deepEqual(ids(index.search(query)), ['split'], query);
  }
  assert.deepEqual(ids(index.search('comp*')), []);
  assert.deepEqual(ids(index.search('foo_b')), []);
});

test('MATCH-looking input is bound as quoted OR terms, not interpreted as operators or SQL', t => {
  const index = open(t, [
    { id: 'vm', text: 'vm' },
    { id: 'kvm', text: 'kvm' },
    { id: 'operators', text: 'NEAR NOT' },
  ]);
  assert.deepEqual(ids(index.search('vm NOT kvm')).sort(), ['kvm', 'operators', 'vm']);
  assert.deepEqual(ids(index.search('NEAR("vm", "kvm")')).sort(), ['kvm', 'operators', 'vm']);
  assert.deepEqual(ids(index.search('\"); DROP TABLE terms; --')), []);
  assert.deepEqual(ids(index.search('vm')), ['vm']);
  assert.deepEqual(index.search('"*():+-'), { skipped: false, total: 0, results: [], queryTerms: [] });
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
    const frequency = index.search(term);
    assert.deepEqual(ids(frequency), ['z-frequent', 'a-once']);
    assert.ok(frequency.results[0].score < frequency.results[1].score);
    const length = index.search('needle');
    assert.deepEqual(ids(length), ['short', 'long']);
    assert.ok(length.results[0].score < length.results[1].score);
  }
});

test('ties use id order, and total counts all candidates even at zero/one result limits', t => {
  const index = open(t, [
    { id: 'z', text: 'gateway' }, { id: 'a', text: 'gateway' }, { id: 'A', text: 'gateway' },
  ]);
  assert.deepEqual(ids(index.search('gateway')), ['A', 'a', 'z']);
  const limited = index.search('gateway', { limit: 1 });
  assert.equal(limited.total, 3);
  assert.deepEqual(ids(limited), ['A']);
  const zero = index.search('gateway', { limit: 0 });
  assert.equal(zero.total, 3);
  assert.deepEqual(zero.results, []);
  assert.throws(() => index.search('gateway', { limit: -1 }), RangeError);
  assert.equal(open(t, []).search('gateway').total, 0);
  assert.equal(open(t, [{ id: 'empty', text: '' }]).search('gateway').total, 0);
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
  assert.deepEqual(ids(index.search(long)).sort(), ['i', 'j']);
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
  assert.deepEqual(ids(index.search(attachment)).sort(), ['i', 'j']);
});
