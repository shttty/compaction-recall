import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sqliteRecallPage } from '../benchmark/retrieval-sqlite-page.mjs';
import { LOCATOR_TYPE } from '../src/locator.mjs';
import { weightedLength } from '../prototype/soft-match-sqlite/index.mjs';

const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), date: '2026-10-04', role: 'user', snippet: 'x'.repeat(120) }));
test('SQLite renderer preserves pagination and budget; warns only for a true zero total', () => {
  const first = sqliteRecallPage(rows, { limit: 2 });
  const next = sqliteRecallPage(rows, { limit: 2, offset: first.details.nextOffset });
  assert.equal(JSON.parse(next.text.split('\n').find(line => line.startsWith('{'))).id, '2');
  const budget = sqliteRecallPage(rows.map(row => ({ ...row, id: row.id.padStart(200, 'x') })));
  assert.ok(Array.from(budget.text).length <= 16000);
  assert.equal(budget.details.total, 50);
  assert.ok(budget.details.returned > 0 && budget.details.returned < 50);
  assert.equal(budget.details.nextOffset, budget.details.returned);
  const zero = sqliteRecallPage([], {}, { total: 0, baseOffset: 0 });
  assert.equal(zero.details.total, 0);
  assert.ok(Array.from(zero.text).length <= 16000);
  const emptyOffset = sqliteRecallPage([], { offset: 50 }, { total: 50, baseOffset: 50 });
  assert.equal(emptyOffset.details.total, 50);
  assert.equal(emptyOffset.details.returned, 0);
  assert.doesNotMatch(emptyOffset.text, /未找到匹配项/);
});

