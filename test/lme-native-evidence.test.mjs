import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveNativeToolEvidence } from '../benchmark/coding-recall/e2e/round2-tools.mjs';
import { persistContextPayload } from '../benchmark/coding-recall/e2e/round3-context.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'native-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('native tools cannot drift from zero or overwrite expected preflight', t => {
  const directory = fixture(t), evidencePath = join(directory, 'tools.json');
  saveNativeToolEvidence({ messages: [] }, { evidencePath });
  const first = JSON.parse(readFileSync(evidencePath, 'utf8'));
  assert.deepEqual(first.registered, []); assert.deepEqual(first.serialized, []);
  const expectedPath = join(directory, 'expected.json');
  writeFileSync(expectedPath, JSON.stringify(first));
  saveNativeToolEvidence({ tools: [] }, { evidencePath, expectedPath });
  assert.equal(JSON.parse(readFileSync(evidencePath, 'utf8')).expectedMatched, true);
  assert.throws(() => saveNativeToolEvidence({ tools: [{ name: 'bash' }] }, { evidencePath }), /exactly/);
  assert.throws(() => saveNativeToolEvidence({ tools: null }, { evidencePath }), /invalid/);
  assert.throws(() => saveNativeToolEvidence({}, { evidencePath: expectedPath, expectedPath }), /must not overwrite/);
  writeFileSync(expectedPath, JSON.stringify({ registered: [{ name: 'bash' }], serialized: [] }));
  assert.throws(() => saveNativeToolEvidence({}, { evidencePath, expectedPath }), /differ from preflight/);
});

test('native context rejects automatic locators and retains unmodified private request bodies across requests', t => {
  const directory = fixture(t);
  const payload = { model: 'fixture-model', reasoning_effort: 'high', max_output_tokens: 99,
    instructions: 'Keep exact instructions.', input: [{ role: 'user', content: 'Unchanged question.' }] };
  persistContextPayload(payload, { directory, toolsOnly: true, source: 'onPayload' });
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'payload-0001.json'), 'utf8')), payload);
  assert.equal(statSync(join(directory, 'payload-0001.json')).mode & 0o777, 0o600);
  const next = { ...payload, input: [...payload.input, { role: 'assistant', content: 'Unchanged answer.' }] };
  persistContextPayload(next, { directory, toolsOnly: true, source: 'onPayload' });
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'payload-0002.json'), 'utf8')), next);
  const leaked = { ...payload, input: [{ role: 'user', content: 'Compacted-history locators (lexical hints only).\n[id]' }] };
  assert.throws(() => persistContextPayload(leaked, { directory, toolsOnly: true }), /locator leak/);
  const toolResult = { ...payload, input: [{ role: 'tool', content: leaked.input[0].content }] };
  persistContextPayload(toolResult, { directory, toolsOnly: true });
  assert.equal(JSON.parse(readFileSync(join(directory, 'context-0003.json'), 'utf8')).serializedLocatorCount, 0);
});
