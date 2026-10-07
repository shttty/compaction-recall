import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bridge = fileURLToPath(new URL('../../../benchmark/sdk/session.mjs', import.meta.url));
const helper = fileURLToPath(new URL('../../../benchmark/sdk/package.mjs', import.meta.url));
const guard = fileURLToPath(new URL('../../../benchmark/sdk/no-network.mjs', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const readJson = filename => JSON.parse(readFileSync(filename, 'utf8'));
const rows = filename => readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'package-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'output'), profile = join(root, 'profile'), product = join(output, 'package');
  for (const directory of [output, profile, product]) mkdirSync(directory);
  let sdkPath = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  while (!existsSync(join(sdkPath, 'package.json'))) sdkPath = dirname(sdkPath);
  writeFileSync(join(profile, 'models.json'), JSON.stringify({ providers: { 'synthetic-offline': {
    baseUrl: 'https://benchmark.invalid/v1', api: 'openai-completions', models: [{
      id: 'fixture-model', name: 'Offline fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 2048,
    }],
  } } }));
  writeFileSync(join(profile, 'auth.json'), JSON.stringify({ 'synthetic-offline': { type: 'api_key', key: 'synthetic-not-a-real-key' } }));
  const phase = { provider: 'synthetic-offline', model: 'fixture-model', effort: 'off', profile };
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ sdk_path: sdkPath, output_dir: output, system_prompt: 'Exact configured system.',
    protocol: { reserve_tokens: 1024, overhead_tokens: 128 }, answer: phase, judge: phase }));
  const frozen = (name, value) => { const target = join(product, name); writeFileSync(target, value); chmodSync(target, 0o444); return target; };
  frozen('package.json', JSON.stringify({ name: 'arbitrary-fixture', version: '0.0.0', type: 'module',
    pi: { extensions: ['./first.mjs', './second.mjs'], skills: ['./declared-skills'] } }));
  frozen('first.mjs', `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function (pi) {
 const schema = { type: 'object', properties: { value: { type: 'string', description: 'Exact nested description.' } }, required: ['value'] };
 const staticTool = { name: 'static_fixture', description: 'Exact static description.', parameters: schema,
  execute: async (id, params) => ({ content: [{ type: 'text', text: params.value }], details: { preserved: true } }) };
 pi.registerTool(staticTool);
 const unsubscribe = pi.on('session_start', () => { throw new Error('Removed hook ran'); });
 unsubscribe();
 pi.on('session_start', async () => {
  const marker = join(process.env.HOME, 'state.txt');
  const previous = existsSync(marker) ? readFileSync(marker, 'utf8') : 'initial';
  writeFileSync(marker, previous === 'initial' ? 'persistent' : previous);
  const dynamicTool = { name: 'dynamic_fixture', description: 'Exact dynamic description.', parameters: schema,
   execute: async (id, params) => { if (params.value === 'fail') throw new Error('Expected tool error');
    return { content: [{ type: 'text', text: previous }], details: { value: params.value } }; } };
  pi.registerTool(dynamicTool);
  await staticTool.execute('static-call', { value: 'static output' });
  await dynamicTool.execute('dynamic-call', { value: 'dynamic output' });
  try { await dynamicTool.execute('error-call', { value: 'fail' }); } catch {}
 });
 pi.on('session_before_compact', event => ({ compaction: { summary: 'Synthetic exact compaction.',
  firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
  details: { generic: true } } }));
}`);
  frozen('second.mjs', `export default function (pi) {
 pi.registerTool({ name: 'other_fixture', description: 'Exact second entry description.', parameters: { type: 'object', properties: {} },
  execute: async () => ({ content: [{ type: 'text', text: 'other output' }] }) });
}`);
  for (const name of ['declared-skills', 'undeclared-skills']) {
    mkdirSync(join(product, name)); mkdirSync(join(product, name, 'one'));
    frozen(`${name}/one/SKILL.md`, `---\nname: ${name}\ndescription: synthetic ${name}\n---\nNo network.\n`);
  }
  const session = name => {
    const directory = join(output, name); mkdirSync(directory);
    const filename = join(directory, 'session.jsonl');
    const timestamp = new Date(0).toISOString();
    writeFileSync(filename, [
      { type: 'session', version: 3, id: 'fixture-session', timestamp, cwd: directory },
      { type: 'message', id: 'user-one', parentId: null, timestamp, message: { role: 'user', content: 'Old exact user context.', timestamp: 0 } },
      { type: 'message', id: 'assistant-one', parentId: 'user-one', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Old exact assistant context.' }],
        api: 'openai-completions', provider: 'synthetic-offline', model: 'fixture-model', stopReason: 'stop', timestamp: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
      { type: 'message', id: 'user-two', parentId: 'assistant-one', timestamp, message: { role: 'user', content: 'Recent context to retain.'.repeat(5000), timestamp: 0 } },
    ].map(JSON.stringify).join('\n') + '\n');
    return filename;
  };
  const args = (filename, phaseName, home, ...extra) => ['--import', guard, helper, '--config', config,
    '--phase', phaseName, '--session', filename, '--arm', 'package', '--plugin-dir', product, '--home', home, ...extra];
  return { root, output, product, config, session, args };
}

