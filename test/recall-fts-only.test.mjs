import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';
import { SQLiteBackgroundIndex } from '../benchmark/sqlite-background-index.mjs';
import { initialBranch, msg } from './corpus.mjs';

const input = surface => ({ concepts: [[surface]] });
const error = { name: 'QueryError', code: 'EMPTY_ANALYSIS', message: 'A surface form produced no searchable terms' };

test('manual FTS preserves zero-analysis errors and ordinary zero hits', t => {
  const index = createIndex([{ id: 'seven', text: 'topic 7:30 café' },
    { id: 'eight', text: 'topic 8:30 caf' }, { id: 'literal', text: 'topic 晨 *' }]);
  t.after(() => index.close());
  for (const surface of ['*', '中', '晨', 'x', '??']) assert.throws(() => index.queryRows(input(surface)), error);
  assert.throws(() => index.queryRows({ concepts: [['topic', '*']] }), error);
  assert.throws(() => index.queryRows({ concepts: [['topic']], exclude: ['晨'] }), error);
  const zero = index.queryRows(input('missingword'));
  assert.equal(zero.total, 0);
  assert.deepEqual(zero.results, []);
  assert.equal('fallback' in zero, false);
  assert.equal(index.queryPage(input('topic'), { limit: 1 }).total, 3);
  assert.throws(() => index.queryRows({ ...input('topic'), pattern: 'topic' }), { name: 'QueryError', code: 'UNKNOWN_FIELD' });
});

test('real SQLite worker retains its generation and subsequent queries after compiler errors', async t => {
  const index = new SQLiteBackgroundIndex();
  t.after(() => index.dispose());
  const branch = initialBranch([msg('evidence', 'topic 7:30 café 晨'), msg('other', 'topic 8:30 caf')]);
  const run = query => index.queryRanked(query, branch, { mode: 'manual' });
  assert.equal((await run(input('topic'))).total, 2);
  const worker = index.worker, generation = index.generation;
  await assert.rejects(run(input('晨')), error);
  const partial = await run(input('7:30'));
  assert.deepEqual(partial.results.map(row => row.id).sort(), ['mevidence', 'mother']);
  assert.deepEqual(partial.warnings, ['Warning: "7:30" → ["30"]. Suggestion: revise query terms or use history_grep.']);
  const recovered = await run(input('topic'));
  assert.deepEqual(recovered.results.map(row => row.id).sort(), ['mevidence', 'mother']);
  assert.ok(recovered.results.every(row => row.score < 0));
  assert.equal(index.worker, worker);
  assert.equal(index.generation, generation);
  assert.equal(index.failed, false);
  assert.equal((await run(input('missingword'))).total, 0);
});

test('normal FTS zero hits stay zero despite literal substrings and native errors propagate', () => {
  const index = createIndex([{ id: 'substring-only', text: 'prefixneedle suffix' }]);
  try { assert.equal(index.queryRows(input('needle')).total, 0); }
  finally { index.close(); }
  assert.throws(() => index.queryRows(input('needle')), { code: 'ERR_INVALID_STATE' });
});

test('lossy concepts and exclusions use original FTS terms and report warnings', t => {
  const index = createIndex([{ id: 'seven', text: 'topic 7:30 café gpu7' },
    { id: 'eight', text: 'topic 8:30 caf' }, { id: 'extra', text: 'topic cafe' }]);
  t.after(() => index.close());
  for (const [surface, indexedTerms] of [['7:30', ['30']], ['GPU7点', ['gpu7']], ['café', ['caf']], ['cafe\u0301', ['cafe']]]) {
    for (const query of [input(surface), { concepts: [['topic', surface]] },
      { concepts: [['topic'], [surface]] }, { concepts: [['topic']], exclude: [surface] }]) {
      const stages = [];
      const timer = { run(stage, work) { stages.push(stage); return work(); } };
      const found = index.queryRows(query, { timer });
      assert.deepEqual(found.warnings, [`Warning: ${JSON.stringify(surface)} → ${JSON.stringify(indexedTerms)}. Suggestion: revise query terms or use history_grep.`]);
      assert.ok(stages.includes('native_count') && stages.includes('native_query'));
      assert.equal(stages.some(stage => stage.startsWith('fallback_')), false);
    }
  }
  const recovered = index.queryPage(input('TOPIC!'));
  assert.equal(recovered.total, 3);
  assert.equal('fallback' in recovered, false);
  assert.ok(index.queryRows(input('topic')).results.every(row => row.score < 0));
});
