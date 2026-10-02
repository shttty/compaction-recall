import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [wrapperPath, ...candidates] = process.argv.slice(2);
assert.ok(wrapperPath, 'Pass the immutable evaluation wrapper path');
assert.equal(candidates.length, 2, 'Pass both full-commit archive directories');

async function load(file, env = {}) {
  Object.assign(process.env, env);
  const loaded = await loadExtensions([file], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  return loaded.extensions[0];
}
async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
const wrapperStat = await stat(wrapperPath);
assert.equal(wrapperStat.mode & 0o222, 0, 'Evaluation wrapper must be immutable');
const wrapperDigest = await digest(wrapperPath);

const results = [];
for (const candidate of candidates) {
  const manifest = JSON.parse(await readFile(path.join(candidate, 'manifest.json'), 'utf8'));
  assert.ok(['index.ts', './index.ts', 'src/index.ts', './src/index.ts'].includes(manifest.entry), 'Archive manifest must identify its public entry');
  const entry = path.join(candidate, manifest.entry);
  const recallEntry = path.join(path.dirname(entry), 'recall-extension.ts');
  const before = {};
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = path.join(candidate, relative);
    const mode = (await stat(file)).mode;
    assert.equal(mode & 0o222, 0, `Archive file must be immutable: ${relative}`);
    before[relative] = await digest(file);
    assert.equal(before[relative], expected, `Archive hash mismatch: ${relative}`);
  }
  const grep = await load(wrapperPath, {
    PI_RECALL_EXTENSION: recallEntry,
  });
  const production = await load(entry);
  assert.deepEqual([...grep.tools.keys()].sort(), ['history_expand', 'history_grep']);
  assert.equal(grep.handlers.has('context'), false);
  assert.deepEqual([...production.tools.keys()].sort(), ['history_expand', 'history_grep', 'history_recall']);
  assert.equal(production.handlers.has('context'), true);
  for (const [relative, expected] of Object.entries(before)) {
    assert.equal(await digest(path.join(candidate, relative)), expected, `Archive bytes changed during SDK load: ${relative}`);
  }
  assert.equal(await digest(wrapperPath), wrapperDigest, 'Wrapper bytes changed during SDK load');
  results.push({
    commit: manifest.resolved_commit, grepTools: [...grep.tools.keys()].sort(), grepContextHook: false,
    productionTools: [...production.tools.keys()].sort(), productionContextHook: true,
    closureSha256: manifest.closure_sha256, archiveSha256: manifest.archive_sha256
  });
}
console.log(JSON.stringify(results));
