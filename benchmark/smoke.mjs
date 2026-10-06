// Runnable offline fixture, not model-accuracy evidence. All artifacts use the supplied external output.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const harness = fileURLToPath(new URL('.', import.meta.url));
const quoted = JSON.stringify;
const readJson = filename => JSON.parse(readFileSync(filename, 'utf8'));
function frozen(filename, value) {
  writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value), { flag: 'wx', mode: 0o444 });
}

async function preflight(args, guard, directory) {
  const child = spawn(process.execPath, ['--import', guard, join(harness, 'sdk/answer.mjs'), ...args], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value; });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ type: 'prompt', id: 'offline-preflight', message: 'quasar' }) + '\n');
  const code = await new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Offline SDK preflight timed out')); }, 60000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', value => { clearTimeout(timeout); resolveResult(value); });
  });
  writeFileSync(join(directory, 'rpc.stdout'), stdout, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'rpc.stderr'), stderr, { flag: 'wx', mode: 0o600 });
  assert.equal(code, 2, stderr);
  assert.match(stderr, /ROUND2_STOP_AFTER_SERIALIZATION/);
  assert.doesNotMatch(stderr, /NETWORK_GUARD|EVIDENCE_FAILED|VALIDATION_FAILED/);
}

async function runThreeArmsSmoke(candidate, output) {
  let root = resolve(candidate);
  const destination = resolve(output);
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const profile = mkdtempSync(join(tmpdir(), 'recall-three-arms-profile-'));
  try {
    const phase = { provider: 'synthetic-offline', model: 'fixture-model', effort: 'off', profile };
    writeFileSync(join(profile, 'models.json'), JSON.stringify({ providers: { 'synthetic-offline': {
      baseUrl: 'https://benchmark.invalid/v1', api: 'openai-completions', models: [{
        id: 'fixture-model', name: 'Offline fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 2048,
      }],
    } } }), { mode: 0o444 });
    writeFileSync(join(profile, 'auth.json'), JSON.stringify({ 'synthetic-offline': {
      type: 'api_key', key: 'synthetic-not-a-real-key',
    } }), { mode: 0o400 });
    const inputConfig = join(destination, 'models-config.json');
    const selected = { provider: phase.provider, model: phase.model, effort: phase.effort };
    frozen(inputConfig, { answer: selected, judges: { luna: selected, sol: selected },
      profiles: { answer: profile, luna: profile, sol: profile }, protocol: { reserve_tokens: 1024, overhead_tokens: 128 } });
    const material = join(destination, 'material'), snapshots = join(destination, 'snapshots');
    const synthetic = spawnSync('python3', ['-c', `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from runner import prepare, artifacts as run
data, source = Path(sys.argv[2]), Path(sys.argv[3])
source.mkdir()
questions, sessions = [], {}
for group, ids in [('dev8', prepare.DEV), ('hard8', prepare.HARD)]:
    for qid in ids:
        directory = data / 'data' / group / qid
        directory.mkdir(parents=True)
        question = {'question_id': qid, 'question': 'Synthetic question ' + qid, 'question_date': '2024/01/01 00:00'}
        (directory / 'question.json').write_text(json.dumps(question))
        (directory / 'answer.json').write_text(json.dumps({'question_id': qid, 'answer': 'private synthetic reference'}))
        questions.append({'id': qid, 'question': question['question'], 'question_date': question['question_date'], 'language': 'en'})
        session = source / (qid + '.jsonl')
        rows = [{'type': 'session', 'version': 3, 'id': 'synthetic-' + qid}]
        rows += [{'type': 'compaction', 'id': 'synthetic-compaction-' + str(n), 'summary': 'Synthetic offline fixture only.', 'firstKeptEntryId': 'retained'} for n in range(3)]
        session.write_text(''.join(json.dumps(row) + '\\n' for row in rows))
        sessions['pi/' + qid] = {'path': str(session), 'sha256': run.sha(session)}
identity = {'dataset': 'LME16-English', 'fixtureOnly': True, 'config': {'compression': {'provider': 'synthetic-offline', 'model': 'fixture-model', 'effort': 'off'}}}
(source / 'manifest.json').write_text(json.dumps({'state': 'complete', 'identity': identity, 'fingerprint': run.object_sha(identity), 'questions': questions, 'snapshots': sessions}))
`, harness, material, snapshots], { encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(synthetic.status, 0, synthetic.stderr);
    const prepared = join(destination, 'prepared');
    const prepareArgs = [join(harness, 'run.py'), '--config', inputConfig, '--data-root', material,
      '--snapshot-source', snapshots, '--output', prepared, '--source-root', root, '--arm', 'all', '--stage', 'prepare'];
    const prepareEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };
    const initial = spawnSync('python3', prepareArgs, { encoding: 'utf8', env: prepareEnv, timeout: 180000 });
    assert.equal(initial.status, 0, initial.stderr);
    const identities = ['pi-native', 'pi-lite', 'pi-full'].map(arm => readJson(join(prepared, arm, 'manifest.json')).fingerprint);
    const resume = spawnSync('python3', prepareArgs, { encoding: 'utf8', env: prepareEnv, timeout: 180000 });
    assert.equal(resume.status, 0, resume.stderr);
    assert.deepEqual(['pi-native', 'pi-lite', 'pi-full'].map(arm => readJson(join(prepared, arm, 'manifest.json')).fingerprint), identities);
    root = join(prepared, 'candidate');
    const sdkPath = join(root, 'node_modules/@earendil-works/pi-coding-agent');
    const configPath = join(destination, 'config.json');
    frozen(configPath, { sdk_path: sdkPath, output_dir: destination, system_prompt: 'Offline three-arm fixture system prompt.',
      protocol: { reserve_tokens: 1024, overhead_tokens: 128 },
      answer: phase, judge: phase });
    const guard = join(destination, 'network-guard.mjs');
    frozen(guard, `import net from 'node:net';
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
    const guardedBin = join(destination, 'guarded-bin'); mkdirSync(guardedBin);
    writeFileSync(join(guardedBin, 'node'), `#!/bin/sh\nexec ${quoted(process.execPath)} --import ${quoted(guard)} "$@"\n`, { flag: 'wx', mode: 0o555 });
    const serialized = spawnSync('python3', ['-c', `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from runner import artifacts as run, prepare, sdk
live = run.module('offline_cli_arguments', Path(sys.argv[1]) / 'run.py')
args = live.parser().parse_args(sys.argv[2:])
args.shared_output = args.output.resolve()
counts = []
for arm in prepare.ARMS:
    args.arm, args.output = arm, args.shared_output / arm
    output, config, pins, manifest, _, _ = prepare.prepare(args)
    sdk.serialization(output, config, pins, manifest)
    count = len(json.loads(Path(manifest['toolEvidence'][arm]['path']).read_text())['serialized'])
    counts.append(count)
    def refuse(*args, **kwargs):
        raise AssertionError('Completed serialization refuses SDK/provider replay')
    sdk.serialization(output, config, pins, manifest, rpc_runner=refuse)
assert counts == [0, 2, 3], counts
print(json.dumps({'actualRunnerSdkSerialization': counts, 'resumedWithoutSdk': True, 'providerRequests': 0}))
`, harness, ...prepareArgs.slice(1)], { encoding: 'utf8', env: { ...prepareEnv, PATH: guardedBin + ':' + process.env.PATH }, timeout: 180000 });
    assert.equal(serialized.status, 0, serialized.stderr);
    const serializationProof = JSON.parse(serialized.stdout);
    frozen(join(destination, 'serialization-resume-smoke.json'), serializationProof);
    const afterSdk = spawnSync('python3', prepareArgs, { encoding: 'utf8', env: prepareEnv, timeout: 180000 });
    assert.equal(afterSdk.status, 0, afterSdk.stderr);
    assert.deepEqual(['pi-native', 'pi-lite', 'pi-full'].map(arm => readJson(join(prepared, arm, 'manifest.json')).fingerprint), identities);
    const timestamp = '2026-10-06T00:00:00.000Z';
    const msg = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp,
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 } });
    const sessionRows = [{ type: 'session', version: 3, id: 'a2c91b46-313b-4e59-b0a0-97a5f8243827', timestamp, cwd: destination },
      msg('seven', null, 'quasar at 7:30 paid $50'), msg('eight', 'seven', 'quasar at 8:30 paid $80'),
      msg('live', 'eight', 'retained'), { type: 'compaction', id: 'compact', parentId: 'live', timestamp,
        firstKeptEntryId: 'live', summary: 'Earlier conversation compacted.', tokensBefore: 100 }];
    const results = [];
    for (const arm of ['pi-native', 'pi-lite', 'pi-full']) {
      const directory = join(destination, arm); mkdirSync(directory, { mode: 0o700 });
      const session = join(directory, 'session.jsonl'), evidencePath = join(directory, 'tools.json');
      writeFileSync(session, sessionRows.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
      const append = join(directory, 'append-system.txt'); frozen(append, 'Unmodified appended fixture instructions.');
      const args = ['--config', configPath, '--phase', 'answer', '--session', session, '--append-system-prompt', append];
      const expectedTools = arm === 'pi-native' ? [] : arm === 'pi-lite'
        ? ['history_expand', 'history_grep'] : ['history_expand', 'history_grep', 'history_recall'];
      if (arm === 'pi-native') args.push('--arm', 'native', '--tool-evidence', evidencePath, '--stop-after-serialization');
      else {
        const wrapper = join(directory, 'wrapper'); mkdirSync(wrapper);
        const recallConfig = join(directory, 'recall-config.json'); frozen(recallConfig, { mode: arm === 'pi-lite' ? 'lite' : 'full' });
        const settings = { entry: join(root, 'src/index.ts'), sdkPath,
          runtimeEvidencePath: join(directory, 'sdk-registration.json') };
        const tools = { evidencePath, expectedTools, stopAfterSerialization: true };
        const context = { directory, toolsOnly: arm === 'pi-lite' };
        frozen(join(wrapper, 'package.json'), { type: 'module', pi: { extensions: ['./entry.mjs'] } });
        frozen(join(wrapper, 'entry.mjs'), `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { registerPinned } from ${quoted(join(harness, 'sdk/extension.mjs'))};
import { withToolEvidence } from ${quoted(join(harness, 'sdk/tools-evidence.mjs'))};
import { withContextEvidence } from ${quoted(join(harness, 'sdk/context-evidence.mjs'))};
export default async pi => {
  const definitions = new Map();
  const captured = new Proxy(pi, { get(target, key) {
    if (key === 'registerTool') return tool => { definitions.set(tool.name, tool); return target.registerTool(tool); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await registerPinned(withToolEvidence(withContextEvidence(captured, ${quoted(context)}), ${quoted(tools)}), ${quoted(settings)});
  pi.on('before_agent_start', async (_event, ctx) => {
    const call = (name, args) => definitions.get(name).execute(name, args, undefined, undefined, ctx);
    const grep = await call('history_grep', { pattern: '7:3[0]' });
    assert.equal(grep.details.total, 1); assert.match(grep.content[0].text, /\\[seven\\].*7:30/);
    const expand = await call('history_expand', { id: 'seven', before: 0, after: 0 });
    assert.match(expand.content[0].text, /quasar at 7:30 paid \\$50/);
    if (definitions.has('history_recall')) assert.equal((await call('history_recall', { concepts: [['quasar']] })).details.total, 2);
    writeFileSync(${quoted(join(directory, 'tool-execution.json'))}, JSON.stringify({ grep: true, expand: true, recall: definitions.has('history_recall') }), { flag: 'wx', mode: 0o600 });
  });
};
`);
        args.push('--arm', 'production', '--plugin-dir', wrapper, '--recall-config', recallConfig);
      }
      await preflight(args, guard, directory);
      const evidence = readJson(evidencePath), context = readJson(join(directory, 'context-0001.json'));
      assert.deepEqual(evidence.registered.map(tool => tool.name), expectedTools);
      assert.deepEqual(evidence.serialized.map(tool => tool.name), expectedTools);
      assert.equal(evidence.descriptionsPreserved, true);
      assert.equal(context.serializedLocatorCount > 0, arm === 'pi-full');
      assert.equal(context.nativeLocators.length > 0, arm === 'pi-full');
      if (arm === 'pi-full') assert.match(JSON.stringify(context.nativeLocators), /seven/);
      const payload = readJson(join(directory, 'payload-0001.json'));
      assert.match(JSON.stringify(payload), /Unmodified appended fixture instructions/);
      assert.ok((payload.messages ?? payload.input).some(message => message.role === 'user' && JSON.stringify(message.content).includes('quasar')));
      for (const filename of ['payload-0001.json', 'context-0001.json', 'request-runtime-0001.json', 'tools.json']) {
        assert.equal(statSync(join(directory, filename)).mode & 0o777, 0o600);
      }
      if (arm !== 'pi-native') {
        const registered = readJson(join(directory, 'sdk-registration.json'));
        assert.equal(registered.registeredHooks.includes('context'), arm === 'pi-full');
        assert.deepEqual(readJson(join(directory, 'tool-execution.json')), { grep: true, expand: true, recall: arm === 'pi-full' });
      }
      results.push({ arm, registeredTools: expectedTools, serializedTools: expectedTools,
        locatorCount: context.serializedLocatorCount, providerRequests: 0, actualSdkDispatch: true });
    }
    const result = { candidate: root, arms: results, providerRequests: 0, cliPreparedAndResumed: true, sharedCandidateFreeze: true, ...serializationProof };
    writeFileSync(join(destination, 'three-arms-smoke.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result));
    return result;
  } finally { rmSync(profile, { recursive: true, force: true }); }
}

if (process.argv[2] === '--help' && process.argv.length === 3) {
  console.log('Usage: smoke.mjs --three-arms SOURCE_ROOT NEW_OUTPUT');
} else {
  if (process.argv[2] !== '--three-arms' || process.argv.length !== 5) throw new Error('Usage: smoke.mjs --three-arms SOURCE_ROOT NEW_OUTPUT');
  await runThreeArmsSmoke(process.argv[3], process.argv[4]);
}
