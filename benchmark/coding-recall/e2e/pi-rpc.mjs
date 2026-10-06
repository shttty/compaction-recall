// Reuse the official SDK boundary; the retired live protocol is explicitly paused.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { main } from '../../sdk-rpc.mjs';
const phase = process.argv[process.argv.indexOf('--phase') + 1];
const configPath = process.argv[process.argv.indexOf('--config') + 1];
if (configPath && ['compression', 'answer'].includes(phase)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const output = resolve(dirname(configPath), config.output_dir);
  if (existsSync(join(output, 'live-paused.json'))) {
    process.stdout.write(JSON.stringify({ id: 'ready', type: 'response', command: 'get_state', success: false, error: 'RSM-E2E-STEER-6: live replay is paused' }) + '\n');
    process.exit(0);
  }
}
const appendAt = process.argv.indexOf('--append-system-prompt');
let appendSystemPrompt = '';
if (appendAt >= 0) {
  const filename = process.argv[appendAt + 1];
  if (!filename) throw new Error('--append-system-prompt requires a file');
  appendSystemPrompt = readFileSync(filename, 'utf8');
  process.argv.splice(appendAt, 2);
}
await main({ ...(phase === 'compression' ? { keepRecentTokens: 0 } : {}), appendSystemPrompt });
