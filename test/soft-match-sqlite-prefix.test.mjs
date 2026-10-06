import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';

test('concept punctuation is literal surface data, never prefix or native operators', t => {
  const index = createIndex([
    { id: 'long', text: 'alphabet betamax gateway' },
    { id: 'short', text: 'alpha beta gate' },
    { id: 'han', text: '网关服务' },
  ]);
  t.after(() => index.close());
  const ids = surface => index.search({ concepts: [[surface]] }).results.map(hit => hit.id).sort();
  assert.deepEqual(ids('alpha beta'), ['short']);
  assert.deepEqual(ids('alpha* beta*'), ['short']);
  assert.deepEqual(ids('gat'), []);
  assert.deepEqual(ids('gate*'), ['short']);
  assert.deepEqual(ids('alpha AND beta'), []);
  assert.deepEqual(ids('"alpha beta"'), ['short']);
  assert.deepEqual(ids('alpha @ beta'), ['short']);
  assert.throws(() => ids('*'), { name: 'QueryError', code: 'EMPTY_ANALYSIS' });
});
