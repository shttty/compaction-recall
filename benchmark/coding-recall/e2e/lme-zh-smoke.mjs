// One repository-owned production SDK/worker smoke; no provider requests.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [candidate, output] = process.argv.slice(2);
if (candidate === '--help' && !output) {
  console.log('Usage: lme-zh-smoke.mjs FROZEN_CANDIDATE NEW_OUTPUT');
  process.exit(0);
}
if (!candidate || !output || process.argv.length !== 4) throw new Error('Usage: lme-zh-smoke.mjs FROZEN_CANDIDATE NEW_OUTPUT');
const root = resolve(candidate);
mkdirSync(output, { recursive: false }); // Refuse to overwrite earlier proof.
const profile = mkdtempSync(join(tmpdir(), 'zh-key-path-'));
for (const key of Object.keys(process.env)) if (!['PATH', 'LANG', 'LC_ALL', 'TZ'].includes(key)) delete process.env[key];
Object.assign(process.env, { HOME: profile, USERPROFILE: profile, PI_CODING_AGENT_DIR: profile,
  XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile, XDG_DATA_HOME: profile, PI_OFFLINE: '1',
  COMPACTION_RECALL_TIMING_FILE: join(profile, 'trace.jsonl'), COMPACTION_RECALL_MODE: 'full',
  COMPACTION_RECALL_AUTO_GATE: '280', COMPACTION_RECALL_SNIPPET_BUDGET: '240',
  COMPACTION_RECALL_QUERY_TIMEOUT_MS: '5000' });
let providerRequests = 0;
globalThis.fetch = async () => { providerRequests++; throw new Error('Offline smoke forbids provider requests'); };
mkdirSync(join(profile, 'extensions'));
writeFileSync(join(profile, 'extensions/compaction-recall.json'), JSON.stringify({ mode: 'full', trace: true,
  autoGate: 280, snippetBudget: 240, recallTimeoutMs: 5000 }));
const timestamp = '2026-10-06T00:00:00Z';
const message = (id, content) => ({ type: 'message', id, timestamp, message: { role: 'user', content } });
const branch = [message('seven', 'topic at 7:30 paid $50'), message('eight', 'topic at 8:30 paid $80'),
  message('live', 'retained'), { type: 'compaction', id: 'compact', timestamp, firstKeptEntryId: 'live', summary: '', tokensBefore: 100 }];
const ctx = { sessionManager: { getSessionId: () => 'zh-key-path', getBranch: () => branch } };
let extension;
const dispatch = async (name, event) => {
  for (const handler of extension?.handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
};
const events = () => readFileSync(join(profile, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const searches = () => events().filter(row => ['native_count', 'native_query'].includes(row.stage)).length;
try {
  const sdk = join(root, 'node_modules/@earendil-works/pi-coding-agent');
  const manifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'));
  const { discoverAndLoadExtensions } = await import(pathToFileURL(join(sdk, manifest.exports['.'].import)));
  const loaded = await discoverAndLoadExtensions([join(root, 'src/index.ts')], root, profile);
  assert.deepEqual(loaded.errors, []);
  extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()].sort(), ['history_expand', 'history_grep', 'history_recall']);
  const call = (name, args) => extension.tools.get(name).definition.execute(name, args, undefined, undefined, ctx);
  assert.equal((await call('history_recall', { concepts: [['topic']] })).details.total, 2);
  const before = searches();
  const partial = await call('history_recall', { concepts: [['7:30']] });
  const analyzed = await call('history_recall', { concepts: [['30']] });
  const visibleRows = result => result.content[0].text.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  assert.equal(partial.details.total, 2);
  assert.deepEqual(visibleRows(partial), visibleRows(analyzed));
  assert.notEqual(partial.content[0].text, analyzed.content[0].text, 'loss diagnostic remains visible without changing hits');
  assert.ok(searches() > before, 'partial token loss retains the accepted native search');
  await assert.rejects(call('history_recall', { concepts: [['*']] }),
    error => error.name === 'QueryError' && error.code === 'EMPTY_ANALYSIS');
  assert.equal((await call('history_recall', { concepts: [['topic']] })).details.total, 2);
  const grep = await call('history_grep', { pattern: '7:3[0]' });
  assert.equal(grep.details.total, 1);
  assert.match(grep.content[0].text, /\[seven\].*7:30/);
  const expanded = await call('history_expand', { id: 'seven', before: 0, after: 0 });
  assert.match(expanded.content[0].text, /topic at 7:30 paid \$50/);
  const { LOCATOR_TYPE } = await import(pathToFileURL(join(root, 'src/locator.mjs')));
  let messages = [{ role: 'user', content: [{ type: 'text', text: 'topic' }], timestamp: 0 }];
  for (const handler of extension.handlers.get('context') ?? []) {
    const result = await handler({ type: 'context', messages }, ctx);
    if (result?.messages) messages = result.messages;
  }
  const hints = messages.filter(row => row.customType === LOCATOR_TYPE);
  assert.ok(hints.some(row => row.content.includes('seven')), 'automatic hints still reach compacted evidence');
  await dispatch('session_shutdown', { reason: 'quit' });
  extension = undefined;
  const trace = events();
  assert.ok(trace.some(row => row.stage === 'worker_maintenance' && row.execution === 'worker_thread'));
  assert.equal(trace.some(row => row.stage?.startsWith('fallback_')), false);
  assert.equal(providerRequests, 0);
  const result = { candidate: root, sdkLoaded: true, partialTokenLossWarned: true, workerRecovery: true,
    grepExpandVerified: true, automaticHintsVerified: true, providerRequests };
  writeFileSync(join(output, 'sdk-worker-smoke.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(output, 'sdk-worker-trace.jsonl'), readFileSync(join(profile, 'trace.jsonl')), { flag: 'wx' });
  console.log(JSON.stringify(result));
} finally {
  try { await dispatch('session_shutdown', { reason: 'quit' }); }
  finally { rmSync(profile, { recursive: true, force: true }); }
}
