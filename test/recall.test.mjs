import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import register from '../index.ts';
import legacyRegister from '../recall-extension.ts';
import { compactedEntries, entryText, MAX_EXPAND_CHARS } from '../history.ts';
import { buildLocator, RECALL_PAGE_CHARS } from '../locator.ts';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';

const stamp = '2026-09-30T00:00:00.000Z';
const msg = (id, text, role = 'user') => ({ type: 'message', id, timestamp: stamp,
  parentId: null, message: { role, content: [{ type: 'text', text }], timestamp: 0 } });
const compact = (id, firstKeptEntryId) => ({ type: 'compaction', id, timestamp: stamp,
  parentId: null, firstKeptEntryId, summary: 'not searchable summary', tokensBefore: 100 });
const text = (result) => result.content[0].text;
function harness(initial) {
  let branch = initial;
  const tools = new Map();
  // Context transform is the only hook; three recall tools share the same current-branch scope.
  register({ registerTool: (tool) => tools.set(tool.name, tool), on: (event) => assert.equal(event, "context") });
  assert.deepEqual([...tools.keys()], ['history_recall', 'history_grep', 'history_expand']);
  return { tools, setBranch: (value) => { branch = value; },
    run: (name, params) => tools.get(name).execute('test', params, undefined, undefined,
      { sessionManager: { getBranch: () => branch } }) };
}

test('package and historical entry share one factory', () => {
  assert.equal(register, legacyRegister);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.name, 'pi-recall');
  assert.deepEqual(manifest.pi.extensions, ['./index.ts']);
});

test('no compaction, latest boundary, repeated compaction and missing boundary', () => {
  const a = msg('a', 'old'), b = msg('b', 'retained tail'), c = msg('c', 'live');
  assert.deepEqual(compactedEntries([a, b]), []);
  assert.deepEqual(compactedEntries([a, b, compact('c1', 'b')]).map(e => e.id), ['a']);
  assert.deepEqual(compactedEntries([a, b, compact('c1', 'b'), c, compact('c2', 'c')]).map(e => e.id), ['a', 'b']);
  assert.deepEqual(compactedEntries([a, b, compact('c1', 'missing'), c]).map(e => e.id), ['a', 'b']);
});

test('readable text includes raw tool output but ignores hidden blocks and malformed user calls', () => {
  const e = msg('a', 'body');
  e.message.content.push({ type: 'thinking', thinking: 'secret thought' },
    { type: 'toolCall', name: 'bash', arguments: { command: 'hidden arguments' } },
    { type: 'image', data: 'hidden image' }, { type: 'text', text: 'second' });
  assert.equal(entryText(e), 'body\nsecond');
  e.message.content = 'string body';
  assert.equal(entryText(e), 'string body');
  assert.equal(entryText(compact('c', 'a')), '');
  assert.equal(entryText(msg('tool', 'raw stdout', 'toolResult')), 'raw stdout');
});

test('grep supports case-insensitive regex OR and literal invalid regex fallback', async () => {
  const h = harness([msg('a', 'SF and san francisco and [literal'), msg('b', 'live SF'), compact('c', 'b')]);
  assert.equal((await h.run('history_grep', { pattern: 'sf|San Francisco' })).details.total, 2);
  assert.equal((await h.run('history_grep', { pattern: '[literal' })).details.total, 1);
  assert.match(text(await h.run('history_grep', { pattern: 'absent' })), /^No matches/);
  assert.doesNotMatch(text(await h.run('history_grep', { pattern: 'SF' })), /\[b\]/);
});

test('grep limits per-entry and global snippets while counting all matches', async () => {
  const entries = Array.from({ length: 12 }, (_, i) => msg(String(i), 'hit hit hit hit'));
  const h = harness([...entries, msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: 'hit' });
  assert.equal(result.details.total, 48);
  assert.equal(text(result).split('\n').length, 31);
  assert.equal(text(result).split('\n').filter(l => l.startsWith('[0]')).length, 3);
  const empty = harness([msg('a', 'ab'), msg('b', 'tail'), compact('c', 'b')]);
  assert.equal((await empty.run('history_grep', { pattern: '' })).details.total, 3);
});

test('calls use the current branch each time, excluding alternate and live entries', async () => {
  const h = harness([msg('a', 'branch alpha'), msg('live', 'tail'), compact('c', 'live')]);
  assert.equal((await h.run('history_grep', { pattern: 'alpha' })).details.total, 1);
  h.setBranch([msg('b', 'branch beta'), msg('live', 'alpha'), compact('c2', 'live')]);
  assert.equal((await h.run('history_grep', { pattern: 'alpha' })).details.total, 0);
  assert.match(text(await h.run('history_expand', { id: 'a' })), /No compacted entry/);
  assert.match(text(await h.run('history_expand', { id: 'live' })), /No compacted entry/);
  h.setBranch([msg('fresh', 'beta')]);
  assert.equal((await h.run('history_grep', { pattern: 'beta' })).details.total, 0);
});

