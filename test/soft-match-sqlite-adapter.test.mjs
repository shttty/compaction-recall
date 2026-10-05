import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sqliteRecallPage } from '../benchmark/retrieval-sqlite-page.mjs';
import { LOCATOR_TYPE, recallPageFromRows } from '../src/locator.mjs';
import { weightedLength } from '../prototype/soft-match-sqlite/index.mjs';

const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), date: '2026-10-04', role: 'user', snippet: 'x'.repeat(120) }));
test('SQLite renderer preserves pagination and budget; warns only for a true zero total', () => {
  assert.deepEqual(sqliteRecallPage(rows, { limit: 2 }), recallPageFromRows(rows, { limit: 2 }));
  const first = sqliteRecallPage(rows, { limit: 2 });
  const next = sqliteRecallPage(rows, { limit: 2, offset: first.details.nextOffset });
  assert.equal(JSON.parse(next.text.split('\n').find(line => line.startsWith('{'))).id, '2');
  const budget = sqliteRecallPage(rows.map(row => ({ ...row, id: row.id.padStart(200, 'x') })));
  assert.ok(Array.from(budget.text).length <= 16000);
  assert.equal(budget.details.total, 50);
  assert.ok(budget.details.returned > 0 && budget.details.returned < 50);
  assert.equal(budget.details.nextOffset, budget.details.returned);
  const zero = sqliteRecallPage([], {}, { total: 0, baseOffset: 0 });
  assert.match(zero.text, /未找到匹配项。请检查参数格式、显式运算符以及查询切词是否与索引规则一致；必要时改写查询或使用 history_grep。零命中不代表历史中不存在相关内容。/);
  assert.equal(zero.details.total, 0);
  assert.ok(Array.from(zero.text).length <= 16000);
  const emptyOffset = sqliteRecallPage([], { offset: 50 }, { total: 50, baseOffset: 50 });
  assert.equal(emptyOffset.details.total, 50);
  assert.equal(emptyOffset.details.returned, 0);
  assert.doesNotMatch(emptyOffset.text, /未找到匹配项/);
});

test('SDK adapter searches beyond old word/codepoint caps and preserves raw native errors', async t => {
  const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
  const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL('../benchmark/retrieval-sqlite-adapter.ts', import.meta.url))], process.cwd(), process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const recall = extension.tools.get('history_recall').definition;
  const timestamp = '2026-10-04T00:00:00Z';
  const ctx = {
    sessionManager: {
      getSessionId: () => 'uncapped-fixture', getBranch: () => [
        { type: 'message', id: 'match', timestamp, message: { role: 'user', content: 'alpha beta gamma delta epsilon zeta tailneedle' } },
        { type: 'message', id: 'live', timestamp, message: { role: 'user', content: 'retained' } },
        { type: 'compaction', id: 'compact', timestamp, firstKeptEntryId: 'live', summary: '', tokensBefore: 10 },
      ]
    }
  };
  t.after(async () => { for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx); });
  const many = [...Array.from({ length: 1000 }, (_, i) => `missing${i}`), 'tailneedle'].join(' OR ');
  assert.ok(many.length > 4000);
  const uncapped = await recall.execute('uncapped', { query: many }, undefined, undefined, ctx);
  assert.equal(uncapped.details.total, 1);
  assert.match(uncapped.content[0].text, /tailneedle/);
  const six = await recall.execute('six', { query: 'alpha AND beta AND gamma AND delta AND epsilon AND zeta' }, undefined, undefined, ctx);
  assert.equal(six.details.total, 1);
  const partial = await recall.execute('partial', { query: 'alpha OR nonexistent' }, undefined, undefined, ctx);
  assert.equal(partial.details.total, 1);
  assert.doesNotMatch(partial.content[0].text, /未找到匹配项/);
  const zero = await recall.execute('zero', { query: 'alpha AND nonexistent' }, undefined, undefined, ctx);
  assert.equal(zero.details.total, 0);
  assert.match(zero.content[0].text, /未找到匹配项.*history_grep.*零命中不代表历史中不存在相关内容/);
  const emptyOffset = await recall.execute('offset', { query: 'alpha', offset: 1 }, undefined, undefined, ctx);
  assert.equal(emptyOffset.details.total, 1);
  assert.equal(emptyOffset.details.returned, 0);
  assert.doesNotMatch(emptyOffset.content[0].text, /未找到匹配项/);
  await assert.rejects(recall.execute('implicit', { query: 'alpha beta' }, undefined, undefined, ctx));
  await assert.rejects(recall.execute('native', { query: '"' }, undefined, undefined, ctx), { message: 'unterminated string' });
  const recovered = await recall.execute('recover', { query: 'beta' }, undefined, undefined, ctx);
  assert.equal(recovered.details.total, 1);
});

