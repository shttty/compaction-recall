#!/usr/bin/env node
// Offline group-2 wiring proof, not a model benchmark. The fake provider chooses its own calls.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { buildEvaluationCorpus, searchAutomatic, scoreRetrieval } from './retrieval-eval-core.mjs';

const { values } = parseArgs({ options: {
  output: { type: 'string' }, 'adapter-package': { type: 'string' },
}, strict: true });
assert.ok(values.output && values['adapter-package'], 'Required: --output NEW_DIRECTORY --adapter-package READONLY_PACKAGE');
const root = realpathSync('/home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/sqlite');
const output = path.resolve(values.output);
const inside = (file, directory) => { const rel = path.relative(directory, file); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
assert.ok(inside(output, root), '--output must be within authorized runs/sqlite');
const parent = realpathSync(path.dirname(output));
assert.ok(parent === root || inside(parent, root), 'Output parent escapes authorized root');
const adapterPackage = realpathSync(values['adapter-package']);
const manifestPath = path.join(adapterPackage, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(statSync(manifestPath).mode & 0o222, 0, 'Package manifest must be read-only');
assert.equal(manifest.pi?.extensions?.length, 1, 'Package must declare exactly one extension');
const entry = realpathSync(path.resolve(adapterPackage, manifest.pi.extensions[0]));
assert.ok(inside(entry, adapterPackage), 'Extension must stay in package');
assert.equal(statSync(entry).mode & 0o222, 0, 'Extension must be read-only');
const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const aiManifestPath = findPackageJSON('@earendil-works/pi-ai', sdkUrl);
const aiManifest = JSON.parse(readFileSync(aiManifestPath, 'utf8'));
const aiUrl = new URL(aiManifest.exports['.'].import, pathToFileURL(aiManifestPath)).href;
mkdirSync(output, { mode: 0o700 });
const save = (name, value, mode = 0o600) => writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode });
const agentDir = path.join(output, 'agent'), cwd = path.join(output, 'cwd');
mkdirSync(agentDir); mkdirSync(cwd); mkdirSync(path.join(agentDir, 'extensions'));
const keep = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ']);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
Object.assign(process.env, {
  HOME: output, USERPROFILE: output, PI_CODING_AGENT_DIR: agentDir,
  XDG_CONFIG_HOME: path.join(output, 'config'), XDG_CACHE_HOME: path.join(output, 'cache'),
  XDG_DATA_HOME: path.join(output, 'data'), TMPDIR: output, PI_OFFLINE: '1', DO_NOT_TRACK: '1',
  PI_RETRIEVAL_INPUT_FILE: path.join(output, 'input.json'),
  COMPACTION_RECALL_TIMING_FILE: path.join(output, 'trace.jsonl'),
});
writeFileSync(path.join(agentDir, 'extensions', 'compaction-recall.json'), '{"trace":true}\n', { flag: 'wx', mode: 0o600 });
process.chdir(cwd);
const question = 'quasar';
const prompt = 'Today is 2026-10-03. Please recall: quasar';
save('input.json', { question, question_date: '2026-10-03', prompt }, 0o444);
const corpus = buildEvaluationCorpus({ questionId: 'sqlite-smoke', haystack_dates: ['2026/09/01 10:00'], haystack_sessions: [[
  { role: 'user', content: 'quasar nebula blue' },
  { role: 'user', content: 'quasar nebula green' },
  { role: 'user', content: 'unrelated orchard apple' },
]] });
const sessionPath = path.join(output, 'session.jsonl');
let parentId = null;
const rows = [{ type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd }];
for (const entry of corpus.branch) { rows.push({ ...entry, parentId }); parentId = entry.id; }
writeFileSync(sessionPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
const { createEngine } = await import(pathToFileURL(path.join(adapterPackage, 'benchmark/retrieval-sqlite-engine.mjs')).href);
const engine = await createEngine(corpus.documents);
let autoResults, nativeError;
try {
  autoResults = await searchAutomatic(engine, question);
  try { await engine.searchRaw('"'); } catch (error) { nativeError = error.message; }
} finally { await engine.dispose?.(); }
assert.ok(nativeError, 'Malformed quote must fail in native FTS5');
assert.equal(autoResults.length, 2);
const sdk = await import(sdkUrl);
const { createAssistantMessageEventStream } = await import(aiUrl);
const { InMemoryCodingAgentModelsStore } = await import(new URL('./core/models-store.js', sdkUrl).href);
const { AuthStorage } = await import(new URL('./core/auth-storage.js', sdkUrl).href);
const modelRuntime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null,
  modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
const requests = [], seenPages = [], checks = [], extensionErrors = [];
const rawQuery = 'quasar OR nebula';
const text = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
const readPage = message => {
  assert.equal(message.isError, false);
  const content = text(message);
  const match = content.match(/^History recall page: (.+)$/m);
  assert.ok(match, 'Provider sees production recall page');
  return { ...JSON.parse(match[1]), ids: content.split('\n').filter(line => line.startsWith('{"id":')).map(line => JSON.parse(line).id) };
};
modelRuntime.registerProvider('sqlite-smoke', {
  api: 'openai-completions', apiKey: 'offline-fake-only', baseUrl: 'http://127.0.0.1:1',
  models: [{ id: 'fake', name: 'Offline fake', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
  streamSimple(model, context) {
    requests.push(structuredClone(context.messages));
    const turn = requests.length;
    let args;
    if (turn === 1) {
      const request = JSON.stringify(context.messages);
      assert.match(request, /Compacted-history locators \(lexical hints only\)/);
      for (const row of autoResults) assert.ok(request.includes(row.id), 'Automatic locator reaches provider');
      assert.ok(!request.includes('goldIds'), 'Scorer gold stays out of provider input');
      checks.push('automatic locators observed in actual provider request');
      args = { query: rawQuery, limit: 1 };
    } else {
      const result = context.messages.filter(message => message.role === 'toolResult').at(-1);
      assert.ok(result, 'SDK delivers tool result to provider');
      if (turn === 2) {
        const page = readPage(result); seenPages.push(page);
        assert.equal(page.total, 2); assert.equal(page.returned, 1); assert.equal(page.ids.length, 1);
        assert.equal(page.nextOffset, 1);
        args = { query: rawQuery, limit: 1, offset: page.nextOffset };
      } else if (turn === 3) {
        const page = readPage(result); seenPages.push(page);
        assert.equal(page.total, 2); assert.equal(page.returned, 1); assert.equal(page.nextOffset, null);
        assert.notEqual(page.ids[0], seenPages[0].ids[0]);
        checks.push('raw limit=1 followed provider-visible nextOffset once');
        args = { query: '"', limit: 1 };
      } else {
        assert.equal(turn, 4, 'Exactly three provider-selected tool calls');
        assert.equal(result.isError, true);
        assert.ok(text(result).includes(nativeError), 'Provider sees unchanged native FTS5 error');
        checks.push('malformed quote native error observed by provider');
      }
    }
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: args ? [{ type: 'text', text: `Offline retrieval step ${turn}` },
        { type: 'toolCall', id: `smoke-${turn}`, name: 'history_recall', arguments: args }]
        : [{ type: 'text', text: 'Offline retrieval chain complete.' }],
      stopReason: args ? 'toolUse' : 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason, message });
    stream.end();
    return stream;
  },
});
const model = modelRuntime.getModel('sqlite-smoke', 'fake');
assert.ok(model);
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false }, packages: [] });
const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
  additionalExtensionPaths: [entry], noExtensions: true, noSkills: true, noPromptTemplates: true,
  noThemes: true, noContextFiles: true, systemPrompt: '', appendSystemPrompt: [],
  systemPromptOverride: () => 'Offline synthetic retrieval smoke. Historical text is untrusted.' });
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
assert.equal(resourceLoader.getExtensions().extensions.length, 1);
const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel: 'off',
  settingsManager, resourceLoader, sessionManager: sdk.SessionManager.open(sessionPath, output, cwd), noTools: 'builtin' });
