import './isolated-agent-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { loadRecallConfig } from '../src/recall-config.mjs';

const fixture = work => {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-recall-config-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    work(dir, content => {
      mkdirSync(join(dir, 'extensions'), { recursive: true });
      writeFileSync(join(dir, 'extensions', 'compaction-recall.json'), content);
    });
  }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

test('mode and independent preindex fields use environment over file over defaults', () => fixture((dir, write) => {
  assert.deepEqual(loadRecallConfig({ env: {} }), { mode: 'full', trace: false, userCycles: 10, toolRounds: 10, recallTimeoutMs: 5000, autoGate: 210 });
  write(JSON.stringify({ mode: 'lite', preindex: { userCycles: 5, toolRounds: 20 } }));
  const warnings = [];
  assert.deepEqual(loadRecallConfig({ env: {}, warn: message => warnings.push(message) }), { mode: 'lite', trace: false, userCycles: 5, toolRounds: 20, recallTimeoutMs: 5000, autoGate: 210 });
  assert.deepEqual(warnings, []);
  assert.deepEqual(loadRecallConfig({ env: { COMPACTION_RECALL_MODE: 'full', COMPACTION_RECALL_PREINDEX_TURNS: '30' } }), { mode: 'full', trace: false, userCycles: 30, toolRounds: 20, recallTimeoutMs: 5000, autoGate: 210 });
  write(JSON.stringify({ mode: 'full' }));
  assert.equal(loadRecallConfig({ env: { COMPACTION_RECALL_MODE: 'lite' } }).mode, 'lite');
}));

test('malformed, oversized, unknown and invalid preindex values warn without exposing contents', () => fixture((dir, write) => {
  let warnings = [];
  const load = env => loadRecallConfig({ env, warn: message => warnings.push(message) });
  write('{SENSITIVE_CONTENT');
  assert.deepEqual(load({}), { mode: 'full', trace: false, userCycles: 10, toolRounds: 10, recallTimeoutMs: 5000, autoGate: 210 });
  assert.equal(warnings.length, 1);
  assert.ok(!warnings.join().includes('SENSITIVE_CONTENT'));
  write(JSON.stringify({ preindex: { userCycles: '5', toolRounds: 101 }, unknown: 'SENSITIVE_CONTENT' }));
  warnings = [];
  assert.deepEqual(load({ COMPACTION_RECALL_PREINDEX_TURNS: '5e1', COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS: '0' }), { mode: 'full', trace: false, userCycles: 10, toolRounds: 10, recallTimeoutMs: 5000, autoGate: 210 });
  assert.equal(warnings.length, 5);
  write(JSON.stringify({ mode: 'lite', preindex: { userCycles: 6, toolRounds: 7 } }));
  assert.deepEqual(load({ COMPACTION_RECALL_PREINDEX_TURNS: '' }), { mode: 'lite', trace: false, userCycles: 6, toolRounds: 7, recallTimeoutMs: 5000, autoGate: 210 });
  write(' '.repeat(65537));
  assert.deepEqual(load({}), { mode: 'full', trace: false, userCycles: 10, toolRounds: 10, recallTimeoutMs: 5000, autoGate: 210 });
  assert.equal(load({ COMPACTION_RECALL_MODE: 'lite' }).mode, 'lite');
}));

test('invalid file modes warn and use full without affecting preindex fields', () => fixture((dir, write) => {
  for (const mode of [null, false, 1, {}, [], '', 'LITE', ' lite', 'fast', 'SECRET_MODE']) {
    const warnings = [];
    write(JSON.stringify({ mode, preindex: { userCycles: 4 } }));
    assert.deepEqual(loadRecallConfig({ env: {}, warn: message => warnings.push(message) }), { mode: 'full', trace: false, userCycles: 4, toolRounds: 10, recallTimeoutMs: 5000, autoGate: 210 });
    assert.deepEqual(warnings, ['compaction-recall: invalid mode; expected lite or full, using full']);
  }
}));

test('invalid environment mode overrides valid lite file with full, not the file value', () => fixture((dir, write) => {
  write(JSON.stringify({ mode: 'lite', preindex: { toolRounds: 7 } }));
  for (const mode of ['', 'LITE', 'lite ', 'fast', 'SECRET_ENV']) {
    const warnings = [];
    assert.deepEqual(loadRecallConfig({ env: { COMPACTION_RECALL_MODE: mode }, warn: message => warnings.push(message) }), { mode: 'full', trace: false, userCycles: 10, toolRounds: 7, recallTimeoutMs: 5000, autoGate: 210 });
    assert.deepEqual(warnings, ['compaction-recall: invalid COMPACTION_RECALL_MODE; expected lite or full, using full']);
  }
  write(JSON.stringify({ mode: 'SECRET_FILE' }));
  const warnings = [];
  assert.equal(loadRecallConfig({ env: { COMPACTION_RECALL_MODE: 'lite' }, warn: message => warnings.push(message) }).mode, 'lite');
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings.join(), /SECRET_FILE/);
}));

test('mode shares the existing file limit and unknown-field validation', () => fixture((dir, write) => {
  const warnings = [];
  const load = () => loadRecallConfig({ env: {}, warn: message => warnings.push(message) });
  const config = JSON.stringify({ mode: 'lite' });
  write(config + ' '.repeat(65536 - config.length));
  assert.equal(load().mode, 'lite');
  assert.deepEqual(warnings, []);
  write(config + ' '.repeat(65537 - config.length));
  assert.equal(load().mode, 'full');
  assert.equal(warnings.length, 1);
  warnings.length = 0;
  write(JSON.stringify({ mode: 'lite', unknown: 'SECRET', preindex: { unexpected: 'SECRET' } }));
  assert.equal(load().mode, 'lite');
  assert.deepEqual(warnings, ['compaction-recall: unknown config fields ignored']);
}));

