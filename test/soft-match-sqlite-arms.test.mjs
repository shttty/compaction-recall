import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../benchmark/retrieval-sqlite-engine.mjs';
import { BackgroundIndex } from '../src/background-index.mjs';
import { initialBranch, msg } from './corpus.mjs';

const texts = ['booked tickets at coffee shops 有声书 网关服务 rowzero',
  'booking ticket with Sophia 南京市 艺术课程 rowone', 'book tickets power electricity 网关 rowtwo'];
const documents = texts.map((text, i) => ({ id: `m${i}`, text }));
const ranks = rows => rows.map(({ id, score }) => ({ id, score }));

for (const arm of ['off', 'prefix-all', 'prefix-min4', 'jieba', 'porter', 'porter-jieba', 'porter-js', 'inflect-wink', 'lemma-index']) {
  test(`${arm}: actual background transport and synchronous index return identical complete ranks`, async () => {
    const previous = process.env.COMPACTION_RECALL_SQLITE_ARM;
    process.env.COMPACTION_RECALL_SQLITE_ARM = arm;
    const branch = initialBranch(texts.map((text, i) => msg(i, text)));
    const worker = new BackgroundIndex({ engineModule: new URL('../benchmark/retrieval-sqlite-worker.mjs', import.meta.url) });
    let sync;
    try {
      sync = await createEngine(documents, { arm });
      await worker.prepare(branch, { preindexLive: true });
      for (const [mode, query] of [['auto', 'Where booked tickets?'], ['auto', '有声书艺术课程'],
      ['manual', 'book'], ['manual', 'coffee shop'], ['manual', '"booked tickets"'],
      ['manual', 'tokens:power OR Sophia'], ['manual', 'NEAR(booked tickets, 3)'], ['manual', '有声书'],
      ['manual', 'the OR power']]) {
        const expected = mode === 'auto' ? await sync.searchAuto(query) : (await sync.searchRaw(query)).results;
        const actual = await worker.queryRanked(query, branch, { mode });
        assert.equal(actual.total, expected.length, query);
        assert.deepEqual(ranks(actual.results), expected, query);
      }
      await assert.rejects(async () => sync.searchRaw('"'), /unterminated/);
      await assert.rejects(() => worker.queryRanked('"', branch, { mode: 'manual' }), /unterminated/);
      assert.deepEqual(ranks((await worker.queryRanked('power', branch, { mode: 'manual' })).results),
        (await sync.searchRaw('power')).results);
    } finally {
      await sync?.dispose(); await worker.dispose();
      if (previous === undefined) delete process.env.COMPACTION_RECALL_SQLITE_ARM;
      else process.env.COMPACTION_RECALL_SQLITE_ARM = previous;
    }
  });
}

test('prefix arm routing expands automatic and raw terms but not user phrases', async () => {
  const plain = createEngine([{ id: 'a', text: 'alphabet 网关服务' }], { arm: 'off' });
  const all = createEngine([{ id: 'a', text: 'alphabet 网关服务' }], { arm: 'prefix-all' });
  const min4 = createEngine([{ id: 'a', text: 'alphabet 网关服务' }], { arm: 'prefix-min4' });
  try {
    assert.deepEqual(plain.searchAuto('alpha'), []);
    assert.deepEqual(all.searchAuto('alpha').map(row => row.id), ['a']);
    assert.deepEqual(all.searchRaw('alpha').results.map(row => row.id), ['a']);
    assert.deepEqual(all.searchRaw('"alpha"').results, []);
    assert.deepEqual(min4.searchRaw('alp').results, []);
    assert.deepEqual(min4.searchRaw('alpha').results.map(row => row.id), ['a']);
  } finally { plain.dispose(); all.dispose(); min4.dispose(); }
});
