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

test('indexed Han phrases retain repeats and never bridge Han run boundaries', t => {
  const index = open(t, [
    { id: 'whole', text: '中华人民共和国 哈哈哈 𠀀𠀁𠀂' },
    { id: 'split', text: '共和 和国 哈哈 哈哈 𠀀𠀁 𠀁𠀂' },
  ]);
  assert.deepEqual(ids(index.searchRaw('共和国')), []);
  assert.deepEqual(ids(index.searchRaw('"共和 和国"')), ['whole']);
  assert.deepEqual(ids(index.searchRaw('"哈哈 哈哈"')), ['whole']);
  assert.deepEqual(ids(index.searchRaw('"𠀀𠀁 𠀁𠀂"')), ['whole']);
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
  assert.deepEqual(ids(index.search('索引')), ['joined']);
  assert.deepEqual(ids(index.search('"共和 和国"')), ['country']);
  assert.deepEqual(ids(index.search('𠀀𠀁')), ['astral']);
  assert.deepEqual(ids(index.search('𠀀')), []);
});

test('FTS identifier components match; single-character terms stay absent and native prefixes are explicit', t => {
  const index = open(t, [
    { id: 'identifier', text: 'foo_bar CompactionResult 42 x _' },
    { id: 'split', text: 'foo bar compaction result 4 2' },
  ]);
  for (const query of ['foo', 'bar', 'compaction', 'result']) {
    assert.deepEqual(ids(index.search(query)).sort(), ['identifier', 'split'], query);
  }
  assert.deepEqual(ids(index.search('42')), ['identifier']);
  assert.deepEqual(ids(index.searchRaw('FOO_BAR')).sort(), ['identifier', 'split']);
  assert.deepEqual(ids(index.searchRaw('CompactionResult')), []);
  assert.deepEqual(ids(index.searchRaw('foo_b')), []);
  for (const query of ['x', '_', '4', '2']) {
    assert.deepEqual(ids(index.search(query)), [], query);
  }
  assert.deepEqual(ids(index.search('comp*')).sort(), ['identifier', 'split']);
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

test('ties prefer newest distinct snippets and limits apply after snippet deduplication', t => {
  const index = open(t, [
    { id: 'z', text: 'gateway red' }, { id: 'a', text: 'gateway blue' }, { id: 'A', text: 'gateway green' },
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
  assert.deepEqual(ids(index.search('gateway' + ' '.repeat(long.length))).sort(), ['i', 'j']);
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

test('raw FTS5 executes explicit Chinese bigram OR and phrases', t => {
  const index = open(t, [
    { id: 'gateway', text: '网关' }, { id: 'restart', text: '重启' },
    { id: 'country', text: '中华人民共和国' },
  ]);
  assert.deepEqual(ids(index.searchRaw('网关 OR 重启')).sort(), ['gateway', 'restart']);
  assert.deepEqual(ids(index.searchRaw('"共和 和国"')), ['country']);
  assert.deepEqual(ids(index.searchRaw('中华人民')), []);
  assert.throws(() => index.searchRaw('网关 重启'));
});

test('raw FTS5 preserves case semantics, operators, full ranking, ties and optional prefix limit', t => {
  const docs = Array.from({ length: 25 }, (_, i) => ({ id: String(i).padStart(2, '0'), text: `Gateway color${String(i).padStart(2, '0')}` }));
  const index = open(t, docs.reverse());
  const full = index.searchRaw('GATEWAY');
  assert.deepEqual(full, index.searchRaw('gateway'));
  assert.equal(full.total, 25);
  assert.deepEqual(ids(full), docs.map(d => d.id).reverse());
  assert.deepEqual(index.searchRaw('gateway', { limit: 1 }), { total: 25, results: full.results.slice(0, 1) });
  assert.deepEqual(index.searchRaw('gateway', { limit: 0 }), { total: 25, results: [] });
  assert.deepEqual(index.searchRaw(' '.repeat(211) + 'gateway'), full);
  assert.deepEqual(index.searchRaw('gateway NOT gateway'), { total: 0, results: [] });
  assert.throws(() => index.searchRaw('gateway', { limit: -1 }), RangeError);
});

test('raw malformed quotes and empty query expose unchanged native FTS5 errors', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE VIRTUAL TABLE terms USING fts5(tokens, tokenize=\"ascii tokenchars '_'\")");
  const native = db.prepare('SELECT rowid, bm25(terms) AS score FROM terms WHERE terms MATCH ?');
  const index = open(t);
  for (const query of ['"gateway', 'gateway "unterminated', '', ' \t\r\n']) {
    let expected;
    try { native.all(query); } catch (error) { expected = error; }
    assert.ok(expected);
    assert.throws(() => index.searchRaw(query), error => {
      assert.equal(error.message, expected.message);
      assert.equal(error.code, expected.code);
      assert.equal(error.errcode, expected.errcode);
      return true;
    });
  }
});

test('raw calls do not change existing automatic search results or query handling', t => {
  const index = open(t);
  const queries = ['网关重启后为什么断连？', 'gateway nonexistentword', 'vm NOT kvm', '', 'gateway' + ' '.repeat(204)];
  const before = queries.map(query => index.search(query, { automatic: true }));
  const legacy = index.search('gateway');
  assert.deepEqual(index.searchRaw('gateway'), { total: legacy.total, results: legacy.results });
  index.searchRaw('网关 OR gateway');
  assert.throws(() => index.searchRaw('"'));
  assert.deepEqual(queries.map(query => index.search(query, { automatic: true })), before);
});

test('raw explicit AND queries match indexed stopwords without dropping required terms', t => {
  const index = open(t, [
    { id: 'with-where', text: 'Sophia met at a coffee shop where the city lights shine' },
    { id: 'without-where', text: 'Sophia met at a coffee shop under the city lights' },
  ]);
  assert.deepEqual(ids(index.searchRaw('Sophia AND coffee AND shop AND city AND where AND met')), ['with-where']);
  assert.deepEqual(ids(index.searchRaw('WHERE')), ['with-where']);
  assert.deepEqual(ids(index.searchRaw('"where the city"')), ['with-where']);
});

test('raw lookup retains history, find and every word in both automatic stopword groups', t => {
  const words = ('a an and are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our please so than that the their them then there these they this to us was we were what when where which who why will with would you your ' +
    'please tell help about find show recall remember previous earlier history').split(/\s+/);
  const index = open(t, [
    { id: 'all-words', text: 'needle ' + words.join(' ') },
    { id: 'no-stopwords', text: 'needle' },
  ]);
  for (const word of new Set(words)) {
    if (word.length < 2) continue; // Mainline drops single-character terms, not only stopwords.
    assert.deepEqual(ids(index.searchRaw(`needle AND ${word}`)), ['all-words'], word);
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
  assert.deepEqual(ids(index.searchRaw('history')).sort(), ['gateway', 'stopwords-only']);
});



const booleanDocuments = [
  { id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }, { id: 'c', text: 'gamma' },
  { id: 'ab', text: 'alpha beta' }, { id: 'bc', text: 'beta gamma' },
  { id: 'abc', text: 'alpha beta gamma' },
];

test('raw explicit OR retains AND/NOT precedence and parentheses', t => {
  const index = open(t, booleanDocuments);
  for (const [query, expected] of [
    ['alpha OR beta', ['a', 'ab', 'abc', 'b', 'bc']],
    ['alpha AND beta', ['ab', 'abc']],
    ['alpha NOT (beta OR gamma)', ['a']],
    ['(alpha OR beta) AND gamma', ['abc', 'bc']],
    ['(alpha OR beta) NOT gamma', ['a', 'ab', 'b']],
    ['alpha OR beta OR gamma', ['a', 'ab', 'abc', 'b', 'bc', 'c']],
    ['alpha AND (beta OR gamma)', ['ab', 'abc']],
  ]) assert.deepEqual(ids(index.searchRaw(query)).sort(), expected, query);
  assert.throws(() => index.searchRaw('(alpha OR beta) gamma'));
  assert.throws(() => index.searchRaw('alpha (beta OR gamma)'));
});

test('raw phrases, phrase concatenation, NEAR, prefix and initial-token constraints remain native', t => {
  const index = open(t, booleanDocuments);
  for (const [query, expected] of [
    ['"alpha beta"', ['ab', 'abc']],
    ['"beta alpha"', []],
    ['"alpha beta" OR gamma', ['ab', 'abc', 'bc', 'c']],
    ['alpha + beta OR gamma', ['ab', 'abc', 'bc', 'c']],
    ['NEAR(alpha beta, 0)', ['ab', 'abc']],
    ['NEAR(alpha beta, 0) OR gamma', ['ab', 'abc', 'bc', 'c']],
    ['alp* OR gam*', ['a', 'ab', 'abc', 'bc', 'c']],
    ['^beta OR alpha', ['a', 'ab', 'abc', 'b', 'bc']],
    ['^beta AND alpha', []],
  ]) assert.deepEqual(ids(index.searchRaw(query)).sort(), expected, query);
});

test('column filters retain per-operand versus grouped scope, column sets and exclusions', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE VIRTUAL TABLE terms USING fts5(title, body);
    INSERT INTO terms(rowid,title,body) VALUES (1,'alpha','noise'),(2,'noise','beta'),
      (3,'beta','noise'),(4,'noise','alpha');`);
  const native = db.prepare('SELECT rowid FROM terms WHERE terms MATCH ? ORDER BY rowid');
  for (const [query, expected] of [
    ['title:alpha OR beta', [1, 2, 3]],
    ['title:(alpha OR beta)', [1, 3]],
    ['{title body}:alpha OR beta', [1, 2, 3, 4]],
    ['- {body}:alpha OR beta', [1, 2, 3]],
    ['- {body}:(alpha OR beta)', [1, 3]],
    ['title:(body:alpha OR beta)', [3]],
    ['title:^alpha OR beta', [1, 2, 3]],
  ]) assert.deepEqual(native.all(query).map(row => row.rowid), expected, query);
});


test('automatic query selection and its 210 gate remain separate from raw MATCH', t => {
  const index = open(t, booleanDocuments);
  const automatic = index.search('alpha AND beta', { automatic: true });
  assert.deepEqual(automatic.queryTerms, ['alpha', 'beta']);
  assert.deepEqual(ids(automatic).sort(), ['a', 'ab', 'abc', 'b', 'bc']);
  assert.deepEqual(automatic, index.search('alpha beta', { automatic: true }));
  assert.deepEqual(ids(index.searchRaw('alpha AND beta')).sort(), ['ab', 'abc']);
  const long = 'alpha beta' + ' '.repeat(211);
  assert.equal(index.search(long, { automatic: true }).skipped, true);
  assert.deepEqual(ids(index.searchRaw('alpha OR beta' + ' '.repeat(211))).sort(), ['a', 'ab', 'abc', 'b', 'bc']);
});