test('SDK concept tool pages, validates strictly, excludes records and remains usable after errors', async t => {
  const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
  const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL('../benchmark/retrieval-sqlite-adapter.ts', import.meta.url))], process.cwd(), process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const recall = extension.tools.get('history_recall').definition;
  const timestamp = '2026-10-04T00:00:00Z';
  const ctx = {
    sessionManager: {
      getSessionId: () => 'concept-fixture', getBranch: () => [
        { type: 'message', id: 'match', timestamp, message: { role: 'user', content: 'alpha beta gamma delta epsilon zeta tailneedle' } },
        { type: 'message', id: 'second', timestamp, message: { role: 'user', content: 'alpha independent evidence' } },
        { type: 'message', id: 'live', timestamp, message: { role: 'user', content: 'retained' } },
        { type: 'compaction', id: 'compact', timestamp, firstKeptEntryId: 'live', summary: '', tokensBefore: 10 },
      ]
    }
  };
  t.after(async () => { for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx); });
  const first = await recall.execute('first', { concepts: [['alpha']], limit: 1 }, undefined, undefined, ctx);
  assert.equal(first.details.total, 2);
  assert.equal(first.details.returned, 1);
  assert.equal(first.details.hasMore, true);
  const next = await recall.execute('next', { concepts: [['alpha']], limit: 1, offset: first.details.nextOffset }, undefined, undefined, ctx);
  assert.equal(next.details.total, 2);
  assert.equal(next.details.returned, 1);
  const ids = page => page.content[0].text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).id);
  assert.deepEqual([...ids(first), ...ids(next)].sort(), ['match', 'second']);
  const alternative = await recall.execute('alternative', { concepts: [['nonexistent', 'tailneedle']] }, undefined, undefined, ctx);
  assert.deepEqual(ids(alternative), ['match']);
  const partial = await recall.execute('partial', { concepts: [['alpha'], ['nonexistent']] }, undefined, undefined, ctx);
  assert.equal(partial.details.total, 2);
  assert.doesNotMatch(partial.content[0].text, /未找到匹配项/);
  const zero = await recall.execute('zero', { concepts: [['alpha'], ['nonexistent']], match: 'all' }, undefined, undefined, ctx);
  assert.equal(zero.details.total, 0);
  assert.equal('fallback' in zero.details, false);
  const emptyOffset = await recall.execute('offset', { concepts: [['alpha']], offset: 2 }, undefined, undefined, ctx);
  assert.equal(emptyOffset.details.total, 2);
  assert.equal(emptyOffset.details.returned, 0);
  assert.doesNotMatch(emptyOffset.content[0].text, /未找到匹配项/);
  const excluded = await recall.execute('exclude', { concepts: [['alpha']], exclude: ['beta'] }, undefined, undefined, ctx);
  assert.deepEqual(ids(excluded), ['second']);
  for (const params of [{ query: 'alpha' }, { concepts: [['alpha']], must: ['beta'] }, { concepts: [['alpha']], prefer: ['beta'] }, { concepts: [['alpha']], extra: true }]) {
    await assert.rejects(recall.execute('unknown', params, undefined, undefined, ctx), { name: 'QueryError', code: 'UNKNOWN_FIELD' });
  }
  for (const [params, code] of [
    [{ concepts: [] }, 'INVALID_ARRAY'],
    [{ concepts: Array.from({ length: 6 }, () => ['alpha']) }, 'INVALID_ARRAY'],
    [{ concepts: [['a', 'b', 'c', 'd', 'e']] }, 'INVALID_ARRAY'],
    [{ concepts: [['alpha']], exclude: Array.from({ length: 6 }, () => 'beta') }, 'INVALID_ARRAY'],
    [{ concepts: [['alpha']], match: 'other' }, 'INVALID_MODE'],
    [{ concepts: [[' ']] }, 'EMPTY_TEXT'],
    [{ concepts: [['a'.repeat(257)]] }, 'LIMIT_EXCEEDED'],
    [{ concepts: Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => 'a'.repeat(200))) }, 'LIMIT_EXCEEDED'],
  ]) await assert.rejects(recall.execute('invalid', params, undefined, undefined, ctx), { name: 'QueryError', code });
  const recovered = await recall.execute('recover', { concepts: [['beta']] }, undefined, undefined, ctx);
  assert.deepEqual(ids(recovered), ['match']);
  await assert.rejects(recall.execute('single', { concepts: [['x']] }, undefined, undefined, ctx), { name: 'QueryError', code: 'EMPTY_ANALYSIS' });
  const expand = extension.tools.get('history_expand').definition;
  const expanded = await expand.execute('expand', { id: 'match', before: 0, after: 0 }, undefined, undefined, ctx);
  assert.match(expanded.content[0].text, /alpha beta gamma delta epsilon zeta tailneedle/);
});