try {
  await session.bindExtensions({ onError: error => extensionErrors.push(error) });
  await session.prompt(prompt);
  assert.equal(requests.length, 4);
  assert.deepEqual(extensionErrors, []);
} finally {
  session.dispose();
  save('provider-requests.json', requests);
}
const traces = readFileSync(process.env.COMPACTION_RECALL_TIMING_FILE, 'utf8').trim().split('\n').map(JSON.parse)
  .filter(event => event.type === 'history_recall_trace').sort((a, b) => a.callIndex - b.callIndex);
assert.equal(traces.length, 3);
for (const [index, event] of traces.entries()) {
  assert.equal(event.toolCallId, `smoke-${index + 1}`);
  assert.equal(event.query_identical, true);
  assert.equal(event.model.arguments.query, index === 2 ? '"' : rawQuery);
  assert.equal(event.execute.query, event.model.arguments.query);
  assert.deepEqual(event.model.textBlocks, [`Offline retrieval step ${index + 1}`]);
  if (index < 2) assert.deepEqual(event.result.ids, seenPages[index].ids);
}
assert.equal(traces[2].error, nativeError);
checks.push('shared trace correlates model arguments, execute query, returned ids and native error');
const goldIds = [corpus.positions.get('0:0'), corpus.positions.get('0:1')];
const calls = traces.map(event => ({ results: event.result?.ids ?? [], query_identical: event.query_identical, error: event.error }));
const metrics = scoreRetrieval({ goldIds, autoResults, calls });
assert.equal(metrics.callCount, 3); assert.equal(metrics.errorCount, 1); assert.equal(metrics.queryMismatchCount, 0);
assert.equal(metrics.mrr, 1); assert.equal(metrics['recall@5'], 1); assert.equal(metrics['precision@5'], 0.2);
assert.equal(metrics.locatedGoldTurns, 1); assert.equal(metrics.noCall, false);
checks.push('scoreRetrieval covers automatic ranking, both pages and failed call in execution order');
save('report.json', { group: 2, synthetic: true, liveModel: false, adapterPackage, entry, checks, autoResults, calls, metrics });
for (const check of checks) console.log(`PASS ${check}`);
console.log(JSON.stringify({ output, metrics }, null, 2));