async function rpc(args, command, stop = false) {
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  let stdout = '', pending = '', stderr = '';
  const events = [];
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    stdout += chunk; pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line); events.push(event);
      if (!stop && ((event.type === 'response' && event.id === command.id) || event.type === 'agent_end')) child.stdin.end();
      if (stop && event.type === 'agent_end') child.stdin.end();
    }
  });
  child.stdin.write(JSON.stringify(command) + '\n');
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Package RPC timeout: ${stderr}\n${stdout}`)); }, 40000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  return { code, events, stdout, stderr };
}

test('actual native loading observes multiple/dynamic tools, persists home, compacts offline and binds frozen serialization', async t => {
  const f = fixture(t), home = join(f.output, 'homes', 'question');
  const compressed = f.session('compression');
  const compact = await rpc(f.args(compressed, 'compression', home), { id: 'compact', type: 'compact' });
  assert.equal(compact.code, 0, compact.stderr);
  assert.equal(compact.events.find(event => event.id === 'compact')?.success, true, compact.stdout);
  const compactEvidence = rows(join(dirname(compressed), 'compaction-events.jsonl'));
  assert.equal(compactEvidence[0].fromExtension, true);
  assert.equal(compactEvidence[0].compactionEntry.summary, 'Synthetic exact compaction.');
  assert.equal(rows(join(dirname(compressed), 'compaction-hooks.jsonl'))[0].fromExtension, true);
  const executions = rows(join(dirname(compressed), 'tool-execution.jsonl'));
  assert.deepEqual(executions.map(row => row.name), ['static_fixture', 'dynamic_fixture', 'dynamic_fixture']);
  assert.equal(executions[0].result.content[0].text, 'static output');
  assert.equal(executions[1].result.content[0].text, 'initial');
  assert.equal(executions[2].error, 'Expected tool error');
  for (const row of executions) { assert.ok(row.milliseconds >= 0); assert.ok(row.endedAt >= row.startedAt); }
  const registration = readJson(join(dirname(compressed), 'sdk-registration.json'));
  assert.deepEqual(registration.skills.map(skill => skill.name), ['declared-skills']);
  const append = join(f.root, 'append.txt'); writeFileSync(append, 'Exact appended system.');
  const preflight = f.session('preflight');
  const stopped = await rpc(f.args(preflight, 'answer', home, '--append-system-prompt', append, '--stop-after-serialization'),
    { id: 'question', type: 'prompt', message: '精确原始问题？' }, true);
  assert.equal(stopped.code, 2, stopped.stderr + stopped.stdout);
  assert.match(stopped.stderr, /ROUND2_STOP_AFTER_SERIALIZATION/);
  const frozen = join(dirname(preflight), 'tools.json'), tools = readJson(frozen);
  assert.deepEqual(tools.registered.map(tool => tool.name), ['dynamic_fixture', 'other_fixture', 'static_fixture']);
  assert.deepEqual(tools.registered, tools.serialized);
  assert.equal(tools.rawQuestion, '精确原始问题？');
  assert.equal(tools.rawQuestionSha256, digest('精确原始问题？'));
  assert.equal(tools.configuredSystemSha256, digest('Exact configured system.'));
  assert.equal(tools.appendSystemSha256, digest('Exact appended system.'));
  const contextSystem = readJson(join(dirname(preflight), 'context-system-0001.json'));
  assert.ok(contextSystem.systemPrompt.includes('Exact appended system.'), JSON.stringify(contextSystem.systemMessages));
  const wireQuestion = readJson(join(dirname(preflight), 'wire-payload-0001.json')).messages.at(-1).content;
  assert.equal(typeof wireQuestion === 'string' ? wireQuestion : wireQuestion.map(part => part.text ?? '').join(''), '精确原始问题？');
  assert.equal(rows(join(dirname(preflight), 'tool-execution.jsonl'))[1].result.content[0].text, 'persistent');
  const resumed = f.session('resumed');
  const again = await rpc(f.args(resumed, 'answer', home, '--expected-tools', frozen, '--stop-after-serialization'),
    { id: 'question', type: 'prompt', message: '精确原始问题？' }, true);
  assert.equal(again.code, 2, again.stderr + again.stdout);
  assert.equal(readJson(join(dirname(resumed), 'tools.json')).expectedMatched, true);
  const drift = readJson(frozen); drift.registered[0].description = 'Changed frozen descriptor';
  const driftPath = join(f.output, 'drift.json'); writeFileSync(driftPath, JSON.stringify(drift));
  const mismatch = f.session('mismatch');
  const rejected = await rpc(f.args(mismatch, 'answer', home, '--expected-tools', driftPath, '--stop-after-serialization'),
    { id: 'question', type: 'prompt', message: '精确原始问题？' }, true);
  assert.doesNotMatch(rejected.stderr, /ROUND2_STOP_AFTER_SERIALIZATION/);
  assert.equal(existsSync(join(dirname(mismatch), 'tools.json')), false);
});

test('compression refuses all public model methods and judge cannot accept package or persistent home', async t => {
  const f = fixture(t), session = f.session('guards'), home = join(f.output, 'homes', 'guard');
  const driver = join(f.root, 'compression-check.mjs');
  writeFileSync(driver, `import assert from 'node:assert/strict';
