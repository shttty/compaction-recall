import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sqliteRecallPage } from '../benchmark/retrieval-sqlite-page.mjs';
import { recallPageFromRows } from '../src/locator.mjs';

const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), date: '2026-10-04', role: 'user', snippet: 'x'.repeat(120) }));
test('missing vocabulary line preserves production pagination and the response budget', () => {
  assert.deepEqual(sqliteRecallPage(rows, { limit: 2 }), recallPageFromRows(rows, { limit: 2 }));
  const first = sqliteRecallPage(rows, { limit: 2 }, ['未知词', 'missing']);
  assert.match(first.text, /^History recall page: .*\n未入索引：未知词、missing\n/);
  assert.equal(first.details.total, 50);
  assert.equal(first.details.returned, 2);
  const next = sqliteRecallPage(rows, { limit: 2, offset: first.details.nextOffset }, ['未知词']);
  assert.equal(JSON.parse(next.text.split('\n').find(line => line.startsWith('{'))).id, '2');
  const budget = sqliteRecallPage(rows.map(row => ({ ...row, id: row.id.padStart(200, 'x') })), {}, ['z'.repeat(10000)]);
  assert.ok(Array.from(budget.text).length <= 16000);
  assert.equal(budget.details.total, 50);
  assert.ok(budget.details.returned > 0 && budget.details.returned < 50);
  assert.equal(budget.details.nextOffset, budget.details.returned);
});

test('SDK adapter rejects six terms before starting worker but accepts five and preserves raw native errors', async t => {
  const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
  const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL('../benchmark/retrieval-sqlite-adapter.ts', import.meta.url))], process.cwd(), process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const recall = extension.tools.get('history_recall').definition;
  const timestamp = '2026-10-04T00:00:00Z';
  const ctx = {
    sessionManager: {
      getSessionId: () => 'cap-fixture', getBranch: () => [
        { type: 'message', id: 'match', timestamp, message: { role: 'user', content: 'alpha beta gamma delta epsilon' } },
        { type: 'message', id: 'live', timestamp, message: { role: 'user', content: 'retained' } },
        { type: 'compaction', id: 'compact', timestamp, firstKeptEntryId: 'live', summary: '', tokensBefore: 10 },
      ]
    }
  };
  t.after(async () => { for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx); });
  await assert.rejects(recall.execute('six', { query: 'alpha beta gamma delta epsilon zeta' }, undefined, undefined, { sessionManager: { getSessionId: () => 'cap-fixture', getBranch: () => { throw new Error('rejection must not collect or query branch'); } } }), { message: '本次 6 个关键词，上限 5，请拆开分几次查' });
  const five = await recall.execute('five', { query: 'alpha beta gamma delta epsilon' }, undefined, undefined, ctx);
  assert.equal(five.details.total, 1);
  assert.doesNotMatch(five.content[0].text, /未入索引/);
  const partial = await recall.execute('partial', { query: 'alpha nonexistent' }, undefined, undefined, ctx);
  assert.equal(partial.details.total, 1);
  assert.match(partial.content[0].text, /未入索引：nonexistent/);
  await assert.rejects(recall.execute('native', { query: '"' }, undefined, undefined, ctx), { message: 'unterminated string' });
  const recovered = await recall.execute('recover', { query: 'beta' }, undefined, undefined, ctx);
  assert.equal(recovered.details.total, 1);
});
