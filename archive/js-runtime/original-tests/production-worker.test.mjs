import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import register from '../index.ts';
import { buildRecallPage, withLocators } from '../locator.mjs';

const timestamp = '2026-09-30T00:00:00.000Z';
const msg = (id, content, role = 'user') => ({
  type: 'message', id, parentId: null, timestamp,
  message: { role, content, timestamp: 0 }
});
const compact = (id, firstKeptEntryId) => ({
  type: 'compaction', id, parentId: null, timestamp,
  firstKeptEntryId, summary: 'summary', tokensBefore: 100
});

function harness(initial) {
  let branch = initial;
  const tools = new Map(), hooks = new Map();
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => 'production-fixture' } };
  register({
    registerTool: tool => tools.set(tool.name, tool), on: (name, hook) => {
      const handlers = hooks.get(name) ?? []; handlers.push(hook); hooks.set(name, handlers);
    }
  });
  return {
    setBranch(value) { branch = value; },
    async emit(type, fields = {}) {
      let result;
      for (const hook of hooks.get(type) ?? []) result = await hook({ type, ...fields }, ctx);
      return result;
    },
    recall(params) { return tools.get('history_recall').execute('fixture', params, undefined, undefined, ctx); },
    async parity(query = 'quasar nebula') {
      const messages = [{ role: 'user', content: query, timestamp: 0 }];
      const actual = await this.emit('context', { messages });
      assert.equal(JSON.stringify(actual.messages), JSON.stringify(withLocators(messages, branch)));
      let offset = 0;
      do {
        const params = { query, limit: 2, offset };
        const expected = buildRecallPage(query, branch, params);
        const page = await this.recall(params);
        assert.equal(page.content[0].text, expected.text);
        assert.deepEqual(page.details, expected.details);
        offset = page.details.nextOffset;
      } while (offset !== null);
    },
  };
}

test('production context and manual pages stay scan-identical across edits, trees and incremental compaction', async () => {
  let branch = [msg('old', 'quasar nebula original'), msg('omit', 'quasar nebula omitted'),
  msg('other', 'quasar historical'), msg('live', 'quasar nebula live'), compact('c1', 'live')];
  const h = harness(branch);
  try {
    await h.emit('session_start', { reason: 'startup' });
    await h.parity();
    branch = [...branch,
    { type: 'context_edit', id: 'replace', parentId: null, timestamp, targetId: 'old', replacement: { content: 'quasar replacement' } },
    { type: 'context_edit', id: 'remove', parentId: null, timestamp, targetId: 'omit', replacement: null }];
    h.setBranch(branch);
    await h.parity();
    const edited = await h.recall({ query: 'original omitted' });
    assert.equal(edited.details.total, 0);
    const response = msg('response', 'quasar nebula assistant', 'assistant');
    response.message.stopReason = 'stop';
    // SDK message_end runs before append; turn_end observes the persisted entry.
    await h.emit('message_end', { message: response.message });
    branch = [...branch, response]; h.setBranch(branch);
    await h.emit('turn_end', {
      turnIndex: 0, message: response.message, messageEntryId: response.id,
      toolResults: [], toolResultEntryIds: [], outcome: 'completed'
    });
    await h.emit('agent_end', { messages: [response.message] });
    await h.parity();
    branch = [...branch, msg('tail2', 'retained'), compact('c2', 'tail2')]; h.setBranch(branch);
    await h.emit('session_compact', { compactionEntry: branch.at(-1), fromExtension: false });
    await h.parity();
    assert.match((await h.recall({ query: 'assistant' })).content[0].text, /"id":"response"/);
    branch = [msg('alternate', 'quasar nebula alternate'), msg('tail3', 'tail'), compact('c3', 'tail3')];
    h.setBranch(branch);
    await h.emit('session_tree', { oldLeafId: 'c2', newLeafId: 'c3' });
    await h.parity();
    assert.doesNotMatch((await h.recall({ query: 'quasar' })).content[0].text, /"id":"old"|"id":"response"/);
  } finally { await h.emit('session_shutdown', { reason: 'quit' }); }
});