test('SDK independent grep finds regex neighbors, pages counts and respects current branch edits', async t => {
  const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
  const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL('../benchmark/retrieval-sqlite-adapter.ts', import.meta.url))], process.cwd(), process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const timestamp = '2026-10-06T00:00:00Z';
  const message = (id, content) => ({ type: 'message', id, timestamp, message: { role: 'user', content } });
  let branch = [message('first', 'Telescope grant $125, receipt $125 [confirmed] 晨'),
    message('second', 'telescope grant $250 baseline'), message('hidden', 'telescope grant $900 hiddenoriginal'),
    message('edited', 'telescope grant $700 oldamount'), message('other', 'orchard $999'),
    message('live', 'telescope grant $800 liveonly'),
    { type: 'compaction', id: 'compact', timestamp, firstKeptEntryId: 'live', summary: '', tokensBefore: 100 },
    { type: 'context_edit', id: 'omit', targetId: 'hidden', timestamp, replacement: null },
    { type: 'context_edit', id: 'replace', targetId: 'edited', timestamp, replacement: { content: 'telescope grant $375 approved' } }];
  const ctx = { sessionManager: { getSessionId: () => 'independent-grep', getBranch: () => branch } };
  t.after(async () => { for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx); });
  const grep = extension.tools.get('history_grep').definition;
  const run = params => grep.execute('grep', params, undefined, undefined, ctx);
  const ids = result => [...result.content[0].text.matchAll(/^\[([^\]]+)\]/gm)].map(match => match[1]);
  const pattern = 'telescope.{0,80}\\$\\d+';
  const first = await run({ pattern, limit: 1 });
  assert.deepEqual(ids(first), ['first']);
  assert.equal(first.details.total, 3);
  assert.equal(first.details.totalEntries, 3);
  assert.equal(first.details.returned, 1);
  assert.equal(first.details.nextOffset, 1);
  const next = await run({ pattern, limit: 1, offset: first.details.nextOffset });
  assert.deepEqual(ids(next), ['second']);
  const last = await run({ pattern, limit: 1, offset: next.details.nextOffset });
  assert.deepEqual(ids(last), ['edited']);
  assert.equal(last.details.nextOffset, null);
  assert.match(last.content[0].text, /\$375 approved/);
  assert.doesNotMatch(last.content[0].text, /hiddenoriginal|oldamount|liveonly/);
  const counted = await run({ pattern: '\\$\\d+', limit: 1 });
  assert.equal(counted.details.total, 5);
  assert.equal(counted.details.totalEntries, 4);
  assert.equal(counted.details.snippets + counted.details.covered + counted.details.omitted, 5);
  assert.deepEqual(ids(await run({ pattern: '[' })), ['first']); // Invalid regex uses literal matching.
  const expand = extension.tools.get('history_expand').definition;
  const expanded = await expand.execute('expand-grep-id', { id: ids(last)[0], before: 0, after: 0 }, undefined, undefined, ctx);
  assert.match(expanded.content[0].text, /\$375 approved/);
  assert.doesNotMatch(expanded.content[0].text, /oldamount/);
  await assert.rejects(extension.tools.get('history_recall').definition.execute('zero-token', { concepts: [['晨']] }, undefined, undefined, ctx), { name: 'QueryError', code: 'EMPTY_ANALYSIS' });
  branch = [message('fork', 'telescope grant $450 fork'), message('fork-live', 'retained'),
    { type: 'compaction', id: 'fork-compact', timestamp, firstKeptEntryId: 'fork-live', summary: '', tokensBefore: 10 }];
  const fork = await run({ pattern });
  assert.deepEqual(ids(fork), ['fork']);
  assert.equal(fork.details.total, 1);
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
  const unexpanded = await recall.execute('manual-no-stemming', { concepts: [['running']] }, undefined, undefined, ctx);
  assert.equal(unexpanded.details.total, 0);
  assert.equal('fallback' in unexpanded.details, false);
  const manual = await recall.execute('combined-manual', { concepts: [['runs'], ['南京市']], match: 'all' }, undefined, undefined, ctx);
  assert.equal(manual.details.total, 1);
  const manualRows = manual.content[0].text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.deepEqual(manualRows.map(row => row.id), ['joint']);
  assert.match(manualRows[0].snippet, /runs 南京市/);
  assert.doesNotMatch(manual.content[0].text, /未找到匹配项/);
});