test('expand honors neighbors, zero bounds and raw tool text', async () => {
  const h = harness([msg('a', 'before'), msg('b', 'stdout', 'toolResult'), msg('d', 'after'),
    msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_expand', { id: 'b' });
  assert.deepEqual(result.details, { from: 'a', to: 'd' });
  assert.match(text(result), /toolResult \(requested\)\nstdout/);
  const alone = await h.run('history_expand', { id: 'b', before: 0, after: 0 });
  assert.deepEqual(alone.details, { from: 'b', to: 'b' });
  assert.doesNotMatch(text(alone), /before|after|tail/);
});

test('legacy expansion cap is explicit and applies to formatted neighbor output', async () => {
  const h = harness([msg('a', 'x'.repeat(MAX_EXPAND_CHARS * 2)), msg('b', 'requested body'),
    msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_expand', { id: 'b' });
  assert.ok(text(result).endsWith('\n[truncated]'));
  assert.ok(text(result).length <= MAX_EXPAND_CHARS + '\n[truncated]'.length);
  assert.doesNotMatch(text(result), /requested body/);
  assert.match(text(await h.run('history_expand', { id: 'b', before: 0, after: 0 })), /requested body/);
});

test('SDK loads standalone package and legacy entry from isolated runtime-only copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-recall-test-'));
  try {
    const source = fileURLToPath(new URL('..', import.meta.url));
    const archive = join(root, 'pi-recall');
    for (const file of ['package.json', 'index.ts', 'recall-extension.ts', 'history.ts', 'locator.ts', 'timing.ts']) {
      cpSync(join(source, file), join(archive, file));
    }
    for (const path of [archive, join(archive, 'index.ts'), join(archive, 'recall-extension.ts')]) {
      const loaded = await discoverAndLoadExtensions([path], resolve(root), join(root, 'agent'));
      assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
      assert.equal(loaded.extensions.length, 1);
      assert.deepEqual([...loaded.extensions[0].tools.keys()], ['history_recall', 'history_grep', 'history_expand']);
      assert.deepEqual([...loaded.extensions[0].handlers.keys()], ["context"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('manual recall shares automatic ranking and candidates with independent pagination', async () => {
  const entries = [msg('old', 'quasar old'), msg('best', 'quasar nebula'), msg('recent', 'quasar recent'),
    msg('tool', 'quasar nebula', 'toolResult'), msg('live', 'quasar nebula live'), compact('c', 'live')];
  const h = harness(entries);
  const result = text(await h.run('history_recall', { query: 'quasar nebula' }));
  const resultRows = result.trim().split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  const autoRows = buildLocator('quasar nebula', entries).trim().split('\n').slice(1).map(JSON.parse);
  assert.deepEqual(resultRows, autoRows);
  assert.ok(Array.from(result).length <= RECALL_PAGE_CHARS);
  assert.deepEqual(resultRows.map(row => row.id), ['best', 'recent', 'old']);
  h.setBranch([msg('alternate', 'quasar'), msg('live', 'tail'), compact('c2', 'live')]);
  const alternate = text(await h.run('history_recall', { query: 'quasar' }));
  assert.match(alternate, /alternate/);
  assert.doesNotMatch(alternate, /"id":"best"/);
});

test('manual recall permits rewritten keywords but does not invent semantic synonym matches', async () => {
  const h = harness([msg('bike', 'bicycle repair appointment'), msg('live', 'tail'), compact('c', 'live')]);
  const missing = text(await h.run('history_recall', { query: 'cycling' }));
  assert.match(missing, /does not prove absence/);
  assert.match(missing, /history_grep.*supplementary/);
  assert.match(text(await h.run('history_recall', { query: 'bicycle repair' })), /"id":"bike"/);
  for (const query of ['', 'the and', 'unmatched']) {
    assert.match(text(await h.run('history_recall', { query })), /No lexical locators/);
  }
  h.setBranch([msg('uncompacted', 'bicycle repair')]);
  assert.match(text(await h.run('history_recall', { query: 'bicycle' })), /No lexical locators/);
});

test('all search remains null-safe and excludes tool results while expansion can read them', async () => {
  const malformed = msg('broken', 'unused');
  malformed.message.content = [null, undefined, { type: 'text', text: 'quasar valid' }];
  const h = harness([malformed, msg('stdout', 'needle only in tool output', 'toolResult'), msg('live', 'tail'), compact('c', 'live')]);
  assert.match(text(await h.run('history_recall', { query: 'quasar' })), /"id":"broken"/);
  assert.match(text(await h.run('history_recall', { query: 'needle' })), /No lexical locators/);
  assert.equal((await h.run('history_grep', { pattern: 'needle' })).details.total, 0);
  assert.match(text(await h.run('history_expand', { id: 'stdout', before: 0, after: 0 })), /needle only in tool output/);
});
