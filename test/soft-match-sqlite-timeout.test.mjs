import './isolated-agent-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteBackgroundIndex } from '../benchmark/sqlite-background-index.mjs';
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
        query(query, { options }) {
          const check = createQueryCheck(options.queryDeadlineAt, options.queryTimeoutMs);
          check?.();
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
  await index.queryRanked('alpha', branch, { mode: 'manual' });
  const worker = index.worker, threadId = worker.threadId, generation = index.generation;
  for (const query of ['native', 'late']) {
    const entered = new Promise(resolve => worker.once('message', message => { if (message.enteringNative) resolve(); }));
    const expired = assert.rejects(index.queryRanked(query, branch, { mode: 'manual', timeoutMs: 100 }), {
      name: 'TimeoutError', message: 'history_recall timed out after 100 ms; narrow the query or use history_grep',
    });
    await entered;
    const queued = index.queryRanked('alpha', branch, { mode: 'manual' });
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
  const expiredJS = assert.rejects(index.queryRanked('js', branch, { mode: 'manual', timeoutMs: 25 }), { name: 'TimeoutError' });
  const queuedJS = index.queryRanked('alpha', branch, { mode: 'manual' });
  await expiredJS;
  assert.equal((await queuedJS).cacheHit, true);
  assert.equal(index.worker, worker);
  assert.equal(index.generation, generation);
});
