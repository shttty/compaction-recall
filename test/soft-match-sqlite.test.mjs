import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createIndex, extractText, implicitOr, tokenize, weightedLength } from '../prototype/soft-match-sqlite/index.mjs';
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

test('ASCII identifiers keep whole terms and aligned components next to Han', () => {
  assert.deepEqual(tokenize('修改youer服务端配置').filter(term => /^[a-z0-9_]+$/.test(term)), ['youer']);
  assert.deepEqual(tokenize('CompactionResult foo_BAR foo_BAR vm kvm 42 x _'),
    ['compactionresult', 'compaction', 'result', 'foo_bar', 'foo', 'bar', 'foo_bar', 'foo', 'bar', 'vm', 'kvm', '42']);
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
    ['compaction', ['f']], ['CompactionResult', ['f']],
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

test('FTS identifier components match while single-character terms and automatic prefixes do not', t => {
  const index = open(t, [
    { id: 'identifier', text: 'foo_bar CompactionResult 42 x _' },
    { id: 'split', text: 'foo bar compaction result 4 2' },
  ]);
  for (const query of ['foo', 'bar', 'compaction', 'result']) {
    assert.deepEqual(ids(index.search(query)).sort(), ['identifier', 'split'], query);
  }
  assert.deepEqual(ids(index.search('42')), ['identifier']);
  assert.deepEqual(ids(index.searchRaw('FOO_BAR')), ['identifier']);
  assert.deepEqual(ids(index.search('foo_b')).sort(), ['identifier', 'split']);
  assert.deepEqual(ids(index.searchRaw('foo_b')), []);
  for (const query of ['x', '_', '4', '2', 'comp*']) {
    assert.deepEqual(ids(index.search(query)), [], query);
  }
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

test('raw FTS5 executes Chinese bigram OR and dictionary terms without automatic query selection', t => {
  const index = open(t, [
    { id: 'gateway', text: '网关' }, { id: 'restart', text: '重启' },
    { id: 'country', text: '中华人民共和国' },
  ]);
  assert.deepEqual(ids(index.searchRaw('网关 OR 重启')).sort(), ['gateway', 'restart']);
  assert.deepEqual(ids(index.searchRaw('共和国')), ['country']);
  assert.deepEqual(ids(index.searchRaw('中华人民')), []);
  assert.deepEqual(ids(index.searchRaw('网关 重启')).sort(), ['gateway', 'restart']);
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

test('SDK-loaded SQLite recall description matches the frozen document bytes', async t => {
  const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
  const document = readFileSync(new URL('../doc/SOFT_MATCH_PROMPTS.md', import.meta.url), 'utf8');
  const section = document.slice(document.indexOf('## ① '), document.indexOf('## ② '));
  const expected = section.match(/\n```\n([\s\S]*?)\n```/)[1];
  const loaded = await discoverAndLoadExtensions(
    [fileURLToPath(new URL('../benchmark/retrieval-sqlite-adapter.ts', import.meta.url))],
    process.cwd(), process.env.PI_CODING_AGENT_DIR,
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  t.after(async () => {
    for (const handler of extension.handlers.get('session_shutdown') ?? []) {
      await handler({ type: 'session_shutdown', reason: 'quit' }, {});
    }
  });
  const actual = extension.tools.get('history_recall').definition.description;
  assert.deepEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
  const schema = extension.tools.get('history_recall').definition.parameters;
  for (const parameter of ['query', 'limit', 'offset']) {
    const expectedParameter = section.match(new RegExp('- `' + parameter + '`：([^\\n]+)'))[1];
    assert.deepEqual(Buffer.from(schema.properties[parameter].description, 'utf8'), Buffer.from(expectedParameter, 'utf8'));
  }
});

test('implicitOr preserves tokens and whitespace while replacing native implicit connectors deterministically', () => {
  for (const [query, expected] of [
    ['alpha beta gamma', '(alpha OR beta OR gamma)'],
    [' 网关\tGateway \n重启 ', ' (网关\tOR Gateway \nOR 重启) '],
    ['alpha OR beta', 'alpha OR beta'],
    ['alpha AND beta gamma', 'alpha AND (beta OR gamma)'],
    ['alpha beta NOT gamma delta', '(alpha OR beta) NOT (gamma OR delta)'],
    ['alpha "beta gamma"', '(alpha OR "beta gamma")'],
    ['"alpha""beta gamma" delta', '("alpha""beta gamma" OR delta)'],
    ['alpha + "beta gamma" delta', '(alpha + "beta gamma" OR delta)'],
    ['(alpha beta) AND gamma', '((alpha OR beta)) AND gamma'],
    ['alpha AND (beta gamma)', 'alpha AND ((beta OR gamma))'],
    ['NEAR(alpha beta, 3) gamma', '(NEAR(alpha beta, 3) OR gamma)'],
    ['alpha NEAR ("beta gamma" delta, 2)', '(alpha OR NEAR ("beta gamma" delta, 2))'],
    ['NEAR alpha', '(NEAR OR alpha)'],
    ['tokens:alpha beta', '(tokens:alpha OR beta)'],
    ['- {tokens other} : alpha beta', '(- {tokens other} : alpha OR beta)'],
    ['{tokens other}: (alpha beta)', '{tokens other}: ((alpha OR beta))'],
    ['tokens:^alp* beta', '(tokens:^alp* OR beta)'],
    ['^"alpha beta" gamma', '(^"alpha beta" OR gamma)'],
    ['alpha"beta"', '(alpha OR "beta")'],
    ['alpha\u00a0beta', 'alpha\u00a0beta'],
    ['alpha\fbeta', 'alpha\fbeta'],
    ['alpha "beta', 'alpha "beta'],
    ['', ''], [' \t\r\n', ' \t\r\n'],
  ]) {
    assert.equal(implicitOr(query), expected, query);
    assert.equal(implicitOr(expected), expected, query);
  }
});

const booleanDocuments = [
  { id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }, { id: 'c', text: 'gamma' },
  { id: 'ab', text: 'alpha beta' }, { id: 'bc', text: 'beta gamma' },
  { id: 'abc', text: 'alpha beta gamma' },
];

test('raw implicit OR retains explicit AND/NOT precedence and parentheses', t => {
  const index = open(t, booleanDocuments);
  for (const [query, expected] of [
    ['alpha beta', ['a', 'ab', 'abc', 'b', 'bc']],
    ['alpha AND beta', ['ab', 'abc']],
    ['alpha NOT beta gamma', ['a']],
    ['alpha beta AND gamma', ['abc', 'bc']],
    ['alpha beta NOT gamma', ['a', 'ab', 'b']],
    ['alpha OR beta gamma', ['a', 'ab', 'abc', 'b', 'bc', 'c']],
    ['(alpha beta) AND gamma', ['abc', 'bc']],
    ['alpha AND (beta gamma)', ['ab', 'abc']],
  ]) assert.deepEqual(ids(index.searchRaw(query)).sort(), expected, query);
  assert.throws(() => index.searchRaw('(alpha OR beta) gamma'), /syntax error/);
  assert.throws(() => index.searchRaw('alpha (beta gamma)'), /syntax error/);
});

test('raw phrases, phrase concatenation, NEAR, prefix and initial-token constraints remain native', t => {
  const index = open(t, booleanDocuments);
  for (const [query, expected] of [
    ['"alpha beta"', ['ab', 'abc']],
    ['"alpha beta" gamma', ['ab', 'abc', 'bc', 'c']],
    ['alpha + beta gamma', ['ab', 'abc', 'bc', 'c']],
    ['NEAR(alpha beta, 0)', ['ab', 'abc']],
    ['NEAR(alpha beta, 0) gamma', ['ab', 'abc', 'bc', 'c']],
    ['alp* gam*', ['a', 'ab', 'abc', 'bc', 'c']],
    ['^beta alpha', ['a', 'ab', 'abc', 'b', 'bc']],
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
    ['title:alpha beta', [1, 2, 3]],
    ['title:(alpha beta)', [1, 3]],
    ['{title body}:alpha beta', [1, 2, 3, 4]],
    ['- {body}:alpha beta', [1, 2, 3]],
    ['- {body}:(alpha beta)', [1, 3]],
    ['title:(body:alpha beta)', [3]],
    ['title:^alpha beta', [1, 2, 3]],
  ]) assert.deepEqual(native.all(implicitOr(query)).map(row => row.rowid), expected, query);
});

test('errors from rewritten malformed expressions propagate the executed SQLite message unchanged', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE VIRTUAL TABLE terms USING fts5(tokens)');
  const native = db.prepare('SELECT rowid FROM terms WHERE terms MATCH ?');
  const index = open(t, booleanDocuments);
  const query = 'alpha beta + ^gamma';
  const expression = implicitOr(query);
  assert.equal(expression, '(alpha OR beta) + ^gamma');
  let originalError, executedError;
  try { native.all(query); } catch (error) { originalError = error; }
  try { native.all(expression); } catch (error) { executedError = error; }
  assert.notEqual(executedError.message, originalError.message);
  assert.throws(() => index.searchRaw(query), error => {
    assert.equal(error.message, executedError.message);
    assert.equal(error.code, executedError.code);
    assert.equal(error.errcode, executedError.errcode);
    return true;
  });
});

test('automatic query selection and its 210 gate remain separate from raw implicit OR', t => {
  const index = open(t, booleanDocuments);
  const automatic = index.search('alpha AND beta', { automatic: true });
  assert.deepEqual(automatic.queryTerms, ['alpha', 'beta']);
  assert.deepEqual(ids(automatic).sort(), ['a', 'ab', 'abc', 'b', 'bc']);
  assert.deepEqual(automatic, index.search('alpha beta', { automatic: true }));
  assert.deepEqual(ids(index.searchRaw('alpha AND beta')).sort(), ['ab', 'abc']);
  const long = 'alpha beta' + ' '.repeat(211);
  assert.equal(index.search(long, { automatic: true }).skipped, true);
  assert.deepEqual(ids(index.searchRaw(long)).sort(), ['a', 'ab', 'abc', 'b', 'bc']);
});
