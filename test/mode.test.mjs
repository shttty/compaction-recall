import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import register from '../src/index.ts';

function fixture(config, envMode, work) {
  const cwd = mkdtempSync(join(tmpdir(), 'compaction-recall-mode-'));
  const agentDir = join(cwd, 'agent');
  const previousCwd = process.cwd(), previousMode = process.env.COMPACTION_RECALL_MODE;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(join(cwd, '.pi'));
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    writeFileSync(join(cwd, '.pi/compaction-recall.json'), JSON.stringify({ mode: config?.mode === 'lite' ? 'full' : 'lite' }));
    if (config !== undefined) writeFileSync(join(agentDir, 'extensions', 'compaction-recall.json'), JSON.stringify(config));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(cwd);
    if (envMode === undefined) delete process.env.COMPACTION_RECALL_MODE;
    else process.env.COMPACTION_RECALL_MODE = envMode;
    return work();
  } finally {
    process.chdir(previousCwd);
    if (previousMode === undefined) delete process.env.COMPACTION_RECALL_MODE;
    else process.env.COMPACTION_RECALL_MODE = previousMode;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  }
}
function capture() {
  const tools = new Map(), hooks = new Map();
  register({ registerTool: tool => tools.set(tool.name, tool), on: (name, hook) => hooks.set(name, hook) });
  return { tools, hooks };
}
const fullHooks = ['agent_end', 'context', 'message_end', 'session_compact', 'session_shutdown', 'session_start', 'session_tree', 'turn_end'];

test('mode uses only the agent config at registration, with environment overriding the file', async () => {
  for (const [config, env, full] of [[undefined, undefined, true], [{ mode: 'full' }, undefined, true], [{ mode: 'lite' }, undefined, false], [{ mode: 'lite' }, 'full', true], [{ mode: 'full' }, 'lite', false]]) {
    const host = fixture(config, env, capture);
    try {
      assert.deepEqual([...host.tools.keys()], full ? ['history_recall', 'history_grep', 'history_expand'] : ['history_grep', 'history_expand']);
      assert.deepEqual([...host.hooks.keys()].sort(), full ? fullHooks : []);
      if (!full) for (const tool of host.tools.values()) {
        assert.doesNotMatch(tool.description, /history_recall|locator/i);
        assert.doesNotMatch(JSON.stringify(tool.parameters), /history_recall|locator/i);
      }
    } finally { await host.hooks.get('session_shutdown')?.(); }
  }
});


test('lite grep and expand preserve full output and branch edits without changing context', async () => {
  const lite = fixture({ mode: 'lite' }, undefined, capture);
  const full = fixture({ mode: 'full' }, undefined, capture);
  const timestamp = '2026-10-03T00:00:00Z';
  const message = (id, content) => ({ type: 'message', id, timestamp, message: { role: 'user', content } });
  let branch = [message('old', 'quasar original'), message('other', 'quasar second'), message('live', 'retained'), { type: 'compaction', id: 'c', timestamp, firstKeptEntryId: 'live' }];
  const ctx = { sessionManager: { getBranch: () => branch } };
  const messages = [{ role: 'user', content: 'quasar', timestamp: 1 }];
  const snapshot = structuredClone(messages);
  const run = (host, name, params) => host.tools.get(name).execute('mode', params, undefined, undefined, ctx);
  try {
    for (const fields of [{}, { type: 'context_edit', id: 'edit', timestamp, targetId: 'old', replacement: { content: 'nebula replacement' } }]) {
      if (fields.type) branch = [...branch, fields];
      for (const [name, params] of [['history_grep', { pattern: 'quasar', limit: 1 }], ['history_grep', { pattern: 'quasar', limit: 1, offset: 1 }], ['history_expand', { id: 'old', before: 0, after: 0 }]]) {
        assert.deepEqual(await run(lite, name, params), await run(full, name, params));
      }
      for (const [event, handler] of lite.hooks) if (event === 'context') await handler({ messages }, ctx);
      assert.deepEqual(messages, snapshot);
    }
  } finally { await full.hooks.get('session_shutdown')(); }
});

