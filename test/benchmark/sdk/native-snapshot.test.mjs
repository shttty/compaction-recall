import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync as fsMktempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const worker = fileURLToPath(new URL('../../../benchmark/sdk/native-snapshot.mjs', import.meta.url));
const noNetwork = fileURLToPath(new URL('../../../benchmark/sdk/no-network.mjs', import.meta.url));
function sdkDirectory() {
  if (process.env.COMPACTION_RECALL_TEST_SDK_PATH) return path.resolve(process.env.COMPACTION_RECALL_TEST_SDK_PATH);
  let current = path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  while (!existsSync(path.join(current, 'package.json'))) current = path.dirname(current);
  return current;
}
function rows(filename) {
  return readFileSync(filename, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
test('native snapshot help needs no config or installed SDK', () => {
  const child = spawnSync(process.execPath, [worker, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /--config PATH --source PATH --session PATH --result PATH/);
  assert.match(child.stdout, /contextWindow must be 200000/);
});

test('native snapshot uses SDK threshold compaction with an offline provider boundary', t => {
  const root = fsTemp(t);
  const profile = path.join(root, 'profile');
  const output = path.join(root, 'output');
  mkdirSync(profile);
  mkdirSync(output);
  writeFileSync(path.join(profile, 'models.json'), JSON.stringify({ providers: {
    'synthetic-offline': { baseUrl: 'https://benchmark.invalid/v1', api: 'openai-responses', models: [{
      id: 'fixture-model', name: 'Offline fixture', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 448, maxTokens: 128,
    }] },
  } }));
  writeFileSync(path.join(profile, 'auth.json'), JSON.stringify({
    'synthetic-offline': { type: 'api_key', key: 'synthetic-not-a-real-key' },
  }));
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    sdk_path: sdkDirectory(), output_dir: output, system_prompt: 'Offline snapshot fixture.',
    protocol: { reserve_tokens: 32, overhead_tokens: 0 },
    answer: { provider: 'synthetic-offline', model: 'fixture-model', effort: 'high', profile },
  }));
  const sourcePath = path.join(output, 'source.jsonl');
  const sessionPath = path.join(output, 'session.jsonl');
  const resultPath = path.join(output, 'result.json');
  const source = [{ type: 'session', version: 3, id: 'offline-fixture-session',
    timestamp: new Date().toISOString(), cwd: path.join(output, 'cwd') }];
  let parentId = null;
  for (let index = 0; index < 12; index++) {
    const timestamp = Date.UTC(2000, 0, 1) + index * 1000;
    const role = index % 2 === 0 ? 'user' : 'assistant';
    const message = { role, content: [{ type: 'text', text: `synthetic offline fixture message ${index} ${'x'.repeat(400)}` }], timestamp };
    if (role === 'assistant') Object.assign(message, {
      api: 'openai-responses', provider: 'synthetic-offline', model: 'fixture-model', stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const id = (index + 1).toString(16).padStart(8, '0');
    source.push({ type: 'message', id, parentId,
      timestamp: new Date(timestamp).toISOString(), message });
    parentId = id;
  }
  writeFileSync(sourcePath, source.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o400 });
  const argv = ['--config', configPath, '--source', sourcePath, '--session', sessionPath, '--result', resultPath];
  const code = `import { main } from ${JSON.stringify(pathToFileURL(worker).href)};
let providerRequests = 0;
await main({ argv: ${JSON.stringify(argv)},
  configureModelRuntime({ modelRuntime }) {
    modelRuntime.streamSimple = (model, context, options = {}) => {
      if (model.provider !== 'synthetic-offline' || model.id !== 'fixture-model' || !Array.isArray(context.messages)) {
        throw new Error('Unexpected offline summarizer request');
      }
      if (options.reasoning !== 'high') throw new Error('Native summarizer did not preserve high effort');
      providerRequests++;
      return { result: async () => ({ role: 'assistant', content: [{ type: 'text',
        text: 'SYNTHETIC OFFLINE TEST FIXTURE SUMMARY; NOT A MODEL SUMMARY.' }], stopReason: 'stop',
        provider: model.provider, model: model.id,
        usage: { input: 21, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) };
    };
  },
  configureSession({ settingsManager }) {
    const original = settingsManager.getCompactionSettings.bind(settingsManager);
    settingsManager.getCompactionSettings = model => ({ ...original(model), keepRecentTokens: 64 });
  },
});
if (!providerRequests) throw new Error('The SDK did not request a native compaction summary');
`;
  const child = spawnSync(process.execPath, ['--import', noNetwork, '--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 30000, cwd: root, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
  });
  const evidence = ['native-compaction-events.jsonl', 'native-model-requests.jsonl'].map(name =>
    existsSync(path.join(output, name)) ? readFileSync(path.join(output, name), 'utf8') : `${name}: absent`);
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}\n${evidence.join('\n')}`);
  assert.doesNotMatch(child.stderr, /NETWORK_FORBIDDEN/);

  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  const session = rows(sessionPath);
  const sourceMessages = source.slice(1);
  const sessionMessages = session.filter(row => row.type === 'message');
  assert.equal(result.sdkVersion, '1.4.0');
  assert.equal(result.messageCount, sourceMessages.length);
  assert.ok(result.compactions.length > 0);
  assert.deepEqual(sessionMessages.map(row => [row.id, row.message.role, row.message.content, row.message.timestamp]),
    sourceMessages.map(row => [row.id, row.message.role, row.message.content, row.message.timestamp]));
  const nativeEntries = session.filter(row => row.type === 'compaction');
  assert.equal(nativeEntries.length, result.compactions.length);
  assert.ok(nativeEntries.every(row => row.fromHook === false && row.summary.trim()));
  let consumed = 0;
  const actualCuts = [];
  for (const row of session) {
    if (row.type === 'message') consumed++;
    if (row.type === 'compaction') actualCuts.push(consumed);
  }
  assert.deepEqual(result.compactions.map(row => row.cut), actualCuts);

  const eventPath = path.join(output, result.eventLog);
  const requestPath = path.join(output, result.requestLog);
  const events = rows(eventPath);
  const requests = rows(requestPath);
  assert.equal(events.length, nativeEntries.length);
  assert.ok(events.every(row => row.reason === 'threshold' && row.aborted === false && row.hasResult &&
    row.fromHook === false && row.summaryLength > 0 && row.entryId));
  assert.ok(events.every(row => row.sdkEvents.map(event => event.type).join(',') === 'compaction_start,compaction_end'));
  const completedRequests = requests.filter(row => row.type === 'request_end' && row.outcome === 'completed');
  assert.equal(completedRequests.length, result.compactions.reduce((total, row) => total + row.requestCount, 0));
  assert.ok(result.compactions.some(row => row.requestCount === 2), 'Native split turns may need two summary requests');
  assert.ok(completedRequests.every(row => row.provider === 'synthetic-offline' && row.model === 'fixture-model' &&
    row.effort === 'high' && row.usage.totalTokens === 30));
  assert.doesNotMatch(JSON.stringify({ events, requests }), /synthetic-not-a-real-key/);
  assert.equal(statSync(eventPath).mode & 0o777, 0o600);
  assert.equal(statSync(requestPath).mode & 0o777, 0o600);
});

function fsTemp(t) {
  const root = fsMktempSync(path.join(os.tmpdir(), 'native-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