test('SDK loads file gate/timeout once; lifecycle rebuilds retain them over later file/environment changes', async t => {
  const keys = ['COMPACTION_RECALL_SQLITE_ARM', 'COMPACTION_RECALL_AUTO_GATE', 'COMPACTION_RECALL_QUERY_TIMEOUT_MS', 'PI_RETRIEVAL_INPUT_FILE'];
  const saved = keys.map(key => process.env[key]);
  process.env.COMPACTION_RECALL_SQLITE_ARM = 'porter-jieba';
  delete process.env.COMPACTION_RECALL_AUTO_GATE;
  delete process.env.COMPACTION_RECALL_QUERY_TIMEOUT_MS;
  const config = join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'compaction-recall.json');
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR, 'extensions'), { recursive: true });
  writeFileSync(config, JSON.stringify({ autoGate: 280, recallTimeoutMs: 5000 }));
  t.after(() => rmSync(config, { force: true }));
  delete process.env.PI_RETRIEVAL_INPUT_FILE;
  t.after(() => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key];
    else process.env[key] = saved[i];
  }));
  const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
  const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL('../benchmark/retrieval-sqlite-adapter.ts', import.meta.url))], process.cwd(), process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const timestamp = '2026-10-04T00:00:00Z';
  const message = (id, content) => ({ type: 'message', id, timestamp, message: { role: 'user', content } });
  const branch = [message('english', 'runs historical engine'), message('han', '南京市 historical district'),
    message('joint', 'runs 南京市 combined evidence'), message('live', 'running 南京市 retained live'),
    { type: 'compaction', id: 'compact', timestamp, firstKeptEntryId: 'live', summary: '', tokensBefore: 10 }];
  const ctx = { sessionManager: { getSessionId: () => 'gate-composite-fixture', getBranch: () => branch } };
  t.after(async () => {
    for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx);
  });
  const recall = extension.tools.get('history_recall').definition;
  writeFileSync(config, JSON.stringify({ autoGate: 1, recallTimeoutMs: 1 }));
  process.env.COMPACTION_RECALL_AUTO_GATE = '1';
  process.env.COMPACTION_RECALL_QUERY_TIMEOUT_MS = '1';
  for (const handler of extension.handlers.get('session_tree') ?? []) await handler({ type: 'session_tree' }, ctx);
  const base = 'Where did we discuss running near 南京市? 😀𠀀𠀁';
  const padded = length => base + ' '.repeat(length - weightedLength(base));
  const locatorIds = messages => messages.filter(message => message.customType === LOCATOR_TYPE)
    .flatMap(message => message.content.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).id));
  for (const length of [279, 280, 281]) {
    let messages = [{ role: 'user', content: [{ type: 'text', text: padded(length) }], timestamp: 0 }];
    for (const handler of extension.handlers.get('context') ?? []) {
      const result = await handler({ type: 'context', messages }, ctx);
      if (result?.messages) messages = result.messages;
    }
    assert.deepEqual(locatorIds(messages).sort(), length <= 280 ? ['english', 'han', 'joint'] : []);
  }
  for (const query of ['running', '南京市', 'running AND 南京市']) {
    const raw = await recall.execute('raw-no-expansion', { query }, undefined, undefined, ctx);
    assert.equal(raw.details.total, 0);
    assert.match(raw.content[0].text, /未找到匹配项/);
  }
  const manual = await recall.execute('combined-manual', { query: 'stems:run AND "南京 京市"' + ' '.repeat(281) }, undefined, undefined, ctx);
  assert.equal(manual.details.total, 1);
  const manualRows = manual.content[0].text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.deepEqual(manualRows.map(row => row.id), ['joint']);
  assert.match(manualRows[0].snippet, /runs 南京市/);
  assert.doesNotMatch(manual.content[0].text, /未找到匹配项/);
});