test('SDK lite performs no worker startup, context injection or maintenance and times only grep/expand', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'compaction-recall-lite-sdk-'));
  try {
    const agentDir = join(cwd, 'env-agent');
    const loaderDir = join(cwd, 'sdk-agent');
    const sessionCwd = join(cwd, 'session');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    mkdirSync(join(loaderDir, 'extensions'), { recursive: true });
    for (const project of [cwd, sessionCwd]) {
      mkdirSync(join(project, '.pi'), { recursive: true });
      writeFileSync(join(project, '.pi/compaction-recall.json'), JSON.stringify({ mode: 'full' }));
    }
    writeFileSync(join(loaderDir, 'extensions', 'compaction-recall.json'), JSON.stringify({ mode: 'full' }));
    writeFileSync(join(agentDir, 'extensions', 'compaction-recall.json'), JSON.stringify({ mode: 'lite', preindex: { userCycles: 1, toolRounds: 1 } }));
    const timingFile = join(cwd, 'timing.jsonl');
    const scriptPath = join(cwd, 'host.mjs');
    writeFileSync(scriptPath, `
      import assert from 'node:assert/strict';
      import threads from 'node:worker_threads';
      import { syncBuiltinESMExports } from 'node:module';
      let workerStarts = 0;
      threads.Worker = class { constructor() { workerStarts++; throw new Error('lite must not create workers'); } };
      syncBuiltinESMExports();
      const { discoverAndLoadExtensions } = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))});
      const loaded = await discoverAndLoadExtensions([${JSON.stringify(new URL('../src/index.ts', import.meta.url).pathname)}], process.cwd(), ${JSON.stringify(loaderDir)});
      assert.deepEqual(loaded.errors, []);
      const extension = loaded.extensions[0];
      assert.deepEqual([...extension.tools.keys()], ['history_grep', 'history_expand']);
      assert.deepEqual([...extension.handlers.keys()], []);
      let branchReads = 0;
      const branch = [
        { type: 'message', id: 'old', timestamp: '2026-10-03', message: { role: 'user', content: 'quasar evidence' } },
        { type: 'message', id: 'live', timestamp: '2026-10-03', message: { role: 'user', content: 'retained' } },
        { type: 'compaction', id: 'c', timestamp: '2026-10-03', firstKeptEntryId: 'live' },
      ];
      const ctx = { cwd: ${JSON.stringify(sessionCwd)}, sessionManager: { getBranch: () => { branchReads++; return branch; } } };
      let messages = [{ role: 'user', content: 'quasar', timestamp: 1 }];
      const before = JSON.stringify(messages);
      for (const type of ['session_start', 'message_end', 'turn_end', 'agent_end', 'session_compact', 'session_tree', 'context']) {
        for (const handler of extension.handlers.get(type) ?? []) {
          const result = await handler({ type, messages, message: messages[0], toolResults: [{}] }, ctx);
          if (result?.messages) messages = result.messages;
        }
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(branchReads, 0); assert.equal(workerStarts, 0); assert.equal(JSON.stringify(messages), before);
      const grep = await extension.tools.get('history_grep').definition.execute('lite', { pattern: 'quasar' }, undefined, undefined, ctx);
      assert.equal(grep.details.totalEntries, 1);
      const expanded = await extension.tools.get('history_expand').definition.execute('lite', { id: 'old', before: 0, after: 0 }, undefined, undefined, ctx);
      assert.match(expanded.content[0].text, /quasar evidence/);
      for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx);
      assert.equal(workerStarts, 0);
    `);
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, COMPACTION_RECALL_TIMING_FILE: timingFile };
    for (const key of ['COMPACTION_RECALL_MODE', 'COMPACTION_RECALL_PREINDEX_TURNS', 'COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS', 'NODE_OPTIONS', 'NODE_NO_WARNINGS']) delete env[key];
    const child = spawnSync(process.execPath, [scriptPath], { cwd, env, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const events = readFileSync(timingFile, 'utf8').trim().split('\n').map(JSON.parse);
    const stages = new Set(events.map(event => event.stage));
    for (const stage of ['tool_history_grep_total', 'grep_scan', 'grep_pagination_render', 'tool_history_expand_total', 'expand']) assert.ok(stages.has(stage), stage);
    const allowed = new Set(['tool_history_grep_total', 'grep_scan', 'grep_pagination_render', 'tool_history_expand_total', 'expand', 'branch_copy', 'branch_selection_projection', 'text_extraction']);
    assert.ok(events.every(event => allowed.has(event.stage)), JSON.stringify([...stages]));
    assert.ok(events.every(event => event.execution !== 'worker_thread'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SDK agentDir cannot redirect recall config, while fresh loads honor file changes and mode overrides', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'compaction-recall-sdk-config-'));
  try {
    const agentDir = join(cwd, 'env-agent');
    const loaderDir = join(cwd, 'sdk-agent');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    mkdirSync(join(loaderDir, 'extensions'), { recursive: true });
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(loaderDir, 'extensions', 'compaction-recall.json'), JSON.stringify({ mode: 'lite' }));
    writeFileSync(join(cwd, '.pi/compaction-recall.json'), JSON.stringify({ mode: 'lite' }));
    const scriptPath = join(cwd, 'reload.mjs');
    writeFileSync(scriptPath, `
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      import { discoverAndLoadExtensions } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
      async function load(mode) {
        const loaded = await discoverAndLoadExtensions([${JSON.stringify(new URL('../src/index.ts', import.meta.url).pathname)}], process.cwd(), ${JSON.stringify(loaderDir)});
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 1);
        const extension = loaded.extensions[0];
        assert.deepEqual([...extension.tools.keys()], mode === 'full' ? ['history_recall', 'history_grep', 'history_expand'] : ['history_grep', 'history_expand']);
        assert.deepEqual([...extension.handlers.keys()].sort(), mode === 'full' ? ${JSON.stringify(fullHooks)} : []);
        for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'reload' }, {});
        return extension;
      }
      const first = await load('full');
      writeFileSync(${JSON.stringify(join(agentDir, 'extensions', 'compaction-recall.json'))}, JSON.stringify({ mode: 'lite' }));
      await load('lite');
      assert.ok(first.tools.has('history_recall'));
      process.env.COMPACTION_RECALL_MODE = 'full';
      await load('full');
      writeFileSync(${JSON.stringify(join(agentDir, 'extensions', 'compaction-recall.json'))}, JSON.stringify({ mode: 'full' }));
      process.env.COMPACTION_RECALL_MODE = 'lite';
      await load('lite');
      delete process.env.COMPACTION_RECALL_MODE;
      await load('full');
    `);
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
    for (const key of ['COMPACTION_RECALL_MODE', 'COMPACTION_RECALL_PREINDEX_TURNS', 'COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS', 'COMPACTION_RECALL_TIMING_FILE', 'NODE_OPTIONS', 'NODE_NO_WARNINGS']) delete env[key];
    const child = spawnSync(process.execPath, [scriptPath], { cwd, env, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