for (const timingEnabled of [false, true]) {
  test(`SDK isolated package and both entries query and exit with empty stderr (timing ${timingEnabled ? 'on' : 'off'})`, () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-recall-worker-'));
    try {
      const agentDir = join(root, 'env-agent');
      mkdirSync(agentDir);
      const source = process.env.COMPACTION_RECALL_TEST_PACKAGE || fileURLToPath(new URL('..', import.meta.url));
      for (const [layout, archive] of [join(root, 'compaction-recall'), join(root, 'node_modules', 'compaction-recall')].entries()) {
        for (const file of ['package.json', 'src']) cpSync(join(source, file), join(archive, file), { recursive: true });
        for (const [index, entry] of [archive, join(archive, 'src/index.ts'), join(archive, 'src/recall-extension.ts')].entries()) {
          const timingFile = join(root, `timing-${layout}-${index}.jsonl`);
          const script = `
        import assert from 'node:assert/strict';
        import { discoverAndLoadExtensions } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
        const loaded = await discoverAndLoadExtensions([${JSON.stringify(entry)}], ${JSON.stringify(root)}, ${JSON.stringify(join(root, 'agent'))});
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 1);
        const extension = loaded.extensions[0];
        const branch = ${JSON.stringify([msg('sdk-match', 'quasar nebula fixture'), msg('sdk-second', 'quasar second'), msg('sdk-live', 'tail'), compact('sdk-c', 'sdk-live')])};
        const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => 'isolated-sdk' } };
        async function emit(type, fields = {}) {
          let result;
          for (const handler of extension.handlers.get(type) ?? []) result = await handler({ type, ...fields }, ctx);
          return result;
        }
        try {
          await emit('session_start', { reason: 'startup' });
          const context = await emit('context', { messages: [{ role: 'user', content: 'quasar', timestamp: 0 }] });
          assert.match(JSON.stringify(context.messages), /sdk-match/);
          const page = await extension.tools.get('history_recall').definition.execute('sdk', { query: 'quasar', limit: 1 }, undefined, undefined, ctx);
          assert.equal(page.details.total, 2);
          assert.equal(page.details.returned, 1);
          const next = await extension.tools.get('history_recall').definition.execute('sdk', { query: 'quasar', offset: page.details.nextOffset }, undefined, undefined, ctx);
          assert.equal(next.details.returned, 1);
          assert.notEqual(page.content[0].text, next.content[0].text);
          const grep = await extension.tools.get('history_grep').definition.execute('sdk', { pattern: 'quasar' }, undefined, undefined, ctx);
          assert.equal(grep.details.totalEntries, 2);
          const expanded = await extension.tools.get('history_expand').definition.execute('sdk', { id: 'sdk-match', before: 0, after: 0 }, undefined, undefined, ctx);
          assert.match(expanded.content[0].text, /quasar nebula fixture/);
        } finally { await emit('session_shutdown', { reason: 'quit' }); }
      `;
          const scriptPath = join(root, `host-${layout}-${index}.mjs`);
          writeFileSync(scriptPath, script);
          const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, COMPACTION_RECALL_TIMING_FILE: timingEnabled ? timingFile : '' };
          delete env.NODE_NO_WARNINGS;
          delete env.NODE_OPTIONS;
          delete env.COMPACTION_RECALL_MODE;
          delete env.COMPACTION_RECALL_PREINDEX_TURNS;
          delete env.COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS;
          const child = spawnSync(process.execPath, [scriptPath], {
            cwd: root, env, encoding: 'utf8', timeout: 30_000,
          });
          assert.ifError(child.error);
          assert.equal(child.signal, null, child.stderr);
          assert.equal(child.status, 0, child.stderr);
          assert.equal(child.stderr, '', `${entry}: worker startup/query/shutdown must not write stderr`);
          if (timingEnabled) {
            const events = readFileSync(timingFile, 'utf8').trim().split('\n').map(JSON.parse);
            assert.ok(events.some(event => event.stage === 'worker_online'), `${entry}: worker never started`);
            assert.ok(events.some(event => event.type === 'span' && event.execution === 'worker_thread' && event.stage === 'worker_query'), `${entry}: no real worker lookup`);
            assert.ok(!events.some(event => ['worker_failed', 'fallback_required'].includes(event.stage)), `${entry}: silent fallback`);
          }
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const reason of ['new', 'reload', 'resume', 'fork']) {
  test(`production ${reason} replacement discards previous branch state`, async () => {
    const first = harness([msg('old-session', 'quasar old session'), msg('tail', 'tail'), compact('c', 'tail')]);
    try { await first.emit('session_start', { reason: 'startup' }); await first.parity(); }
    finally { await first.emit('session_shutdown', { reason }); }
    const next = harness([msg('next-session', 'nebula next session'), msg('next-tail', 'tail'), compact('next-c', 'next-tail')]);
    try {
      await next.emit('session_start', { reason, previousSessionFile: '/old/session.jsonl' });
      await next.parity();
      assert.equal((await next.recall({ query: 'quasar' })).details.total, 0);
    } finally { await next.emit('session_shutdown', { reason: 'quit' }); }
  });
}
