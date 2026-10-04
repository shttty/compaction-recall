#!/usr/bin/env node
import { mkdirSync, copyFileSync, writeFileSync, chmodSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true });
if (!values.output) throw new Error('--output is required (new package directory)');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(values.output);
const runRoot = '/home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/sqlite/';
if (!output.startsWith(runRoot)) throw new Error('Package output must be inside authorized SQLite run directory');
mkdirSync(output, { recursive: false, mode: 0o700 });
const files = [
  'benchmark/retrieval-sqlite-adapter.ts', 'benchmark/retrieval-sqlite-engine.mjs',
  'benchmark/retrieval-sqlite-worker.mjs', 'benchmark/retrieval-sqlite-page.mjs',
  'benchmark/fts5-snippet.mjs',
  'prototype/soft-match-sqlite/index.mjs', 'prototype/soft-match-sqlite/query.mjs',
  'prototype/soft-match-sqlite/lexical.mjs', 'prototype/soft-match-sqlite/arms.mjs',
  'prototype/soft-match-sqlite/porter.mjs',
  'prototype/soft-match-sqlite/porter-js.mjs',
  'prototype/soft-match-sqlite/inflect.mjs',
  'prototype/soft-match-sqlite/lemma.mjs',
  ...readdirSync(join(root, 'src')).filter(name => /\.(ts|mjs)$/.test(name)).map(name => `src/${name}`),
  'LICENSE', 'THIRD_PARTY_NOTICES.md',
];
for (const name of files) {
  const target = join(output, name);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(join(root, name), target);
  chmodSync(target, 0o444);
}
writeFileSync(join(output, 'package.json'), JSON.stringify({
  name: 'retrieval-soft-match-sqlite', private: true, type: 'module',
  pi: { extensions: ['./benchmark/retrieval-sqlite-adapter.ts'] },
  peerDependencies: { '@earendil-works/pi-coding-agent': '1.0.0', typebox: '1.3.27' },
  dependencies: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies,
}, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
console.log(JSON.stringify({ package: output, entry: './benchmark/retrieval-sqlite-adapter.ts', files: files.length + 1 }));
