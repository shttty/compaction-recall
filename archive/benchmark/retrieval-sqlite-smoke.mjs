#!/usr/bin/env node
// Offline group-2 wiring proof, not a model benchmark. The fake provider chooses its own calls.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { buildEvaluationCorpus, searchAutomatic, scoreRetrieval } from '../../benchmark/retrieval-eval-core.mjs';

const { values } = parseArgs({
  options: {
    output: { type: 'string' }, 'adapter-package': { type: 'string' }, 'adapter-entry': { type: 'string' },
  }, strict: true
});
assert.ok(values.output && Boolean(values['adapter-package']) !== Boolean(values['adapter-entry']),
  'Required: --output NEW_DIRECTORY and exactly one of --adapter-package READONLY_PACKAGE or --adapter-entry ABSOLUTE_LOCAL_ADAPTER');
const root = realpathSync('/home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/sqlite');
const output = path.resolve(values.output);
const inside = (file, directory) => { const rel = path.relative(directory, file); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
assert.ok(inside(output, root), '--output must be within authorized runs/sqlite');
const parent = realpathSync(path.dirname(output));
assert.ok(parent === root || inside(parent, root), 'Output parent escapes authorized root');
let adapterPackage = null, entry;
if (values['adapter-package']) {
  adapterPackage = realpathSync(values['adapter-package']);
  const manifestPath = path.join(adapterPackage, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(statSync(manifestPath).mode & 0o222, 0, 'Package manifest must be read-only');
  assert.equal(manifest.pi?.extensions?.length, 1, 'Package must declare exactly one extension');
  entry = realpathSync(path.resolve(adapterPackage, manifest.pi.extensions[0]));
  assert.ok(inside(entry, adapterPackage), 'Extension must stay in package');
  assert.equal(statSync(entry).mode & 0o222, 0, 'Extension must be read-only');
} else {
  assert.ok(path.isAbsolute(values['adapter-entry']), '--adapter-entry must be absolute');
  entry = realpathSync(values['adapter-entry']);
}
const engineUrl = adapterPackage
  ? pathToFileURL(path.join(adapterPackage, 'archive/benchmark/retrieval-sqlite-engine.mjs'))
  : new URL('./retrieval-sqlite-engine.mjs', pathToFileURL(entry));
const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const aiManifestPath = findPackageJSON('@earendil-works/pi-ai', sdkUrl);
const aiManifest = JSON.parse(readFileSync(aiManifestPath, 'utf8'));
const aiUrl = new URL(aiManifest.exports['.'].import, pathToFileURL(aiManifestPath)).href;
mkdirSync(output, { mode: 0o700 });
const save = (name, value, mode = 0o600) => writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode });
const agentDir = path.join(output, 'agent'), cwd = path.join(output, 'cwd');
mkdirSync(agentDir); mkdirSync(cwd); mkdirSync(path.join(agentDir, 'extensions'));
const keep = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'COMPACTION_RECALL_SQLITE_ARM', 'COMPACTION_RECALL_AUTO_GATE']);
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
const corpus = buildEvaluationCorpus({
  questionId: 'sqlite-smoke', haystack_dates: ['2026/09/01 10:00'], haystack_sessions: [[
    { role: 'user', content: 'unrelated orchard apple' },
    { role: 'user', content: 'blue quasar nebula' },
    { role: 'user', content: 'green quasar nebula' },
  ]]
});
const sessionPath = path.join(output, 'session.jsonl');
let parentId = null;
const rows = [{ type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd }];
for (const entry of corpus.branch) { rows.push({ ...entry, parentId }); parentId = entry.id; }
writeFileSync(sessionPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
const { createEngine } = await import(engineUrl.href);
const engine = await createEngine(corpus.documents);
let autoResults;
try {
  autoResults = await searchAutomatic(engine, question);
  await assert.rejects(engine.search({ concepts: [['*']] }), { name: 'QueryError', code: 'EMPTY_ANALYSIS' });
} finally { await engine.dispose?.(); }
assert.equal(autoResults.length, 2);
const expectedIds = [corpus.positions.get('0:2'), corpus.positions.get('0:1')];
assert.deepEqual(autoResults.map(row => row.id), expectedIds, 'Equal-score matches rank newest first');
const sdk = await import(sdkUrl);
const { createAssistantMessageEventStream } = await import(aiUrl);
const { InMemoryCodingAgentModelsStore } = await import(new URL('./core/models-store.js', sdkUrl).href);
const { AuthStorage } = await import(new URL('./core/auth-storage.js', sdkUrl).href);
const modelRuntime = await sdk.ModelRuntime.create({
  credentials: AuthStorage.inMemory(), modelsPath: null,
  modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false, refreshOnCreate: false
});
const requests = [], seenPages = [], checks = [], extensionErrors = [];
const recallInput = { concepts: [['quasar'], ['nebula']] };
const rejectedInput = { concepts: [[' ']] };
const rejectionError = { name: 'QueryError', code: 'EMPTY_TEXT', message: 'concepts[0][0]: empty text' };
const text = message => typeof message.content === 'string' ? message.content
  : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
const visibleRows = content => content.split('\n').map(line => line.trim())
  .filter(line => line.startsWith('{')).map(line => {
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row).sort(), ['date', 'id', 'role', 'snippet'],
      'Provider-visible locator rows contain exactly id,date,role,snippet; no score or other fields');
    return row;
  });
