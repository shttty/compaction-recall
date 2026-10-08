import assert from 'node:assert/strict';
import test from 'node:test';
import { SQLiteBackgroundIndex } from '../../../src/worker/sqlite-background-index.mjs';
import { StageTiming } from '../../../src/observability/timing.mjs';
import { compact, msg } from '../../fixtures/corpus.mjs';

const documents = [
  msg('orchard-old', 'orchard harvest map silver lake'),
  msg('han-old', '杭州西湖山水风景'),
  msg('id-old', 'Release QX-7319-ALPHA notes'),
  msg('tie-a', 'shared alpha orbit'),
  msg('tie-b', 'shared bravo orbit'),
  msg('duplicate-old', 'orchard harvest map silver lake'),
  msg('orchard-new', 'orchard harvest bees and flowers'),
  msg('han-new', '杭州西湖观景台和步道'),
  msg('id-new', 'QX-7319-ALPHA deployment record'),
  msg('tie-c', 'shared delta orbit'),
];
const initial = documents.slice(0, 6);
const additions = documents.slice(6);
const branch = rows => [...rows, msg('live', 'live retained prompt'), compact('checkpoint', 'mlive')];
const queries = [
  { mode: 'auto', query: 'orchard harvest', options: { limit: 6, offset: 1 } },
  { mode: 'auto', query: '杭州西湖', options: { limit: 6, offset: 1 } },
  { mode: 'auto', query: 'QX-7319-ALPHA', options: { limit: 6, offset: 1 } },
  { mode: 'manual', query: { concepts: [['orchard']] }, options: { limit: 6, offset: 1 } },
  { mode: 'manual', query: { concepts: [['杭州西湖']] }, options: { limit: 6, offset: 1 } },
  { mode: 'manual', query: { concepts: [['QX-7319-ALPHA']] }, options: { limit: 6, offset: 1 } },
  { mode: 'manual', query: { concepts: [['shared']] }, options: { limit: 6, offset: 1 } },
  { mode: 'manual', query: { concepts: [['orchard']] }, options: { page: true, limit: 4, offset: 1 } },
  { mode: 'manual', query: { concepts: [['杭州西湖']] }, options: { page: true, limit: 4, offset: 1 } },
  { mode: 'manual', query: { concepts: [['QX-7319-ALPHA']] }, options: { page: true, limit: 4, offset: 1 } },
  { mode: 'manual', query: { concepts: [['shared']] }, options: { page: true, limit: 4, offset: 1 } }
];

async function run(index, source, { mode, query, options }) {
  const found = await index.queryRanked(query, source, { mode, options });
  if (found.ids) return { total: found.total, ids: found.ids, page: found.page.text, details: found.page.details };
  return {
    total: found.total,
    queryTerms: found.queryTerms,
    skipped: found.skipped,
    rows: found.results.map(({ id, score, date, role, snippet }) => ({ id, score, date, role, snippet })),
  };
}

function assertSameResults(expected, actual) {
  assert.equal(actual.total, expected.total);
  if (expected.ids) {
    assert.deepEqual(actual.ids, expected.ids);
    assert.equal(actual.page, expected.page);
    assert.deepEqual(actual.details, expected.details);
    return;
  }
  assert.deepEqual(actual.queryTerms, expected.queryTerms);
  assert.equal(actual.skipped, expected.skipped);
  assert.deepEqual(actual.rows.map(({ id, date, role, snippet }) => ({ id, date, role, snippet })),
    expected.rows.map(({ id, date, role, snippet }) => ({ id, date, role, snippet })));
  assert.deepEqual(actual.rows.map(row => row.id), expected.rows.map(row => row.id));
  for (let i = 0; i < expected.rows.length; i++) assert.ok(Math.abs(actual.rows[i].score - expected.rows[i].score) <= 1e-7);
}

test('full and incremental SQLite commits return equivalent auto/manual pages and ranked rows', async () => {
  const timing = new StageTiming();
  const full = new SQLiteBackgroundIndex({ timer: timing });
  const appended = new SQLiteBackgroundIndex({ timer: timing });
  const fullBranch = branch(documents);
  try {
    await Promise.all([full.prepare(fullBranch), appended.prepare(branch(initial))]);
    await appended.prepare(fullBranch);
    assert.ok(timing.events.some(event => event.stage === 'background_index_ready' && event.kind === 'incremental_update'));

    for (const query of queries) {
      const expected = await run(full, fullBranch, query);
      const actual = await run(appended, fullBranch, query);
      assertSameResults(expected, actual);

      const explicitDefault = await run(full, fullBranch, {
        ...query, options: { ...query.options, eligibleCount: -1 },
      });
      assertSameResults(expected, explicitDefault);
    }
  } finally {
    await Promise.all([full.dispose(), appended.dispose()]);
  }
});

test('duplicate addition ids and non-prefix changes rebuild instead of appending', async () => {
  const timing = new StageTiming();
  const index = new SQLiteBackgroundIndex({ timer: timing });
  const base = [msg('base', 'orchard reference'), msg('second', '杭州西湖 reference')];
  try {
    await index.prepare(branch(base));
    const firstWorker = index.worker;

    await index.prepare(branch([...base, msg('repeated', 'orchard added one'), msg('repeated', 'orchard added two')]));
    const duplicateWorker = index.worker;
    assert.notEqual(duplicateWorker, firstWorker);
    assert.equal(firstWorker.threadId, -1);
    assert.ok(timing.events.some(event => event.stage === 'background_index_ready' && event.kind === 'build_or_rebuild'));

    const changedPrefix = [msg('base', 'orchard reference revised'), base[1], msg('after-change', 'orchard final')];
    await index.prepare(branch(changedPrefix));
    assert.notEqual(index.worker, duplicateWorker);
    assert.equal(duplicateWorker.threadId, -1);
  } finally {
    await index.dispose();
  }
});
