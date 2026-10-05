import './isolated-agent-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import register from '../src/index.ts';
import { createRecallTrace } from '../src/recall-trace.mjs';
import { StageTiming } from '../src/timing.mjs';

const root = tmpdir();
const rows = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
function fixture() {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'trace-test-'));
  return { dir, path: join(dir, 'timing.jsonl'), close: () => rmSync(dir, { recursive: true, force: true }) };
}
const message = (id, args) => ({ role: 'assistant', content: [
  { type: 'text', text: 'before' }, { type: 'thinking', thinking: 'NEVER_RECORD' },
  { type: 'toolCall', id, name: 'history_recall', arguments: args }, { type: 'text', text: 'after' },
] });
const result = { ids: ['b', 'a'], total: 8, offset: 2, returned: 2, nextOffset: 4 };

test('disabled trace leaves timing bytes untouched; missing destination warns once', () => {
  const f = fixture();
  try {
    const timer = new StageTiming(() => 0);
    timer.mark('worker_online'); timer.flush(f.path);
    const bytes = readFileSync(f.path);
    const warnings = [];
    assert.equal(createRecallTrace({ path: f.path, warn: text => warnings.push(text) }), undefined);
    assert.deepEqual(readFileSync(f.path), bytes);
    assert.deepEqual(warnings, []);
    assert.equal(createRecallTrace({ enabled: true, path: '', warn: text => warnings.push(text) }), undefined);
    assert.deepEqual(warnings, ['compaction-recall: trace enabled without COMPACTION_RECALL_TIMING_FILE; trace disabled']);
  } finally { f.close(); }
});

test('snapshots preserve unknown arguments, original query and text blocks, without thinking', () => {
  const f = fixture();
  try {
    const trace = createRecallTrace({ enabled: true, path: f.path });
    const args = { query: 'original', unknown: { nested: [1] } };
    trace.messageEnd('s', message('call', args));
    // A later extension mutates the very same SDK tool_call input object.
    const toolCall = { toolName: 'history_recall', toolCallId: 'call', input: args };
    trace.toolCall('s', toolCall);
    toolCall.input.query = 'changed';
    const token = trace.begin('s', 'call', args);
    args.unknown.nested.push(2);
    trace.complete(token, result);
    assert.equal(existsSync(f.path), false);
    trace.flush(); trace.flush();
    assert.deepEqual(rows(f.path), [{
      type: 'history_recall_trace', sessionId: 's', callIndex: 1, toolCallId: 'call', parentToolCallId: null,
      model: { arguments: { query: 'original', unknown: { nested: [1] } }, textBlocks: ['before', 'after'] },
      execute: { params: { query: 'changed', unknown: { nested: [1] } }, query: 'changed' },
      query_identical: false, result, error: null,
    }]);
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(f.path, 'utf8'), /NEVER_RECORD/);
  } finally { f.close(); }
});

test('execute before message_end correlates at flush; errors, nested and missing model stay truthful', () => {
  const f = fixture();
  try {
    const trace = createRecallTrace({ enabled: true, path: f.path });
    trace.complete(trace.begin('s', 'late', { query: '你好' }), result);
    trace.messageEnd('s', message('late', { query: '你好' }));
    trace.fail(trace.begin('s', 'parent/1', { query: 'bad' }), new Error('FTS5: syntax error near "bad"\nraw'));
    trace.toolCall('s', { toolName: 'history_recall', toolCallId: 'nested', parentToolCallId: 'explicit' });
    trace.complete(trace.begin('s', 'nested', { query: 'n' }), result);
    trace.messageEnd('s', message('nested', { query: 'n' }));
    trace.fail(trace.begin('s', 'missing', { query: 'x' }), 'raw failure');
    trace.complete(trace.begin('other', 'late', { query: 'other' }), result);
    trace.flush();
    const events = rows(f.path);
    assert.equal(events[0].query_identical, true);
    assert.deepEqual(events.map(e => e.callIndex), [1, 2, 3, 4, 1]);
    assert.deepEqual(events.map(e => e.parentToolCallId), [null, 'parent', 'explicit', null, null]);
    assert.equal(events[1].error, 'FTS5: syntax error near "bad"\nraw');
    assert.equal(events[1].result, null);
    assert.equal(events[3].error, 'raw failure');
    for (const event of events.slice(1)) { assert.equal(event.model, null); assert.equal(event.query_identical, null); }
  } finally { f.close(); }
});

