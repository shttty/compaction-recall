import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';

test('native explicit prefixes retrieve candidates without query rewriting', t => {
  const index = createIndex([
    { id: 'long', text: 'alphabet betamax gateway' },
    { id: 'short', text: 'alpha beta gate' },
    { id: 'han', text: '网关服务' },
  ]);
  t.after(() => index.close());
  const ids = query => index.searchRaw(query).results.map(hit => hit.id).sort();
  assert.deepEqual(ids('alpha AND beta'), ['short']);
  assert.deepEqual(ids('alpha* AND beta*'), ['long', 'short']);
  assert.deepEqual(ids('gat'), []);
  assert.deepEqual(ids('gate*'), ['long', 'short']);
  assert.deepEqual(ids('"alpha beta"'), ['short']);
  assert.deepEqual(ids('NEAR(alpha beta, 2)'), ['short']);
  for (const query of ['alpha AND', 'alpha**', '"unfinished', 'NEAR(alpha beta', 'alpha @ beta']) {
    assert.throws(() => index.searchRaw(query), /fts5|syntax|unterminated/i, query);
  }
});
