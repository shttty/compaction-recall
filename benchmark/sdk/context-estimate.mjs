// Conservative SDK estimate, independent of synthetic historical usage fields.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node benchmark/sdk/context-estimate.mjs --sdk-path PACKAGE --session FILE');
  process.exit(0);
}
if (args.length !== 4 || args[0] !== '--sdk-path' || args[2] !== '--session') {
  throw new Error('Explicit --sdk-path PACKAGE and --session FILE required');
}
const sdk = path.resolve(args[1]);
const { buildSessionContext } = await import(pathToFileURL(path.join(sdk, 'dist/core/session-manager.js')).href);
const { estimateTokens } = await import(pathToFileURL(path.join(sdk, 'dist/core/compaction/compaction.js')).href);
const start = performance.now(), raw = fs.readFileSync(args[3], 'utf8'), read = performance.now();
const entries = raw.trim().split('\n').map(JSON.parse), parsed = performance.now();
const context = buildSessionContext(entries), built = performance.now();
const estimatedTokens = context.messages.reduce((n, m) => n + estimateTokens(m), 0), end = performance.now();
console.log(JSON.stringify({ estimatedTokens, messages: context.messages.length, timing: { readMs: read - start, parseMs: parsed - read, buildContextMs: built - parsed, estimateMs: end - built } }));
