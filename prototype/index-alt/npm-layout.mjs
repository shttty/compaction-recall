import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(import.meta.url);
const nodes = ['/home/rinne/.nvm/versions/node/v24.18.0/bin/node', '/home/rinne/.hermes/tools/node-26.7.0-linux-x64/bin/node'];
const npm = '/home/rinne/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js';
const scratchBase = '/home/rinne/.hermes/cache/scratch';
const resultPath = join(source, 'benchmark/results/index-alt-20261003/npm-layout.json');

async function child() {
  const [location, mode, root] = process.argv.slice(3);
  const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
  const loaded = await discoverAndLoadExtensions([location], root, process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  const stamp = '2026-10-03T00:00:00.000Z';
  const msg = (id, content) => ({ type: 'message', id, parentId: null, timestamp: stamp, message: { role: 'user', content, timestamp: 0 } });
  const branch = [msg('npm-match', 'quasar nebula fixture'), msg('npm-second', 'quasar second'), msg('npm-live', 'quasar live must not leak'),
    { type: 'compaction', id: 'npm-c', parentId: null, timestamp: stamp, firstKeptEntryId: 'npm-live', summary: 'summary', tokensBefore: 100 }];
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => 'npm-layout' } };
  async function emit(type, fields = {}) {
    let result;
    for (const handler of extension.handlers.get(type) ?? []) result = await handler({ type, ...fields }, ctx);
    return result;
  }
  const execute = (name, params) => extension.tools.get(name).definition.execute('npm-layout', params, undefined, undefined, ctx);
  const checks = { loaded: true, mode, registeredTools: [...extension.tools.keys()] };
  try {
    if (mode === 'full') {
      assert.deepEqual(checks.registeredTools, ['history_recall', 'history_grep', 'history_expand']);
      assert.ok(extension.handlers.has('session_shutdown'));
      await emit('session_start', { reason: 'startup' });
      const context = await emit('context', { messages: [{ role: 'user', content: 'quasar', timestamp: 0 }] });
      assert.match(JSON.stringify(context.messages), /npm-match/);
      const first = await execute('history_recall', { query: 'quasar', limit: 1 });
      assert.equal(first.details.total, 2);
      assert.equal(first.details.returned, 1);
      assert.notEqual(first.details.nextOffset, null);
      const second = await execute('history_recall', { query: 'quasar', offset: first.details.nextOffset });
      assert.equal(second.details.returned, 1);
      const rows = [first, second].flatMap(page => page.content[0].text.split('\n').filter(line => line.startsWith('{')).map(JSON.parse));
      assert.deepEqual(rows.map(row => row.id).sort(), ['npm-match', 'npm-second']);
      checks.contextAndPaginatedRecall = true;
    } else {
      assert.deepEqual(checks.registeredTools, ['history_grep', 'history_expand']);
      assert.deepEqual([...extension.handlers.keys()], []);
      checks.noWorkerHooks = true;
    }
    const grep = await execute('history_grep', { pattern: 'quasar' });
    assert.equal(grep.details.totalEntries, 2);
    assert.match(grep.content[0].text, /\[npm-match\]/);
    assert.match(grep.content[0].text, /\[npm-second\]/);
    assert.doesNotMatch(grep.content[0].text, /npm-live/);
    const expanded = await execute('history_expand', { id: 'npm-match', before: 0, after: 0 });
    assert.match(expanded.content[0].text, /quasar nebula fixture/);
    checks.grepAndExpand = true;
  } finally {
    await emit('session_shutdown', { reason: 'quit' });
    checks.shutdownAwaited = true;
  }
  console.log(JSON.stringify({ node: process.version, checks }));
}

function run() {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(join(scratchBase, 'compaction-recall-npm-layout-'));
  const report = { generatedAt: new Date().toISOString(), source, layout: 'scratch/node_modules/compaction-recall', offline: true, peerInstall: false, warningSuppression: false, commands: [], runs: [] };
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key) || /^COMPACTION_RECALL_/.test(key) || ['NODE_OPTIONS', 'NODE_NO_WARNINGS', 'NODE_COMPILE_CACHE'].includes(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: join(root, 'home'), TMPDIR: root, TMP: root, TEMP: root,
    XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_CONFIG_HOME: join(root, 'xdg-config'),
    npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: '/dev/null', npm_config_globalconfig: join(root, 'global-npmrc'),
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    PI_CODING_AGENT_DIR: join(root, 'agent'), JITI_FS_CACHE: '0',
  });
  for (const path of [env.HOME, env.PI_CODING_AGENT_DIR]) mkdirSync(path, { recursive: true });
  const exec = (command, args, cwd, extra = {}) => {
    const output = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
    report.commands.push({ command, args, cwd, status: output.status, signal: output.signal, stderr: output.stderr, stdout: output.stdout });
    assert.ifError(output.error);
    assert.equal(output.signal, null, output.stderr);
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stderr, '', `${command}: stderr must be exactly empty`);
    return output.stdout;
  };
  try {
    const packed = JSON.parse(exec(nodes[0], [npm, 'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', root], source));
    assert.equal(packed.length, 1);
    assert.equal(packed[0].name, 'compaction-recall');
    assert.ok(packed[0].files.some(file => file.path === 'src/index-worker.mjs'));
    assert.ok(packed[0].files.every(file => !/^(prototype|benchmark|test)\//.test(file.path)));
    report.npm = { name: packed[0].name, version: packed[0].version, filename: packed[0].filename, fileCount: packed[0].entryCount, integrity: packed[0].integrity, files: packed[0].files.map(file => file.path) };
    const location = join(root, 'node_modules/compaction-recall');
    mkdirSync(location, { recursive: true });
    exec('tar', ['-xzf', join(root, packed[0].filename), '--strip-components=1', '-C', location], root);
    for (const node of nodes) for (const mode of ['full', 'lite']) {
      const timing = join(root, `${node === nodes[0] ? '24' : '26'}-${mode}.jsonl`);
      const summary = JSON.parse(exec(node, [script, '--child', location, mode, root], root, { COMPACTION_RECALL_MODE: mode, COMPACTION_RECALL_TIMING_FILE: timing }));
      const events = readFileSync(timing, 'utf8').trim().split('\n').map(JSON.parse);
      const workerQueries = events.filter(event => event.type === 'span' && event.execution === 'worker_thread' && event.stage === 'worker_query');
      const failures = events.filter(event => ['worker_failed', 'fallback_required'].includes(event.stage));
      assert.equal(failures.length, 0);
      if (mode === 'full') {
        assert.ok(events.some(event => event.stage === 'worker_online'));
        assert.ok(workerQueries.length >= 3);
      } else {
        assert.ok(events.every(event => event.execution !== 'worker_thread' && !event.stage.startsWith('worker_')));
      }
      report.runs.push({ executable: node, ...summary, stderr: '', workerQuerySpans: workerQueries.length, fallbackEvents: failures.length, timingStages: [...new Set(events.map(event => event.stage))] });
    }
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.stack;
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
    report.scratchRemoved = !existsSync(root);
    report.environment = { ...Object.fromEntries(Object.entries(env).filter(([key]) => /^(HOME|TMPDIR|TMP|TEMP|XDG_|npm_config_|PI_CODING_AGENT_DIR|JITI_FS_CACHE)/.test(key))) };
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({ passed: report.passed, npm: report.npm.name, fileCount: report.npm.fileCount, runs: report.runs.map(({ node, checks, stderr, workerQuerySpans }) => ({ node, mode: checks.mode, stderr, workerQuerySpans })), scratchRemoved: report.scratchRemoved, resultPath }));
}

if (process.argv[2] === '--child') await child();
else run();
