import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';
import { prefixExpression } from '../prototype/soft-match-sqlite/query.mjs';

test('prefix arms expand bare operands without changing explicit MATCH syntax', () => {
  const unchanged = '  alpha\tAND (beta OR "quoted phrase") NOT tokens:gamma*  ';
  assert.equal(prefixExpression(unchanged, 'off'), unchanged);
  assert.equal(prefixExpression(unchanged, 'jieba'), unchanged);
  assert.equal(prefixExpression(unchanged, 'porter'), unchanged);
  for (const [query, expected] of [
    ['alpha beta', 'alpha* beta*'],
    ['alpha AND beta OR gamma NOT delta', 'alpha* AND beta* OR gamma* NOT delta*'],
    ['alpha* beta', 'alpha* beta*'],
    ['alpha * beta', 'alpha * beta*'],
    ['^alpha beta', '^alpha beta*'],
    ['^ alpha beta', '^ alpha beta*'],
    ['alpha+beta gamma', 'alpha+beta gamma*'],
    ['alpha + beta + gamma delta', 'alpha + beta + gamma delta*'],
    ['"alpha beta" gamma', '"alpha beta" gamma*'],
    ['"alpha""beta"* gamma', '"alpha""beta"* gamma*'],
    ['tokens:alpha {tokens stems}:beta gamma', 'tokens:alpha* {tokens stems}:beta* gamma*'],
    ['-tokens:alpha beta', '-tokens:alpha* beta*'],
    ['NEAR(alpha beta, 4) gamma', 'NEAR(alpha beta, 4) gamma*'],
    ['(NEAR(alpha "beta", 3) OR gamma) delta', '(NEAR(alpha "beta", 3) OR gamma*) delta*'],
    ['NEAR(alpha beta', 'NEAR(alpha beta'],
    ['alpha "unfinished beta', 'alpha "unfinished beta'],
    ['网关 café Ελληνικά 𠀀𠀁', '网关* café* Ελληνικά* 𠀀𠀁*'],
    ['  alpha\t(beta)\n', '  alpha*\t(beta*)\n'],
  ]) assert.equal(prefixExpression(query, 'prefix-all'), expected, query);
});

test('min4 uses the full ASCII bare operand length, never Han or mixed Unicode', () => {
  assert.equal(prefixExpression('a ab abc abcd 1234 foo_bar 网关 网关服务 abc中 café', 'prefix-min4'),
    'a ab abc abcd* 1234* foo_bar* 网关 网关服务 abc中 café');
});

test('rewritten expressions retrieve prefix candidates through the real SQLite index', t => {
  const index = createIndex([
    { id: 'long', text: 'alphabet betamax gateway' },
    { id: 'short', text: 'alpha beta gate' },
    { id: 'han', text: '网关服务' },
  ]);
  t.after(() => index.close());
  const ids = query => index.searchRaw(query).results.map(hit => hit.id).sort();
  assert.deepEqual(ids(prefixExpression('alpha AND beta', 'off')), ['short']);
  assert.deepEqual(ids(prefixExpression('alpha AND beta', 'prefix-all')), ['long', 'short']);
  assert.deepEqual(ids(prefixExpression('gat', 'prefix-min4')), []);
  assert.deepEqual(ids(prefixExpression('gate', 'prefix-min4')), ['long', 'short']);
  assert.deepEqual(ids(prefixExpression('"alpha beta"', 'prefix-all')), ['short']);
  assert.deepEqual(ids(prefixExpression('NEAR(alpha beta, 2)', 'prefix-all')), ['short']);
  for (const query of ['alpha AND', 'alpha**', '"unfinished', 'NEAR(alpha beta', 'alpha @ beta']) {
    assert.throws(() => index.searchRaw(query), /fts5|syntax|unterminated/i, query);
    assert.throws(() => index.searchRaw(prefixExpression(query, 'prefix-all')), /fts5|syntax|unterminated/i, query);
  }
});