test('production registration preserves output with trace off, records execute mutations and adds no lite hooks', async t => {
  const f = fixture();
  const saved = Object.fromEntries(['PI_CODING_AGENT_DIR', 'COMPACTION_RECALL_TIMING_FILE', 'COMPACTION_RECALL_MODE'].map(key => [key, process.env[key]]));
  const hosts = [];
  mkdirSync(join(f.dir, 'extensions'));
  process.env.PI_CODING_AGENT_DIR = f.dir;
  process.env.COMPACTION_RECALL_TIMING_FILE = f.path;
  delete process.env.COMPACTION_RECALL_MODE;
  const load = config => {
    writeFileSync(join(f.dir, 'extensions/compaction-recall.json'), JSON.stringify(config));
    const tools = new Map(), hooks = new Map();
    register({ registerTool: tool => tools.set(tool.name, tool), on: (name, hook) => { const list = hooks.get(name) ?? []; list.push(hook); hooks.set(name, list); } });
    const host = { tools, hooks, emit: async (name, event) => { for (const hook of hooks.get(name) ?? []) await hook(event, ctx); } };
    hosts.push(host); return host;
  };
  const timestamp = '2026-10-03T00:00:00Z';
  const branch = [
    { type: 'message', id: 'old', timestamp, message: { role: 'user', content: 'quasar evidence' } },
    { type: 'message', id: 'live', timestamp, message: { role: 'user', content: 'retained' } },
    { type: 'compaction', id: 'c', timestamp, firstKeptEntryId: 'live' },
  ];
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => 'production' } };
  try {
    delete process.env.COMPACTION_RECALL_TIMING_FILE;
    const warnings = [];
    const stderr = t.mock.method(process.stderr, 'write', text => { warnings.push(text); return true; });
    const noFile = load({ trace: true });
    stderr.mock.restore();
    assert.deepEqual(warnings, ['compaction-recall: trace enabled without COMPACTION_RECALL_TIMING_FILE; trace disabled\n']);
    assert.equal(noFile.hooks.has('tool_call'), false);
    process.env.COMPACTION_RECALL_TIMING_FILE = f.path;
    const off = load({ trace: false }), on = load({ trace: true }), lite = load({ mode: 'lite', trace: true });
    assert.equal(lite.hooks.size, 0);
    for (const [name, tool] of off.tools) {
      assert.equal(on.tools.get(name).description, tool.description);
      assert.deepEqual(on.tools.get(name).parameters, tool.parameters);
    }
    const args = { query: 'original', limit: 1 };
    await on.emit('message_end', { message: message('actual', args) });
    on.hooks.get('tool_call').push(event => { event.input.query = 'quasar'; });
    await on.emit('tool_call', { toolName: 'history_recall', toolCallId: 'actual', input: args });
    const invoke = (host, id, params) => host.tools.get('history_recall').execute(id, params, undefined, undefined, ctx);
    assert.deepEqual(await invoke(on, 'actual', args), await invoke(off, 'off', args));
    assert.deepEqual(existsSync(f.path) ? rows(f.path).filter(row => row.type === 'history_recall_trace') : [], []);
    await on.emit('agent_end', { messages: [] });
    const [event] = rows(f.path).filter(row => row.type === 'history_recall_trace');
    assert.deepEqual(event.result, { ids: ['old'], total: 1, offset: 0, returned: 1, nextOffset: null });
    assert.equal(event.model.arguments.query, 'original');
    assert.equal(event.execute.query, 'quasar');
    assert.equal(event.query_identical, false);
    const cyclic = {}; cyclic.self = cyclic;
    assert.deepEqual(await invoke(on, 'unserializable', { query: 'quasar', cyclic }), await invoke(off, 'baseline', { query: 'quasar', cyclic }));
    await assert.rejects(invoke(on, 'unserializable-error', { query: 'quasar', cyclic, limit: 0 }), /limit must be an integer from 1 to 50/);
    await assert.rejects(invoke(on, 'error', { query: 'quasar', limit: 0 }), /limit must be/);
    await on.emit('session_shutdown', {});
    assert.equal(rows(f.path).filter(row => row.type === 'history_recall_trace')[1].error, 'limit must be an integer from 1 to 50');
  } finally {
    for (const host of hosts) await host.emit('session_shutdown', {});
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    f.close();
  }
});

test('Query JSON comparison uses serialized snapshots and null only for missing model output', () => {
  const f = fixture();
  try {
    const trace = createRecallTrace({ enabled: true, path: f.path });
    const queries = [
      [{ combineWith: 'AND', queries: ['猫', 'dog'] }, { combineWith: 'AND', queries: ['猫', 'dog'] }, true],
      [{ queries: ['猫'], prefix: true }, { prefix: true, queries: ['猫'] }, false],
      [{ queries: ['猫'] }, { queries: ['dog'] }, false],
      ['猫', { queries: ['猫'] }, false],
      [null, null, true],
    ];
    for (const [index, [modelQuery, executeQuery]] of queries.entries()) {
      const id = `json-${index}`;
      trace.messageEnd('s', message(id, { query: modelQuery }));
      trace.complete(trace.begin('s', id, { query: executeQuery }), result);
    }
    trace.flush();
    assert.deepEqual(rows(f.path).map(row => row.query_identical), queries.map(row => row[2]));
    assert.deepEqual(rows(f.path).map(row => row.execute.query), queries.map(row => row[1]));
  } finally { f.close(); }
});