import { main } from ${JSON.stringify(pathToFileURL(bridge).href)};
await main({ observeSession: ({ modelRuntime, session, extensions, resourceLoader, sdk, home, phase }) => {
 assert.ok(session && extensions && resourceLoader && sdk && home);
 assert.equal(phase.model, 'fixture-model');
 for (const method of ['streamSimple', 'stream', 'complete', 'completeSimple'])
  assert.throws(() => modelRuntime[method](), /PACKAGE_COMPRESSION_MUST_NOT_CALL_MODEL/);
 process.stderr.write('FOUR_PUBLIC_METHODS_BLOCKED\\n');
} });`);
  const args = f.args(session, 'compression', home); args[2] = driver;
  const checked = await rpc(args, { id: 'state', type: 'get_state' });
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stderr, /FOUR_PUBLIC_METHODS_BLOCKED/);
  for (const extra of [['--arm', 'package', '--plugin-dir', f.product], ['--arm', 'native', '--home', home]]) {
    const result = spawnSync(process.execPath, ['--import', guard, bridge, '--config', f.config,
      '--phase', 'judge', '--session', session, ...extra], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Judge cannot load/);
  }
  const escaped = join(f.output, 'escape'); symlinkSync(f.root, escaped);
  const result = spawnSync(process.execPath, f.args(session, 'compression', join(escaped, 'home')), { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /HOME resolves outside/);
  assert.equal(existsSync(join(f.root, 'home')), false);
  const production = spawnSync(process.execPath, ['--import', guard, bridge, '--config', f.config,
    '--phase', 'answer', '--session', session, '--arm', 'production', '--plugin-dir', f.product], { encoding: 'utf8' });
  assert.notEqual(production.status, 0); assert.match(production.stderr, /exactly one/);
});

test('preloaded guard blocks transports, named imports and inherited Node children/workers', () => {
  const code = `import assert from 'node:assert/strict';
import { request } from 'node:http';
import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
for (const call of [() => fetch('https://benchmark.invalid'), () => request('http://benchmark.invalid'),
 () => https.get('https://benchmark.invalid'), () => net.connect(80, 'benchmark.invalid'),
 () => tls.connect(443, 'benchmark.invalid'), () => dns.lookup('benchmark.invalid'),
 () => dns.promises.resolve4('benchmark.invalid'), () => new dns.Resolver().resolveTxt('benchmark.invalid')])
 assert.throws(call, /BENCHMARK_NETWORK_FORBIDDEN/);
const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import { request } from 'node:http'; request('http://benchmark.invalid')"], { encoding: 'utf8' });
assert.notEqual(child.status, 0); assert.match(child.stderr, /BENCHMARK_NETWORK_FORBIDDEN/);
const worker = new Worker("import { parentPort } from 'node:worker_threads'; import { request } from 'node:http'; try { request('http://benchmark.invalid'); } catch (error) { parentPort.postMessage(error.message); }", { eval: true });
const message = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
assert.equal(message, 'BENCHMARK_NETWORK_FORBIDDEN');
await worker.terminate();
process.stdout.write('GUARDED_TRANSPORTS_AND_CHILD\\n');`;
  const result = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'GUARDED_TRANSPORTS_AND_CHILD\n');
});
