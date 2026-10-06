import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { STOP_AFTER_SERIALIZATION, withToolEvidence } from '../benchmark/coding-recall/e2e/round2-tools.mjs';

function fixtures() {
  return ['history_recall', 'history_expand', 'history_grep'].map(name => ({
    name, description: `Native ${name}: preserve punctuation, Unicode 中文, and newlines.\nSecond line.`,
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Native query description' },
      options: { type: 'array', description: 'Native options description', items: {
        type: 'object', properties: { limit: { type: 'integer', description: 'Native nested limit' } },
      } },
    }, required: ['query'] },
    execute() { throw new Error('Offline evidence never executes a tool'); },
  }));
}

function capture(t, options, nativeTools = fixtures()) {
  const tools = [];
  const handlers = new Map();
  const api = withToolEvidence({ registerTool(tool) { tools.push(tool); },
    on(name, handler) { handlers.set(name, handler); } }, options);
  for (const tool of nativeTools) api.registerTool(tool);
  const directory = join(options.evidencePath, '..');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { tools, observe: handlers.get('before_provider_request') };
}

function serialized(tools, nested = false) {
  return tools.map(({ name, description, parameters }) => {
    const tool = JSON.parse(JSON.stringify({ name, description, parameters }));
    return nested ? { type: 'function', function: tool } : { type: 'function', ...tool, strict: false };
  });
}

function interceptExit(t) {
  const stderr = [];
  const exit = t.mock.method(process, 'exit', code => { throw new Error(`intercepted exit ${code}`); });
  t.mock.method(process.stderr, 'write', text => { stderr.push(text); return true; });
  return { stderr, exit };
}

test('serialization preflight persists only native tool metadata before exiting without network', t => {
  const directory = mkdtempSync(join(tmpdir(), 'round2-tools-probe-'));
  const evidencePath = join(directory, 'tools.json');
  const { tools, observe } = capture(t, { evidencePath, stopAfterSerialization: true });
  const payload = { tools: serialized(tools) };
  for (const key of ['messages', 'headers', 'query', 'credentials']) {
    Object.defineProperty(payload, key, { enumerable: true, get() { throw new Error(`Must not inspect ${key}`); } });
  }
  const { stderr, exit } = interceptExit(t);
  let sent = false;
  assert.throws(() => { observe({ payload }); sent = true; }, /intercepted exit 2/);
  assert.equal(sent, false);
  assert.equal(exit.mock.calls.length, 1);
  assert.deepEqual(stderr, [`${STOP_AFTER_SERIALIZATION}\n`]);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  assert.deepEqual(evidence.registered, fixtures().map(({ name, description, parameters }) =>
    ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name)));
  assert.deepEqual(evidence.serialized, evidence.registered);
  assert.equal(evidence.source, 'before_provider_request');
  assert.equal(evidence.descriptionsPreserved, true);
  assert.equal(evidence.expectedMatched, null);
});

test('normal requests match immutable preflight across provider function wrappers', t => {
  const directory = mkdtempSync(join(tmpdir(), 'round2-tools-normal-'));
  const expectedPath = join(directory, 'expected.json');
  const native = fixtures().map(({ name, description, parameters }) => ({ name, description, parameters }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const original = JSON.stringify({ registered: native, serialized: native });
  writeFileSync(expectedPath, original);
  const evidencePath = join(directory, 'tools.json');
  const { tools, observe } = capture(t, { evidencePath, expectedPath });
  observe({ payload: { tools: serialized(tools, true) } });
  const first = readFileSync(evidencePath, 'utf8');
  observe({ payload: { tools: serialized(tools) } });
  assert.equal(readFileSync(evidencePath, 'utf8'), first);
  assert.equal(JSON.parse(first).expectedMatched, true);
  assert.equal(readFileSync(expectedPath, 'utf8'), original);
  const alias = join(directory, 'expected-alias.json');
  symlinkSync(expectedPath, alias);
  assert.throws(() => withToolEvidence({}, { evidencePath: alias, expectedPath }), /must not overwrite/);
  assert.equal(readFileSync(expectedPath, 'utf8'), original);
});

test('changed descriptions, oracle fields, and preflight schema drift fail closed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'round2-tools-invalid-'));
  const evidencePath = join(directory, 'tools.json');
  const { tools, observe } = capture(t, { evidencePath });
  const { stderr, exit } = interceptExit(t);
  const mutations = [
    items => { items[0].description = 'Changed native tool text'; },
    items => { delete items[0].parameters.properties.options.items.properties.limit.description; },
    items => { items[0].parameters.properties.reference_answer = { type: 'string' }; },
    items => { items[0].extra_oracle = 'private metadata'; },
  ];
  for (const mutate of mutations) {
    const items = serialized(tools);
    mutate(items);
    assert.throws(() => observe({ payload: { tools: items } }), /intercepted exit 2/);
    assert.equal(existsSync(evidencePath), false);
  }
  const expectedPath = join(directory, 'expected.json');
  const expected = fixtures().map(({ name, description, parameters }) => ({ name, description, parameters }))
    .sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(expectedPath, JSON.stringify({ registered: expected, serialized: expected }));
  const second = capture(t, { evidencePath, expectedPath });
  const changed = serialized(second.tools);
  changed[0].parameters.properties.query.type = 'integer';
  assert.throws(() => second.observe({ payload: { tools: changed } }), /intercepted exit 2/);
  assert.equal(existsSync(evidencePath), false);
  assert.equal(exit.mock.calls.length, mutations.length + 1);
  assert.deepEqual(stderr, Array(mutations.length + 1).fill('ROUND2_TOOL_EVIDENCE_VALIDATION_FAILED\n'));
});

test('two-tool fallback schema preserves native parameters and rejects omitted or hidden extra tools', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fallback-tools-'));
  const nativeTools = fixtures().filter(tool => tool.name !== 'history_grep');
  nativeTools.find(tool => tool.name === 'history_recall').parameters = {
    type: 'object', properties: {
      concepts: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      match: { enum: ['any', 'all'] }, exclude: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer' }, offset: { type: 'integer' },
    }, required: ['concepts'],
  };
  const options = { evidencePath: join(directory, 'tools.json'), expectedTools: ['history_expand', 'history_recall'] };
  const { tools, observe } = capture(t, options, nativeTools);
  observe({ payload: { tools: serialized(tools, true) } });
  const evidence = JSON.parse(readFileSync(options.evidencePath, 'utf8'));
  assert.deepEqual(evidence.registered.map(tool => tool.name), options.expectedTools);
  assert.deepEqual(evidence.serialized, evidence.registered);
  interceptExit(t);
  assert.throws(() => observe({ payload: { tools: serialized(tools.slice(1)) } }), /intercepted exit 2/);
  assert.throws(() => observe({ payload: { tools: serialized([...tools, fixtures()[2]]) } }), /intercepted exit 2/);
  const hidden = capture(t, { ...options, evidencePath: join(directory, 'hidden.json') }, [...nativeTools, fixtures()[2]]);
  assert.throws(() => hidden.observe({ payload: { tools: serialized(nativeTools) } }), /intercepted exit 2/);
});
