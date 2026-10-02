import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bridge = fileURLToPath(new URL('../benchmark/sdk-rpc.mjs', import.meta.url));
function sdkDirectory() {
  if (process.env.COMPACTION_RECALL_TEST_SDK_PATH) return path.resolve(process.env.COMPACTION_RECALL_TEST_SDK_PATH);
  let current = path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  while (!existsSync(path.join(current, 'package.json'))) {
    const parent = path.dirname(current);
    if (current === parent) throw new Error('Cannot locate installed Pi SDK package');
    current = parent;
  }
  return current;
}
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recall-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  const output = path.join(root, 'output');
  const personal = path.join(root, 'personal');
  for (const directory of [profile, output, personal]) mkdirSync(directory);
  const models = {
    providers: {
      'synthetic-offline': {
        baseUrl: 'https://benchmark.invalid/v1', api: 'openai-completions',
        models: [{
          id: 'fixture-model', name: 'Offline fixture', reasoning: false,
          input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16384, maxTokens: 2048
        }],
      }
    }
  };
  writeFileSync(path.join(profile, 'models.json'), JSON.stringify(models));
  writeFileSync(path.join(profile, 'auth.json'), JSON.stringify({
    'synthetic-offline': { type: 'api_key', key: 'synthetic-not-a-real-key' },
  }));
  // These are only prerequisite files. No helper import or dataset evaluation occurs.
  writeFileSync(path.join(root, 'helper.py'), 'raise RuntimeError("must not import")\n');
  writeFileSync(path.join(root, 'data.json'), '[]');
  writeFileSync(path.join(personal, 'settings.json'), '{"defaultProvider":"must-not-use"}');
  const phase = { provider: 'synthetic-offline', model: 'fixture-model', effort: 'off', profile };
  const config = {
    sdk_path: sdkDirectory(), helper_path: path.join(root, 'helper.py'),
    data_path: path.join(root, 'data.json'), candidate_repo: root, output_dir: output,
    system_prompt: 'Offline SDK boundary fixture.',
    protocol: { segments: 4, reserve_tokens: 1024, overhead_tokens: 128 },
    ...Object.fromEntries(['compression', 'answer', 'judge'].map(name => [name, { ...phase }])),
  };
  const configPath = path.join(root, 'config.json');
  const guard = path.join(root, 'network-guard.mjs');
  writeFileSync(guard, `import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
const blocked = () => { process.stderr.write('NETWORK_GUARD: forbidden network operation\\n'); process.exit(97); };
net.Socket.prototype.connect = blocked;
net.connect = net.createConnection = tls.connect = blocked;
http.request = http.get = https.request = https.get = http2.connect = blocked;
dns.lookup = dns.resolve = dns.promises.lookup = dns.promises.resolve = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
`);
  const env = {
    PATH: process.env.PATH, HOME: personal, PI_CODING_AGENT_DIR: personal,
    OPENAI_API_KEY: 'implicit-env-key-must-not-be-used', PI_RECALL_EXTENSION: '/must/not/load.ts'
  };
  const save = () => writeFileSync(configPath, JSON.stringify(config));
  save();
  const args = (...extra) => ['--import', guard, bridge, '--config', configPath, ...extra];
  const run = (...extra) => spawnSync(process.execPath, args(...extra), { encoding: 'utf8', env, timeout: 30000 });
  const hashFiles = directory => Object.fromEntries(readdirSync(directory).sort().map(name => [name,
    createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex')]));
  return { root, output, profile, personal, config, configPath, args, run, save, env, hashFiles };
}

test('SDK bridge help needs neither config nor installed SDK', () => {
  const result = spawnSync(process.execPath, [bridge, '--help'], { encoding: 'utf8', env: {}, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--config PATH/);
  assert.match(result.stdout, /--describe/);
});

test('describe uses real SDK descriptors for all phases without network or profile writes', t => {
  const f = fixture(t);
  const before = f.hashFiles(f.profile);
  const personal = f.hashFiles(f.personal);
  for (const phase of ['compression', 'answer', 'judge']) {
    const result = f.run('--phase', phase, '--describe');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      provider: 'synthetic-offline', model: 'fixture-model', effort: 'off',
      contextWindow: 16384, maxTokens: 2048, sdk_version: '1.0.0',
    });
  }
  assert.deepEqual(f.hashFiles(f.profile), before);
  assert.deepEqual(f.hashFiles(f.personal), personal);
  assert.deepEqual(readdirSync(f.output), []);
});

test('missing config/model and unsupported effort fail closed instead of selecting or clamping', t => {
  const f = fixture(t);
  const absent = spawnSync(process.execPath, [bridge, '--phase', 'answer', '--describe'], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /--config is required/);
  for (const [change, expected] of [
    [{ model: 'absent-model' }, /explicitly declared/],
    [{ provider: 'absent-provider' }, /explicitly declared/],
    [{ effort: 'high' }, /Unsupported effort high/],
    [{ effort: '' }, /answer.effort is required/],
  ]) {
    const original = { ...f.config.answer };
    Object.assign(f.config.answer, change); f.save();
    const result = f.run('--phase', 'answer', '--describe');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, '');
    f.config.answer = original;
  }
  delete f.config.judge; f.save();
  const missingPhase = f.run('--phase', 'answer', '--describe');
  assert.notEqual(missingPhase.status, 0);
  assert.match(missingPhase.stderr, /judge must be an object/);
});

test('native RPC get_state uses exact model/effort/session and never touches profile or network', async t => {
  const f = fixture(t);
  const before = f.hashFiles(f.profile);
  const personal = f.hashFiles(f.personal);
  const session = path.join(f.output, 'state.jsonl');
  const child = spawn(process.execPath, f.args('--phase', 'answer', '--arm', 'native', '--session', session), {
    env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = ''; let stderr = ''; let response;
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (const line of stdout.split('\n').slice(0, -1)) {
      const event = JSON.parse(line);
      if (event.type === 'response' && event.id === 'state') {
        response = event;
        child.stdin.end();
      }
    }
  });
  child.stdin.write(`${JSON.stringify({ id: 'state', type: 'get_state' })}\n`);
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`SDK RPC startup timed out: ${stderr}`)); }, 30000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', exitCode => { clearTimeout(timeout); resolve(exitCode); });
  });
  assert.equal(code, 0, stderr);
  assert.equal(response?.success, true, stdout);
  assert.equal(response.data.model.provider, 'synthetic-offline');
  assert.equal(response.data.model.id, 'fixture-model');
  assert.equal(response.data.thinkingLevel, 'off');
  assert.equal(response.data.sessionFile, session);
  assert.equal(response.data.autoCompactionEnabled, false);
  assert.deepEqual(f.hashFiles(f.profile), before);
  assert.deepEqual(f.hashFiles(f.personal), personal);
  assert.ok(!readdirSync(f.output).some(name => name.startsWith('.sdk-runtime-')));
});

test('SDK read-only auth store rejects OAuth refresh persistence', async t => {
  const f = fixture(t);
  const before = f.hashFiles(f.profile);
  const { ReadOnlyAuthStorage } = await import(pathToFileURL(path.join(f.config.sdk_path, 'dist/core/auth-storage.js')).href);
  const storage = new ReadOnlyAuthStorage(path.join(f.profile, 'auth.json'));
  await assert.rejects(storage.modify('synthetic-offline', () => ({ type: 'oauth', access: 'fake', refresh: 'fake', expires: 0 })), /read.only/i);
  assert.deepEqual(f.hashFiles(f.profile), before);
});
