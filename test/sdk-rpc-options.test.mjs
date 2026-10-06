import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
test('optional trace paths are answer-only and reject output escapes including symlinks', t => {
  const home = mkdtempSync(path.join(tmpdir(), 'recall-options-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const output = path.join(home, 'output'), profile = path.join(home, 'profile');
  mkdirSync(output); mkdirSync(profile);
  writeFileSync(path.join(home, 'data.json'), '[]');
  const phase = { provider: 'unused', model: 'unused', effort: 'off', profile };
  const config = {
    sdk_path: path.join(root, 'node_modules/@earendil-works/pi-coding-agent'), output_dir: output,
    system_prompt: '', protocol: { reserve_tokens: 100, overhead_tokens: 0 }, answer: phase, judge: phase
  };
  // Provider resolution is deliberately absent: invalid paths must fail before SDK initialization.
  writeFileSync(path.join(profile, 'models.json'), JSON.stringify({ providers: { unused: { models: [{ id: 'unused' }] } } }));
  writeFileSync(path.join(profile, 'auth.json'), '{}');
  const filename = path.join(home, 'config.json'); writeFileSync(filename, JSON.stringify(config));
  const recall = path.join(home, 'recall.json'); writeFileSync(recall, '{"trace":true}');
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'benchmark/sdk-rpc.mjs'), '--config', filename, ...args], { encoding: 'utf8' });
  for (const phase of ['judge']) {
    const result = run('--phase', phase, '--recall-config', recall);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /answer-only/);
  }
  for (const filename of [path.join(home, 'outside.jsonl'), path.join(output, 'escape.jsonl')]) {
    if (filename.includes('escape')) symlinkSync(path.join(home, 'data.json'), filename);
    const result = run('--phase', 'answer', '--arm', 'native', '--session', path.join(output, 'session.jsonl'), '--timing-file', filename);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(path.join(home, 'data.json'), 'utf8'), '[]');
    if (!filename.includes('escape')) assert.equal(existsSync(filename), false);
  }
});
