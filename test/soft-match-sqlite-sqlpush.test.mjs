import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';
import { createWorkerEngine } from '../benchmark/retrieval-sqlite-worker.mjs';
import { BackgroundIndex } from '../src/background-index.mjs';
import { initialBranch, msg } from './corpus.mjs';

const engineModule = new URL('../benchmark/retrieval-sqlite-worker.mjs', import.meta.url);
const edit = (id, targetId, content) => ({ type: 'context_edit', id, parentId: null, timestamp: '2026-10-04T00:00:00Z', targetId,
  replacement: content === null ? null : { content } });
const visibleRows = page => page.text.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);

test('full whitespace-normalized content dedupes case-sensitively, not by the selected snippet', t => {
  const prefix = `needle ${'padding '.repeat(100)}`;
  const index = createIndex([
    { id: 'old', text: ' needle\talpha\n beta ', timestamp: '2026-10-03T12:00:00Z', sourcePosition: 9 },
    { id: 'new', text: 'needle alpha beta', timestamp: '2026-10-04T12:00:00Z', sourcePosition: 0 },
    { id: 'case', text: 'Needle alpha beta', timestamp: '2026-10-02T12:00:00Z', sourcePosition: 20 },
    { id: 'tail-a', text: prefix + 'tailA', timestamp: '2026-10-01T12:00:00Z' },
    { id: 'tail-b', text: prefix + 'tailB', timestamp: '2026-10-01T12:00:00Z' },
  ]);
  t.after(() => index.close());
  const found = index.queryRows('needle');
  assert.equal(found.total, 4);
  assert.deepEqual(found.results.map(row => row.id), ['new', 'case', 'tail-b', 'tail-a']);
  assert.equal(found.results.find(row => row.id === 'tail-a').snippet, found.results.find(row => row.id === 'tail-b').snippet);
  assert.equal(index.queryPage('needle', { limit: 1, offset: 1 }).total, 4);
  assert.deepEqual(index.queryPage('needle', { limit: 1, offset: 1 }).ids, ['case']);
});

test('BM25 precedes timestamp, then full timestamp precedes source position and rowid', t => {
  const index = createIndex([
    { id: 'newer-weak', text: `needle ${'padding '.repeat(100)}`, timestamp: '2026-10-05T00:00:00Z', sourcePosition: 100 },
    { id: 'early', text: 'needle EARLY', timestamp: '2026-10-04T01:00:00Z', sourcePosition: 100 },
    { id: 'late-low', text: 'needle SAME', timestamp: '2026-10-04T12:00:00Z', sourcePosition: 1 },
    { id: 'late-high-old-row', text: 'needle SAME', timestamp: '2026-10-04T12:00:00Z', sourcePosition: 2 },
    { id: 'late-high-new-row', text: 'needle SAME', timestamp: '2026-10-04T12:00:00Z', sourcePosition: 2 },
    { id: 'late-distinct', text: 'needle OTHER', timestamp: '2026-10-04T12:00:00Z', sourcePosition: 3 },
  ]);
  t.after(() => index.close());
  const found = index.queryRows('needle');
  assert.deepEqual(found.results.map(row => row.id), ['late-distinct', 'late-high-new-row', 'early', 'newer-weak']);
  assert.ok(found.results[0].score < found.results.at(-1).score);
  assert.equal(found.total, 4);
});

test('actual engine SQL pages materialize and render only the requested candidates', t => {
  const worker = createWorkerEngine({ arm: 'off' });
  t.after(() => worker.dispose());
  worker.commit(Array.from({ length: 30 }, (_, i) => ({ ...msg(i, ''), sourcePosition: i, message: { role: 'user', content: `needle row${String(i).padStart(2, '0')}` } })), { eligibleCount: 30 });
  const stages = [], materialized = [];
  const timer = { run(stage, work) { stages.push(stage); const result = work(); if (stage === 'candidate_materialization') materialized.push(result.length); return result; } };
  const result = worker.query('needle ghost', { mode: 'manual', options: { page: true, limit: 2, offset: 7 }, timer });
  assert.equal(result.total, 30);
  assert.deepEqual(result.ids, ['m22', 'm21']);
  assert.deepEqual(visibleRows(result.page).map(row => row.id), result.ids);
  assert.deepEqual(result.missingTerms, ['ghost']);
  assert.deepEqual(materialized, [2]);
  assert.equal(stages.filter(stage => stage === 'snippet_render').length, 2);
  const automatic = worker.query('needle', { mode: 'auto', options: { limit: 5 } });
  assert.equal(automatic.total, 30);
  assert.deepEqual(automatic.results.map(row => row.id), ['m29', 'm28', 'm27', 'm26', 'm25']);
});

test('worker-thread projection applies omit/replacement before dedupe/count/pages and branch switching restores originals', async () => {
  const records = Array.from({ length: 40 }, (_, i) => ({ ...msg(i, `needle original row${String(i).padStart(2, '0')} ${'padding '.repeat(60)}`), id: `m${String(i).padStart(2, '0')}-${'x'.repeat(700)}` }));
  const original = initialBranch(records);
  const changed = [
    ...original,
    edit('omit', records[3].id, null),
    edit('temporary', records[4].id, 'needle temporary'),
    edit('replace', records[4].id, records[5].message.content[0].text),
    edit('live-edit', 'mlive', 'needle liveOnly'),
  ];
  const index = new BackgroundIndex({ engineModule });
  const pages = async (branch, expected) => {
    const seen = []; let offset = 0; let count = 0;
    do {
      const result = await index.queryRanked('needle', branch, { mode: 'manual', options: { page: true, limit: 50, offset } });
      assert.equal(result.total, expected.length);
      assert.equal(result.page.details.total, expected.length);
      assert.equal(result.page.details.offset, offset);
      assert.ok(Array.from(result.page.text).length <= 16000);
      assert.deepEqual(visibleRows(result.page).map(row => row.id), result.ids);
      seen.push(...result.ids);
      count++;
      const next = result.page.details.nextOffset;
      if (next === null || next === undefined) break;
      assert.equal(next, offset + result.ids.length);
      assert.ok(next > offset);
      offset = next;
    } while (offset < expected.length);
    assert.deepEqual(seen, expected);
    assert.ok(count > 1, 'response budget must split the fixture across SQL pages');
  };
  try {
    const reverse = records.map(row => row.id).reverse();
    await pages(changed, reverse.filter(id => id !== records[3].id && id !== records[4].id));
    const absent = await index.queryRanked('temporary OR liveOnly', changed, { mode: 'manual', options: { page: true, limit: 2 } });
    assert.equal(absent.total, 0);
    assert.deepEqual(absent.ids, []);
    assert.deepEqual(absent.missingTerms, ['temporary', 'liveonly']);
    await pages(original, reverse);
    await pages(changed, reverse.filter(id => id !== records[3].id && id !== records[4].id));
  } finally { await index.dispose(); }
});
