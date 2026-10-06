import assert from 'node:assert/strict';
import test from 'node:test';
import { CompactionIndex } from '../benchmark/archive/js-runtime/inverted-index.mjs'
import { corpus, queries, initialBranch, extendedBranch, msg, compact } from './corpus.mjs';
import { buildLocator } from '../benchmark/archive/js-runtime/locator.mjs'

test('experimental index exact parity, incremental compaction, repeat, fork and reset', () => {
  const records = corpus(200), index = new CompactionIndex();
  const initial = initialBranch(records);
  for (const query of queries) assert.equal(index.query(query, initial), buildLocator(query, initial));
  const indexed = index.indexed;
  for (const query of queries) index.query(query, initial);
  assert.equal(index.indexed, indexed);
  const added = [msg('extra', 'rarequasar 数据库 retryBudget'), msg('extra2', 'common nebula')];
  const next = extendedBranch(records, added);
  for (const query of queries) assert.equal(index.query(query, next), buildLocator(query, next));
  assert.equal(index.indexed, indexed + 2);
  assert.equal(index.builds, 1);
  const fork = initialBranch([msg('fork', 'rarequasar')]);
  for (const query of queries) assert.equal(index.query(query, fork), buildLocator(query, fork));
  assert.equal(index.builds, 2);
  assert.equal(index.query('rarequasar', [msg('uncompacted', 'rarequasar')]), undefined);
  assert.equal(index.documents.size, 0);
});

test('experimental index handles duplicate ids, malformed content, missing boundary and ordering', () => {
  const old = msg('dup', 'rarequasar old');
  const fresh = msg('dup', 'rarequasar fresh');
  const malformed = msg('null', 'unused'); malformed.message.content = [null, { type: 'text', text: '数据库' }];
  const index = new CompactionIndex();
  const branches = [initialBranch([old]), initialBranch([old, fresh, malformed]),
    [fresh, malformed, compact('missing', 'missing')], [], initialBranch([fresh, old])];
  for (const branch of branches) for (const query of [...queries, 'the and', '']) {
    assert.equal(index.query(query, branch), buildLocator(query, branch));
  }
});

test('index preserves informative-term snippet centering exactly', () => {
  const b=initialBranch([msg('focus','common '+'😀'.repeat(200)+' rareNebula '+'🌟'.repeat(200)),
    msg('other1','common ordinary one'),msg('other2','common ordinary two')]);
  const index=new CompactionIndex();
  assert.equal(index.query('common rareNebula',b),buildLocator('common rareNebula',b));
  assert.match(index.query('common rareNebula',b),/rareNebula/);
});