test('SDK concept traces correlate original model input and extension mutation without provider secrets', async t => {
  const config = join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'compaction-recall.json');
  const tracePath = join(process.env.PI_CODING_AGENT_DIR, 'concept-trace.jsonl');
  const previousTiming = process.env.COMPACTION_RECALL_TIMING_FILE;
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR, 'extensions'), { recursive: true });
  writeFileSync(config, JSON.stringify({ trace: true }));
  process.env.COMPACTION_RECALL_TIMING_FILE = tracePath;
  const timestamp = '2026-10-05T00:00:00Z';
  const branch = [
    { type: 'message', id: 'evidence', timestamp, message: { role: 'user', content: 'alpha evidence 7:30' } },
    { type: 'message', id: 'live', timestamp, message: { role: 'user', content: 'live' } },
    { type: 'compaction', id: 'compact', timestamp, firstKeptEntryId: 'live', summary: '', tokensBefore: 10 },
  ];
  const ctx = { sessionManager: { getSessionId: () => 'trace-fixture', getBranch: () => branch } };
  let extension;
  t.after(async () => {
    try {
      for (const handler of extension?.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx);
    } finally {
      rmSync(config, { force: true });
      rmSync(tracePath, { force: true });
      if (previousTiming === undefined) delete process.env.COMPACTION_RECALL_TIMING_FILE;
      else process.env.COMPACTION_RECALL_TIMING_FILE = previousTiming;
    }
  });
  const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
  const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL('../benchmark/retrieval-sqlite-adapter.ts', import.meta.url))], process.cwd(), process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors, []);
  extension = loaded.extensions[0];
  const emit = async (name, event) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  };
  const recall = extension.tools.get('history_recall').definition;
  for (const [id, mutate] of [['same', false], ['changed', true]]) {
    const params = { concepts: [['alpha']], match: 'any', exclude: [], limit: 1, offset: 0 };
    await emit('message_end', { type: 'message_end', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'SECRET_REASONING' },
      { type: 'toolCall', id, name: 'history_recall', arguments: params },
    ] } });
    const event = { type: 'tool_call', toolName: 'history_recall', toolCallId: id, input: params };
    await emit('tool_call', event);
    if (mutate) event.input.concepts = [['missing']]; // Another extension's mutation before execute.
    await recall.execute(id, event.input, undefined, undefined, ctx);
  }
  await assert.rejects(recall.execute('invalid', { concepts: [] }, undefined, undefined, ctx), { name: 'QueryError', code: 'INVALID_ARRAY' });
  await recall.execute('after-error', { concepts: [['alpha']] }, undefined, undefined, ctx);
  const partial = await recall.execute('token-loss', { concepts: [['7:30']] }, undefined, undefined, ctx);
  assert.equal(partial.details.total, 1);
  assert.ok(partial.content[0].text.includes('Warning: "7:30" → ["30"]. Suggestion: revise query terms or use history_grep.'));
  await emit('before_provider_request', { type: 'before_provider_request', payload: { apiKey: 'SECRET_CREDENTIAL', thinking: 'SECRET_REASONING', reasoning_effort: 'high' } });
  await emit('agent_end', { type: 'agent_end', messages: [] });
  const raw = readFileSync(tracePath, 'utf8');
  const events = raw.trim().split('\n').map(JSON.parse);
  const calls = events.filter(event => event.type === 'history_recall_trace');
  assert.deepEqual(calls.map(call => call.input_identical), [true, false, null, null, null]);
  assert.deepEqual(calls[0].execute.params, { concepts: [['alpha']], match: 'any', exclude: [], limit: 1, offset: 0 });
  assert.deepEqual(calls[1].model.arguments.concepts, [['alpha']]);
  assert.deepEqual(calls[1].execute.input.concepts, [['missing']]);
  assert.equal('query_identical' in calls[0], false);
  assert.equal('query' in calls[0].execute, false);
  assert.equal(calls[2].error.name, 'QueryError');
  assert.equal(calls[2].error.code, 'INVALID_ARRAY');
  assert.match(calls[2].error.message, /concepts/);
  assert.deepEqual(calls[3].result.ids, ['evidence']);
  assert.equal('fallback' in calls[0].result, false);
  assert.equal('fallback' in calls[1].result, false);
  assert.equal('fallback' in calls[3].result, false);
  assert.deepEqual(calls[4].result.ids, ['evidence']);
  assert.equal(calls[4].error, null);
  assert.deepEqual(events.find(event => event.type === 'sqlite_provider_evidence'), { type: 'sqlite_provider_evidence', sessionId: 'trace-fixture', locatorPresent: false, locator: null, effort: 'high' });
  assert.doesNotMatch(raw, /SECRET_CREDENTIAL|SECRET_REASONING/);
});
