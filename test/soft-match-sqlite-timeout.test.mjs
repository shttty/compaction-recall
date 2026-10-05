import './isolated-agent-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteBackgroundIndex } from '../benchmark/sqlite-background-index.mjs';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';
import { createQueryCheck, queryNow } from '../prototype/soft-match-sqlite/deadline.mjs';
import { initialBranch, msg } from './corpus.mjs';

// Native SQLite is non-preemptible; check after it returns, keep the connection
// and caches, and let the next queued request run instead of cancelling it.
test('cooperative native/JS deadlines discard late results without resetting or cancelling queued work', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-cooperative-timeout-'));
  const module = join(dir, 'native-engine.mjs');
  const helper = new URL('../prototype/soft-match-sqlite/deadline.mjs', import.meta.url).href;
  writeFileSync(module, `
    import { DatabaseSync } from 'node:sqlite';
    import { parentPort } from 'node:worker_threads';
    import { createQueryCheck } from ${JSON.stringify(helper)};
    export function createWorkerEngine() {
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE docs(id TEXT, text TEXT)');
      const slow = db.prepare('WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<5000000) SELECT sum(x) FROM n');
      const cached = new Map();
      return {
        commit(entries) {
          for (const entry of entries) db.prepare('INSERT INTO docs VALUES (?, ?)').run(entry.id, entry.message.content);
          return { documents: entries.length };
        },
        query(input, { options }) {
          const query = input.concepts[0][0];
          const check = createQueryCheck(options.queryDeadlineAt, options.queryTimeoutMs);
          check?.();
          if (query === 'native-error') db.prepare('SELECT * FROM missing_native_table');
          if (query === 'native' || query === 'late') {
            parentPort.postMessage({ enteringNative: true });
            slow.get();
            if (query === 'native') check?.();
          }
          if (query === 'js') for (let i = 0; i < 1000000000; i++) { if ((i & 255) === 0) check?.(); }
          const needle = ['native', 'late', 'js'].includes(query) ? 'alpha' : query;
          const cacheHit = cached.has(needle);
          if (!cacheHit) cached.set(needle, db.prepare('SELECT id, text FROM docs WHERE text LIKE ?').all('%' + needle + '%'));
          const rows = cached.get(needle);
          return { total: rows.length, cacheHit, results: rows.map(row => ({ id: row.id, date: '2026-10-05', role: 'user', snippet: row.text })) };
        },
        dispose() { db.close(); },
      };
    }
  `);
  const index = new SQLiteBackgroundIndex({ engineModule: pathToFileURL(module), recallTimeoutMs: 5000 });
  t.after(async () => { await index.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const branch = initialBranch([msg('evidence', 'alpha evidence')]);
  await index.queryRanked({ concepts: [['alpha']] }, branch, { mode: 'manual' });
  const worker = index.worker, threadId = worker.threadId, generation = index.generation;
  for (const query of ['native', 'late']) {
    const entered = new Promise(resolve => worker.once('message', message => { if (message.enteringNative) resolve(); }));
    const expired = assert.rejects(index.queryRanked({ concepts: [[query]] }, branch, { mode: 'manual', timeoutMs: 100 }), {
      name: 'TimeoutError',
    });
    await entered;
    const queued = index.queryRanked({ concepts: [['alpha']] }, branch, { mode: 'manual' });
    await delay(5); // Main-thread events remain runnable during native SQL.
    await expired;
    const result = await queued;
    assert.deepEqual(result.results.map(row => row.id), [branch[0].id]);
    assert.equal(result.cacheHit, true);
    assert.equal(index.worker, worker);
    assert.equal(worker.threadId, threadId);
    assert.equal(index.generation, generation);
    assert.equal(index.failed, false);
    assert.equal(index.ready, true);
  }
  const expiredJS = assert.rejects(index.queryRanked({ concepts: [['js']] }, branch, { mode: 'manual', timeoutMs: 25 }), { name: 'TimeoutError' });
  const queuedJS = index.queryRanked({ concepts: [['alpha']] }, branch, { mode: 'manual' });
  await expiredJS;
  assert.equal((await queuedJS).cacheHit, true);
  assert.equal(index.worker, worker);
  assert.equal(index.generation, generation);
  const native = new DatabaseSync(':memory:');
  let expected;
  try { native.prepare('SELECT * FROM missing_native_table'); } catch (error) { expected = error; }
  finally { native.close(); }
  await assert.rejects(index.queryRanked({ concepts: [['native-error']] }, branch, { mode: 'manual' }),
    error => error.name === expected.name && error.code === expected.code && error.message === expected.message);
  assert.equal((await index.queryRanked({ concepts: [['alpha']] }, branch, { mode: 'manual' })).cacheHit, true);
  assert.equal(index.worker, worker);
  assert.equal(index.generation, generation);
  assert.equal(index.failed, false);
  assert.equal(index.ready, true);
});

test('real SQLite literal scan checks its deadline inside a large document and leaves the index usable', t => {
  const index = createIndex([
    { id: 'large-history', text: '.'.repeat(2 * 1024 * 1024) + '中' },
    { id: 'short-history', text: 'recoveryneedle evidence' },
  ]);
  t.after(() => index.close());
  let activeStage, scanChecks = 0;
  const timer = {
    run(stage, work) {
      const previous = activeStage;
      activeStage = stage;
      try { return work(); } finally { activeStage = previous; }
    },
  };
  assert.throws(() => index.queryRows({ concepts: [['中']] }, {
    timer,
    check() {
      if (activeStage === 'fallback_scan' && ++scanChecks === 8) {
        // Expire the real deadline only after repeatedly entering the actual
        // literal scan, so a pre-query guard cannot satisfy this regression.
        createQueryCheck(queryNow() - 1, 25)();
      }
    },
  }), { name: 'TimeoutError' });
  assert.equal(scanChecks, 8);
  const recovered = index.queryRows({ concepts: [['recoveryneedle']] });
  assert.deepEqual(recovered.results.map(row => row.id), ['short-history']);
  assert.match(recovered.results[0].snippet, /recoveryneedle evidence/);
  const completed = index.queryRows({ concepts: [['中']] });
  assert.equal(completed.total, 1);
  assert.deepEqual(completed.results.map(row => row.id), ['large-history']);
  assert.deepEqual(completed.fallback, { surfaces: ['中'], scannedDocuments: 2, ranking: 'rarity' });
});

test('real large-history fallback timeout preserves the SQLite worker and the queued next query', { timeout: 30000 }, async t => {
  const index = new SQLiteBackgroundIndex();
  t.after(() => index.dispose());
  // Eight million UTF16 units, almost entirely punctuation: actual history
  // scanning is substantial without expensive token postings or a provider.
  const padding = '.'.repeat(256 * 1024);
  const history = Array.from({ length: 32 }, (_, i) => msg(`large-${i}`, padding + ` row${i}`));
  history.push(msg('recovery', 'recoveryneedle evidence'));
  const branch = initialBranch(history);
  await index.prepare(branch, { preindexLive: true });
  assert.deepEqual((await index.queryRanked({ concepts: [['recoveryneedle']] }, branch, { mode: 'manual' }))
    .results.map(row => row.id), ['mrecovery']);
  const worker = index.worker, threadId = worker.threadId, generation = index.generation;
  const expired = assert.rejects(index.queryRanked({ concepts: [['中']] }, branch, { mode: 'manual', timeoutMs: 1 }),
    { name: 'TimeoutError' });
  const queued = index.queryRanked({ concepts: [['recoveryneedle']] }, branch, { mode: 'manual' });
  await expired;
  const recovered = await queued;
  assert.deepEqual(recovered.results.map(row => row.id), ['mrecovery']);
  assert.match(recovered.results[0].snippet, /recoveryneedle evidence/);
  assert.equal(Object.hasOwn(recovered, 'fallback'), false);
  assert.equal(index.worker, worker);
  assert.equal(worker.threadId, threadId);
  assert.equal(index.generation, generation);
  assert.equal(index.failed, false);
  assert.equal(index.ready, true);
});
