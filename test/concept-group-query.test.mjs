import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { compileFts5, parseQuery, QueryError, LIMITS } from '../prototype/concept-group-query/original/query.ts';
import { analyzeQuery, compileQuery, createIndex } from '../prototype/concept-group-query/index.mjs';
import { createIndex as createPhraseIndex } from '../prototype/structured-tool-query/index.mjs';
import { createHanPhraseTrial } from '../prototype/soft-match-sqlite/han-phrase-trial.mjs';

const ids = result => result.results.map(row => row.id);
const sorted = result => ids(result).sort();
const q = (concepts, match) => ({ concepts, ...(match ? { match } : {}) });
const identity = s => [[s]];
function corpus(t, documents, create = createIndex) {
  const index = create(documents);
  t.after(() => index.close());
  return index;
}
function raw(t, rows) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE VIRTUAL TABLE terms USING fts5(tokens, content='', tokenize='ascii')");
  rows.forEach((tokens, i) => db.prepare('INSERT INTO terms(rowid,tokens) VALUES (?,?)').run(i + 1, tokens));
  return { db, search: plan => db.prepare('SELECT rowid, bm25(terms) AS score FROM terms WHERE terms MATCH ? ORDER BY score, rowid').all(plan.match) };
}
const errorCode = code => error => error instanceof QueryError && error.code === code;

test('alternatives OR within groups; default any unions groups; all requires one record', t => {
  const index = corpus(t, [
    { id: 'both', text: 'cedar harbor' }, { id: 'alternative', text: 'maple harbor' },
    { id: 'first', text: 'cedar inland' }, { id: 'second', text: 'willow harbor' },
    { id: 'neither', text: 'willow inland' },
  ]);
  const groups = [['cedar', 'maple'], ['harbor']];
  assert.deepEqual(sorted(index.search(q(groups))), ['alternative', 'both', 'first', 'second']);
  assert.deepEqual(index.search(q(groups)), index.search(q(groups, 'any')));
  assert.deepEqual(sorted(index.search(q(groups, 'all'))), ['alternative', 'both']);
});

test('all never joins different records or broadens a zero-hit query', t => {
  const index = corpus(t, [{ id: 'one', text: 'cedar' }, { id: 'two', text: 'harbor' }]);
  assert.deepEqual(index.search(q([['cedar'], ['harbor']], 'all')), { total: 0, limit: 20, results: [] });
});

test('exclusion is global hard removal, including relevant transition history', t => {
  const index = corpus(t, [{ id: 'keep', text: 'WireGuard enabled' },
    { id: 'transition', text: 'from OpenVPN switched to WireGuard' }, { id: 'other', text: 'OpenVPN enabled' }]);
  assert.deepEqual(sorted(index.search(q([['WireGuard']]))), ['keep', 'transition']);
  assert.deepEqual(ids(index.search({ concepts: [['WireGuard']], exclude: ['OpenVPN'] })), ['keep']);
  assert.equal(index.search({ concepts: [['WireGuard']], exclude: ['WireGuard'] }).total, 0);
});

test('exclusions use the same unordered co-occurrence analyzer as positives', t => {
  const index = corpus(t, [{ id: 'remove', text: 'cedar harbor winding maple' }, { id: 'keep', text: 'cedar harbor' }]);
  assert.deepEqual(ids(index.search({ concepts: [['cedar']], exclude: ['maple harbor'] })), ['keep']);
});

test('Han bigrams co-occur across barriers and in reversed order, unlike old phrases', t => {
  const docs = [{ id: 'adjacent', text: '共和国' }, { id: 'separated', text: '共和，和国' },
    { id: 'reversed', text: '和国，共和' }, { id: 'partial', text: '共和' }];
  const index = corpus(t, docs), phrase = corpus(t, docs, createPhraseIndex);
  assert.deepEqual(sorted(index.search(q([['共和国']]))), ['adjacent', 'reversed', 'separated']);
  assert.deepEqual(ids(phrase.search({ must: [{ any_of: ['共和国'] }] })), ['adjacent']);
});

test('actual adapter atoms are single configured FTS terms; barriers are index-only', t => {
  const { tokenizer } = createHanPhraseTrial('off');
  const text = '修改youer服务端配置 HTTPServer retry_delay 共和国 OR';
  const { db } = raw(t, [tokenizer.tokenize(text).join(' ')]);
  db.exec("CREATE VIRTUAL TABLE vocab USING fts5vocab(terms, 'row')");
  const vocabulary = new Set(db.prepare('SELECT term FROM vocab').all().map(row => row.term));
  assert(vocabulary.has('\ue000'));
  for (const atom of analyzeQuery(text).flat()) {
    assert(vocabulary.has(atom), atom);
    const isolated = raw(t, [atom]);
    isolated.db.exec("CREATE VIRTUAL TABLE vocab USING fts5vocab(terms, 'row')");
    assert.deepEqual(isolated.db.prepare('SELECT term FROM vocab').all().map(row => row.term), [atom]);
  }
  assert(!analyzeQuery(text).flat().includes('\ue000'));
  assert(!vocabulary.has('httpserver'));
  assert(!vocabulary.has('retry_delay'));
});