test('unserializable diagnostics drop their events without replacing successful output or original errors', async () => {
  const f = fixture();
  try {
    const trace = createRecallTrace({ enabled: true, path: f.path });
    const cyclic = {}; cyclic.self = cyclic;
    const throwing = { toJSON() { throw new Error('diagnostic serialization only'); } };
    const returned = { ids: ['kept'], extra: cyclic };
    const originalError = new Error('original engine failure');
    const execute = async (id, params, work) => {
      const token = trace.begin('s', id, params);
      try { const value = await work(); trace.complete(token, value); return value; }
      catch (error) { trace.fail(token, error); throw error; }
    };
    assert.equal(await execute('cyclic-input', { query: 'q', cyclic }, () => returned), returned);
    assert.equal(await execute('throwing-input', { query: 'q', extra: throwing }, () => result), result);
    assert.equal(await execute('cyclic-output', { query: 'q' }, () => returned), returned);
    assert.equal(await execute('throwing-output', { query: 'q' }, () => throwing), throwing);
    await assert.rejects(execute('original-error', { query: 'q', cyclic }, () => { throw originalError; }), error => error === originalError);
    trace.messageEnd('s', message('bad-model', { query: 'q', extra: throwing }));
    assert.equal(await execute('bad-model', { query: 'q' }, () => result), result);
    trace.messageEnd('s', message('good', { query: 'q', extra: { preserved: [1] } }));
    assert.equal(await execute('good', { query: 'q' }, () => result), result);
    trace.flush();
    assert.deepEqual(rows(f.path).map(row => row.toolCallId), ['good']);
    assert.deepEqual(rows(f.path)[0].model.arguments.extra, { preserved: [1] });
  } finally { f.close(); }
});

test('concept consumer snapshots structured inputs with fixed field order, ordered arrays and structured errors', () => {
  const f = fixture();
  try {
    const trace = createRecallTrace({ enabled: true, path: f.path, inputFields: ['concepts', 'match', 'exclude'] });
    const args = { exclude: ['obsolete'], match: 'all', concepts: [['alpha', 'beta'], ['gamma']], limit: 1, offset: 0, unknown: 'retained' };
    trace.messageEnd('concept', message('same', args));
    const same = trace.begin('concept', 'same', { concepts: args.concepts, match: 'all', exclude: args.exclude, offset: 1, limit: 2, unknown: 'retained' });
    trace.complete(same, result);
    trace.messageEnd('concept', message('changed', args));
    const modified = { ...args, concepts: [['beta', 'alpha'], ['gamma']] };
    const changed = trace.begin('concept', 'changed', modified);
    modified.concepts[0].push('later-mutation');
    trace.complete(changed, result);
    const failed = trace.begin('concept', 'error', { concepts: [] });
    const error = Object.assign(new Error('concepts: expected 1..5 items'), { name: 'QueryError', code: 'INVALID_ARRAY' });
    trace.fail(failed, error);
    trace.fail(trace.begin('concept', 'native', { concepts: [['alpha']] }), Object.assign(new Error('SQLite failure'), { code: 'ERR_SQLITE_ERROR' }));
    trace.flush();
    const [equal, unequal, failure, native] = rows(f.path);
    assert.deepEqual(equal.execute.input, { concepts: [['alpha', 'beta'], ['gamma']], match: 'all', exclude: ['obsolete'] });
    assert.deepEqual(Object.keys(equal.execute.input), ['concepts', 'match', 'exclude']);
    assert.deepEqual(equal.model.arguments, args);
    assert.equal(equal.execute.params.unknown, 'retained');
    assert.equal(equal.execute.params.offset, 1);
    assert.equal(equal.input_identical, true);
    assert.equal(unequal.input_identical, false);
    assert.deepEqual(unequal.execute.input.concepts, [['beta', 'alpha'], ['gamma']]);
    assert.equal('query' in equal.execute, false);
    assert.equal('query_identical' in equal, false);
    assert.equal(failure.input_identical, null);
    assert.deepEqual(failure.error, { name: 'QueryError', code: 'INVALID_ARRAY', message: error.message });
    assert.deepEqual(native.error, { name: 'Error', code: 'ERR_SQLITE_ERROR', message: 'SQLite failure' });
    assert.doesNotMatch(readFileSync(f.path, 'utf8'), /NEVER_RECORD/);
  } finally { f.close(); }
});

test('structured trace disabled leaves the destination untouched', () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'existing bytes\n');
    assert.equal(createRecallTrace({ enabled: false, path: f.path, inputFields: ['concepts', 'match', 'exclude'] }), undefined);
    assert.equal(readFileSync(f.path, 'utf8'), 'existing bytes\n');
  } finally { f.close(); }
});