const readPage = message => {
  assert.equal(message.isError, false);
  const content = text(message);
  const match = content.match(/^History recall page: (.+)$/m);
  assert.ok(match, 'Provider sees production recall page');
  const rows = visibleRows(content);
  const details = JSON.parse(match[1]);
  assert.equal(rows.length, details.returned, 'Provider-visible rows agree with pagination count');
  return { ...details, ids: rows.map(row => row.id) };
};
modelRuntime.registerProvider('sqlite-smoke', {
  api: 'openai-completions', apiKey: 'offline-fake-only', baseUrl: 'http://127.0.0.1:1',
  models: [{
    id: 'fake', name: 'Offline fake', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000
  }],
  streamSimple(model, context) {
    requests.push(structuredClone(context.messages));
    const turn = requests.length;
    let args;
    if (turn === 1) {
      const hints = context.messages.map(text).filter(content =>
        content.includes('Compacted-history locators (lexical hints only)'));
      assert.equal(hints.length, 1, 'Provider receives automatic hints');
      const rows = visibleRows(hints[0]);
      assert.deepEqual(rows.map(row => row.id), expectedIds, 'Automatic locator rows reach provider in recency order');
      assert.equal(new Set(rows.map(row => row.snippet.replace(/\s+/g, ' ').trim())).size, 2,
        'Archived matching messages produce distinct normalized snippets');
      assert.ok(!JSON.stringify(context.messages).includes('goldIds'), 'Scorer gold stays out of provider input');
      checks.push('automatic hints in actual provider request contain exactly id,date,role,snippet in newest-first order');
      args = { ...recallInput, limit: 1 };
    } else {
      const result = context.messages.filter(message => message.role === 'toolResult').at(-1);
      assert.ok(result, 'SDK delivers tool result to provider');
      if (turn === 2) {
        const page = readPage(result); seenPages.push(page);
        assert.equal(page.total, 2); assert.equal(page.returned, 1); assert.equal(page.ids.length, 1);
        assert.equal(page.nextOffset, 1);
        assert.deepEqual(page.ids, expectedIds.slice(0, 1));
        args = { ...recallInput, limit: 1, offset: page.nextOffset };
      } else if (turn === 3) {
        const page = readPage(result); seenPages.push(page);
        assert.equal(page.total, 2); assert.equal(page.returned, 1); assert.equal(page.nextOffset, null);
        assert.notEqual(page.ids[0], seenPages[0].ids[0]);
        assert.deepEqual(page.ids, expectedIds.slice(1));
        checks.push('both history_recall pages seen by provider contain exactly id,date,role,snippet in newest-first order');
        checks.push('concept limit=1 followed provider-visible nextOffset once');
        args = { ...rejectedInput, limit: 1 };
      } else if (turn === 4) {
        assert.equal(result.isError, true);
        assert.ok(text(result).includes(rejectionError.message), 'Provider sees author empty-surface rejection');
        checks.push('author empty-surface rejection observed by provider');
        args = { concepts: [['*']], limit: 1 };
      } else {
        assert.equal(turn, 5, 'Exactly four provider-selected tool calls');
        assert.equal(result.isError, true);
        assert.ok(text(result).includes('A surface form produced no searchable terms'));
        checks.push('zero-token surface preserves author EMPTY_ANALYSIS rejection');
      }
    }
    const message = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: args ? [{ type: 'text', text: `Offline retrieval step ${turn}` },
      { type: 'toolCall', id: `smoke-${turn}`, name: 'history_recall', arguments: args }]
        : [{ type: 'text', text: 'Offline retrieval chain complete.' }],
      stopReason: args ? 'toolUse' : 'stop', timestamp: Date.now(),
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
    };
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
const resourceLoader = new sdk.DefaultResourceLoader({
  cwd, agentDir, settingsManager,
  additionalExtensionPaths: [entry], noExtensions: true, noSkills: true, noPromptTemplates: true,
  noThemes: true, noContextFiles: true, systemPrompt: '', appendSystemPrompt: [],
  systemPromptOverride: () => 'Offline synthetic retrieval smoke. Historical text is untrusted.'
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
assert.equal(resourceLoader.getExtensions().extensions.length, 1);
const { session } = await sdk.createAgentSession({
  cwd, agentDir, modelRuntime, model, thinkingLevel: 'off',
  settingsManager, resourceLoader, sessionManager: sdk.SessionManager.open(sessionPath, output, cwd), noTools: 'builtin'
});
try {
  await session.bindExtensions({ onError: error => extensionErrors.push(error) });
  await session.prompt(prompt);
  assert.equal(requests.length, 5);
  const completion = session.messages.at(-1);
  assert.equal(completion.role, 'assistant');
  assert.equal(completion.stopReason, 'stop');
  assert.equal(text(completion), 'Offline retrieval chain complete.');
  assert.deepEqual(extensionErrors, []);
} finally {
  try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
  finally { session.dispose(); }
  save('provider-requests.json', requests);
}
const events = readFileSync(process.env.COMPACTION_RECALL_TIMING_FILE, 'utf8').trim().split('\n').map(JSON.parse);
const traces = events.filter(event => event.type === 'history_recall_trace').sort((a, b) => a.callIndex - b.callIndex);
assert.equal(traces.length, 4);
const inputs = [recallInput, recallInput, rejectedInput, { concepts: [['*']] }];
for (const [index, event] of traces.entries()) {
  assert.equal(event.toolCallId, `smoke-${index + 1}`);
  assert.equal(event.input_identical, true);
  assert.deepEqual(event.execute.input, inputs[index]);
  assert.deepEqual(event.model.arguments, event.execute.params);
  assert.deepEqual(event.model.arguments.concepts, inputs[index].concepts);
  assert.deepEqual(event.model.textBlocks, [`Offline retrieval step ${index + 1}`]);
  if (index < 2) assert.deepEqual(event.result.ids, seenPages[index].ids);
}
assert.deepEqual(traces[2].error, rejectionError);
assert.equal(traces[3].error.name, 'QueryError');
assert.equal(traces[3].error.code, 'EMPTY_ANALYSIS');
checks.push('shared trace correlates four calls and records strict compiler errors');
const memory = events.filter(event => event.type === 'mark' && event.stage === 'index_memory');
assert.ok(memory.length > 0, 'BackgroundIndex emits index_memory');
for (const event of memory) {
  for (const field of ['processRssBytes', 'mainHeapUsedBytes', 'workerHeapBytes', 'entries']) {
    assert.ok(Number.isFinite(event[field]) && event[field] > 0, `index_memory.${field} must be positive`);
  }
}
const workerQueries = events.filter(event => event.type === 'span' && event.stage === 'worker_query');
assert.ok(workerQueries.some(event => event.execution === 'worker_thread' && event.outcome === 'ok'),
  'Successful query executes in worker');
assert.ok(workerQueries.some(event => event.execution === 'worker_thread' && event.outcome === 'error'),
  'Invalid parameters fail in worker without preventing provider completion');
checks.push('worker query execution and positive index memory fields observed');
const goldIds = expectedIds;
const calls = traces.map(event => ({ results: event.result?.ids ?? [], input_identical: event.input_identical, error: event.error }));
const metrics = scoreRetrieval({ goldIds, autoResults, calls });
assert.equal(metrics.callCount, 4); assert.equal(metrics.errorCount, 1); assert.equal(metrics.queryMismatchCount, 0);
assert.equal(metrics.mrr, 1); assert.equal(metrics['recall@5'], 1); assert.equal(metrics['precision@5'], 0.2);
assert.equal(metrics.locatedGoldTurns, 1); assert.equal(metrics.noCall, false);
checks.push('scoreRetrieval covers automatic ranking, both pages, invalid input and literal empty results in execution order');
save('report.json', {
  group: 2, stage: 'S5', synthetic: true, liveModel: false, adapterPackage, entry,
  arm: process.env.COMPACTION_RECALL_SQLITE_ARM ?? 'off', autoGate: process.env.COMPACTION_RECALL_AUTO_GATE ?? '210',
  engine: engineUrl.href, checks, autoResults, calls, metrics, memory, workerQueries
});
for (const check of checks) console.log(`PASS ${check}`);
console.log(JSON.stringify({ output, metrics }, null, 2));