test('shared identifier analyzer requires split terms but not order or adjacency', t => {
  const index = corpus(t, [{ id: 'source', text: 'HTTPServer retry_delay' },
    { id: 'split', text: 'server winding http delay winding retry' }, { id: 'partial', text: 'http retry' }]);
  assert.deepEqual(sorted(index.search(q([['HTTPServer'], ['retry_delay']], 'all'))), ['source', 'split']);
});

test('compiler OR analysis paths support full OR split identifiers when both are indexed', t => {
  // Contract fixture only: these terms are supplied directly, not by the shared tokenizer.
  const index = raw(t, ['httpserver', 'http server', 'server gap http', 'http', 'server']);
  const plan = compileFts5(q([['HTTPServer']]), () => [['httpserver'], ['http', 'server']]);
  assert.deepEqual(index.search(plan).map(row => row.rowid).sort(), [1, 2, 3]);
});

test('zero-token surfaces fail but discarded single characters inside valid surfaces are tokenizer loss', t => {
  const index = corpus(t, [{ id: 'one', text: '雪松' }]);
  for (const s of ['中', 'C++', 'C#', 'a', '!!!', '\ue000']) {
    assert.deepEqual(analyzeQuery(s), []);
    assert.throws(() => index.search(q([[s]])), errorCode('EMPTY_ANALYSIS'));
    assert.throws(() => index.search({ concepts: [['雪松']], exclude: [s] }), errorCode('EMPTY_ANALYSIS'));
  }
  assert.deepEqual(index.search(q([['雪松 中 C++']])), index.search(q([['雪松']])));
});

test('literal operators, quotes, field and prefix syntax cannot inject a query', t => {
  const index = corpus(t, [{ id: 'literal', text: 'backup OR rollback say "hello" body foo' },
    { id: 'backup', text: 'backup' }, { id: 'rollback', text: 'rollback' }, { id: 'prefix', text: 'foobar' }]);
  for (const s of ['backup OR rollback', 'say "hello"', 'body:foo', 'foo*']) {
    assert.deepEqual(ids(index.search(q([[s]]))), ['literal']);
  }
  assert.equal(index.search(q([['absent" OR "backup']])).total, 0);
  const direct = raw(t, ['or', 'and', 'not', 'near']);
  assert.deepEqual(direct.search(compileFts5(q([['OR']]), identity)).map(row => row.rowid), [1]);
});

test('fixed result cap follows full BM25 sorting and stable rowid tie-break', t => {
  const docs = Array.from({ length: 25 }, (_, i) => ({ id: `row-${i}`, text: 'cedar harbor' }));
  const index = corpus(t, docs);
  const result = index.search(q([['cedar']]));
  assert.equal(result.total, 25);
  assert.equal(result.limit, 20);
  assert.deepEqual(ids(result), docs.slice(0, 20).map(d => d.id));
  assert.throws(() => index.search({ concepts: [['cedar']], limit: 3 }), errorCode('UNKNOWN_FIELD'));
});

test('BM25 is not concept-coverage-first ranking', t => {
  const index = corpus(t, [{ id: 'one-group', text: 'cedar' },
    { id: 'two-groups', text: 'cedar harbor ' + 'padding '.repeat(100) }]);
  assert.deepEqual(ids(index.search(q([['cedar'], ['harbor']]))), ['one-group', 'two-groups']);
});

test('NOT stays in compiler MATCH and observed survivor BM25 agrees with positive query', t => {
  const index = corpus(t, [{ id: 'keep', text: 'cedar harbor' }, { id: 'long', text: 'cedar harbor maple willow' },
    { id: 'remove', text: 'cedar mobile' }]);
  const base = index.search(q([['cedar']]));
  const filtered = index.search({ concepts: [['cedar']], exclude: ['mobile'] });
  assert.deepEqual(filtered.results, base.results.filter(row => row.id !== 'remove'));
});

test('compiler boolean behavior executes against all 16 independent term combinations', t => {
  const terms = ['alpha', 'beta', 'gamma', 'delta'];
  const rows = Array.from({ length: 16 }, (_, mask) => terms.filter((_, i) => mask & (1 << i)).join(' '));
  const index = raw(t, rows);
  for (const match of ['any', 'all']) for (const exclude of [[], ['delta']]) {
    const plan = compileFts5({ concepts: [['alpha', 'beta'], ['gamma']], match, exclude }, identity);
    const expected = rows.flatMap((_, mask) => {
      const first = !!(mask & 3), second = !!(mask & 4);
      return (match === 'any' ? first || second : first && second) && !(exclude.length && (mask & 8)) ? [mask + 1] : [];
    });
    assert.deepEqual(index.search(plan).map(row => row.rowid).sort((a, b) => a - b), expected);
  }
});