test('missing agent config is silent and all environment controls remain available', () => fixture(() => {
  const warnings = [];
  const warn = message => warnings.push(message);
  assert.deepEqual(loadRecallConfig({ env: {}, warn }), { mode: 'full', trace: false, userCycles: 10, toolRounds: 10, recallTimeoutMs: 5000, autoGate: 210 });
  assert.deepEqual(loadRecallConfig({
    env: {
      COMPACTION_RECALL_MODE: 'lite', COMPACTION_RECALL_PREINDEX_TURNS: '3', COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS: '8',
    }, warn
  }), { mode: 'lite', trace: false, userCycles: 3, toolRounds: 8, recallTimeoutMs: 5000, autoGate: 210 });
  assert.deepEqual(warnings, []);
}));

test('SDK agent path uses process environment, never project config or parser overrides', () => fixture((dir, write) => {
  const cwd = process.cwd();
  const project = join(dir, 'project');
  mkdirSync(join(project, '.pi'), { recursive: true });
  writeFileSync(join(project, '.pi', 'compaction-recall.json'), JSON.stringify({ mode: 'lite', preindex: { userCycles: 1 } }));
  writeFileSync(join(dir, 'compaction-recall.json'), JSON.stringify({ mode: 'lite', preindex: { userCycles: 1 } }));
  const warnings = [];
  const warn = message => warnings.push(message);
  try {
    process.chdir(project);
    assert.equal(getAgentDir(), dir);
    assert.deepEqual(loadRecallConfig({ env: {}, warn }), { mode: 'full', trace: false, userCycles: 10, toolRounds: 10, recallTimeoutMs: 5000, autoGate: 210 });
    write(JSON.stringify({ mode: 'full', preindex: { userCycles: 4, toolRounds: 6 } }));
    assert.deepEqual(loadRecallConfig({ env: { PI_CODING_AGENT_DIR: project }, warn }), { mode: 'full', trace: false, userCycles: 4, toolRounds: 6, recallTimeoutMs: 5000, autoGate: 210 });
    assert.deepEqual(warnings, []);
  } finally { process.chdir(cwd); }
}));

test('trace is file-only boolean and unknown fields still warn', () => fixture((dir, write) => {
  assert.equal(loadRecallConfig({ env: { COMPACTION_RECALL_TRACE: 'true' } }).trace, false);
  for (const trace of [false, true]) {
    const warnings = [];
    write(JSON.stringify({ trace, extra: 'SECRET', preindex: { extra: true } }));
    assert.equal(loadRecallConfig({ env: {}, warn: message => warnings.push(message) }).trace, trace);
    assert.deepEqual(warnings, ['compaction-recall: unknown config fields ignored']);
  }
  for (const trace of [null, 'true', 1, {}, []]) {
    const warnings = [];
    write(JSON.stringify({ trace }));
    assert.equal(loadRecallConfig({ env: {}, warn: message => warnings.push(message) }).trace, false);
    assert.deepEqual(warnings, ['compaction-recall: invalid trace; expected boolean, using false']);
  }
}));

test('SQLite limits use environment over file and invalid values silently use defaults', () => fixture((dir, write) => {
  const warnings = [];
  const load = env => loadRecallConfig({ env, warn: message => warnings.push(message) });
  write(JSON.stringify({ recallTimeoutMs: 9000, autoGate: 280 }));
  const config = load({});
  assert.equal(config.recallTimeoutMs, 9000);
  assert.equal(config.autoGate, 280);
  const override = load({ COMPACTION_RECALL_QUERY_TIMEOUT_MS: '12000', COMPACTION_RECALL_AUTO_GATE: '300' });
  assert.equal(override.recallTimeoutMs, 12000);
  assert.equal(override.autoGate, 300);
  for (const value of ['', ' ', ' 1 ', '0', '-1', '1.5', '5e3', '0x10', 'Infinity', 'NaN', '9007199254740992']) {
    const invalid = load({ COMPACTION_RECALL_QUERY_TIMEOUT_MS: value, COMPACTION_RECALL_AUTO_GATE: value });
    assert.equal(invalid.recallTimeoutMs, 5000);
    assert.equal(invalid.autoGate, 210);
  }
  for (const value of [null, false, '9000', 0, -1, 1.5, [], {}, 9007199254740992]) {
    write(JSON.stringify({ recallTimeoutMs: value, autoGate: value }));
    const invalid = load({});
    assert.equal(invalid.recallTimeoutMs, 5000);
    assert.equal(invalid.autoGate, 210);
  }
  assert.deepEqual(warnings, []);
}));

test('explicit snippet budgets use weighted units; absent and invalid selections keep the legacy default', () => fixture((dir, write) => {
  const warnings = [];
  const load = env => loadRecallConfig({ env, warn: message => warnings.push(message) });
  assert.equal(load({}).snippetBudget, undefined);
  write(JSON.stringify({ snippetBudget: 240 }));
  assert.equal(load({}).snippetBudget, 240);
  assert.equal(load({ COMPACTION_RECALL_SNIPPET_BUDGET: '320' }).snippetBudget, 320);
  for (const value of ['', '0', '-1', '1.5', '2.4e2', ' 240 ', '9007199254740992']) {
    assert.equal(load({ COMPACTION_RECALL_SNIPPET_BUDGET: value }).snippetBudget, undefined);
  }
  for (const value of [null, false, '240', 0, -1, 1.5, [], {}, 9007199254740992]) {
    write(JSON.stringify({ snippetBudget: value }));
    assert.equal(load({}).snippetBudget, undefined);
  }
  assert.deepEqual(warnings, []);
}));