test('trim and duplicate alternatives preserve real candidate membership and score', t => {
  const index = corpus(t, [{ id: 'one', text: 'cedar' }, { id: 'two', text: 'maple' }]);
  assert.deepEqual(index.search(q([[' cedar ', 'cedar'], ['cedar']])), index.search(q([['cedar']])));
  assert.deepEqual(parseQuery({ concepts: [[' cedar ', 'cedar']], exclude: [' maple ', 'maple'] }),
    { concepts: [['cedar']], match: 'any', exclude: ['maple'] });
});

test('author rejects invalid shapes, unknown fields and invalid text without truncation', () => {
  for (const [input, code] of [
    [null, 'INVALID_QUERY'], [[], 'INVALID_QUERY'], [new Date(), 'INVALID_QUERY'],
    [{}, 'INVALID_ARRAY'], [{ concepts: [] }, 'INVALID_ARRAY'], [{ concepts: [[]] }, 'INVALID_ARRAY'],
    [{ exclude: ['cedar'] }, 'INVALID_ARRAY'], [{ concepts: [['cedar']], must: [] }, 'UNKNOWN_FIELD'],
    [{ concepts: [['cedar']], match: 'ALL' }, 'INVALID_MODE'], [{ concepts: [[' ']] }, 'EMPTY_TEXT'],
    [{ concepts: [[3]] }, 'INVALID_TEXT'], [{ concepts: [['\0']] }, 'INVALID_TEXT'],
    [{ concepts: [['\ud800']] }, 'INVALID_TEXT'], [{ concepts: [Array(1)] }, 'INVALID_TEXT'],
  ]) assert.throws(() => compileQuery(input), errorCode(code));
});

test('author input limits include groups alternatives exclusions and Unicode totals', () => {
  for (const input of [q(Array.from({ length: 6 }, () => ['cedar'])), q([Array(5).fill('cedar')]),
    { concepts: [['cedar']], exclude: Array(6).fill('maple') }]) {
    assert.throws(() => compileQuery(input), errorCode('INVALID_ARRAY'));
  }
  for (const input of [q([['x'.repeat(257)]]), q([['😀'.repeat(257)]]),
    q(Array.from({ length: 3 }, () => Array(3).fill('x'.repeat(256))))]) {
    assert.throws(() => compileQuery(input), errorCode('LIMIT_EXCEEDED'));
  }
  assert.equal(parseQuery(q([['😀'.repeat(256)]])).concepts[0][0], '😀'.repeat(256));
});

test('analyzer contract errors remain distinct from parser errors', () => {
  const input = q([['cedar']]);
  for (const [analyze, code] of [[undefined, 'MISSING_ANALYZER'], [() => { throw Error(); }, 'ANALYZER_FAILED'],
    [() => [], 'EMPTY_ANALYSIS'], [() => [[]], 'INVALID_ARRAY'], [() => [[' cedar']], 'INVALID_ANALYSIS'],
    [() => [[3]], 'INVALID_TEXT'], [() => Array(5).fill(['cedar']), 'INVALID_ARRAY'],
    [() => [Array(17).fill('cedar')], 'INVALID_ARRAY'], [() => [['x'.repeat(4097)]], 'LIMIT_EXCEEDED']]) {
    assert.throws(() => compileFts5(input, analyze), errorCode(code));
  }
});

test('author expanded-atom and final-MATCH resource budgets are enforced', () => {
  const input = q(Array.from({ length: 5 }, (_, i) => [`word${i}`]));
  assert.throws(() => compileFts5(input, () => Array.from({ length: 4 }, () => Array(16).fill('atom'))), errorCode('LIMIT_EXCEEDED'));
  const long = Array.from({ length: 9 }, (_, i) => `${i}${'x'.repeat(LIMITS.atomCodePoints - 1)}`);
  assert.throws(() => compileFts5(q([['cedar']]), () => [long]), errorCode('LIMIT_EXCEEDED'));
});

test('author escapes embedded quotes for a tokenizer that really preserves them', t => {
  // Separate analyzer contract fixture; shared corpus tokenizer discards quotes.
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE VIRTUAL TABLE terms USING fts5(tokens, tokenize = 'ascii tokenchars ''"''')`);
  db.prepare('INSERT INTO terms(tokens) VALUES (?)').run('alpha"beta');
  db.prepare('INSERT INTO terms(tokens) VALUES (?)').run('alpha beta');
  const plan = compileFts5(q([['alpha"beta']]), identity);
  assert.deepEqual(db.prepare('SELECT rowid FROM terms WHERE terms MATCH ?').all(plan.match).map(r => r.rowid), [1]);
});
