import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateArm } from '../prototype/soft-match-sqlite/arms.mjs';

const { values } = parseArgs({ options: { arm: { type: 'string' }, data: { type: 'string' }, gold: { type: 'string' }, output: { type: 'string' }, samples: { type: 'string', default: '3' } } });
for (const name of ['data', 'gold', 'output']) if (!values[name]) throw new Error(`Explicit --${name} required`);
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('--samples must be a positive integer');
const output = resolve(values.output);
mkdirSync(output, { recursive: false });
const arms = values.arm ? [validateArm(values.arm)] : ['off', 'prefix-all', 'prefix-min4', 'jieba', 'porter', 'porter-js'];
const median = numbers => { const sorted = [...numbers].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const records = [], commands = [], summaries = [];
for (const arm of arms) for (const key of ['hard8/gpt4_7fce9456', 'dev8/3d86fd0a']) for (const language of ['en', 'zh']) {
  const group = [];
  for (let sample = 0; sample < samples; sample++) {
    const args = ['--expose-gc', fileURLToPath(new URL('./retrieval-sqlite-memprobe.mjs', import.meta.url)),
      '--arm', arm, '--question', key, '--language', language, '--data', values.data, '--gold', values.gold];
    commands.push([process.execPath, ...args]);
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const prefix = `${arm}-${key.replace('/', '-')}-${language}-${sample + 1}`;
    writeFileSync(join(output, prefix + '.stdout.log'), run.stdout ?? '', { flag: 'wx' });
    writeFileSync(join(output, prefix + '.stderr.log'), run.stderr ?? '', { flag: 'wx' });
    if (run.error || run.status !== 0) throw run.error ?? new Error(`Failed memory probe ${prefix}: ${run.stderr}`);
    const record = JSON.parse(run.stdout);
    record.sample = sample + 1; records.push(record); group.push(record);
  }
  const fields = ['buildMs', 'liveHeapDeltaBytes', 'rssDeltaBytes', 'jiebaLoadRssDeltaBytes', 'tokenizerLoadMs'];
  summaries.push({
    arm, key, language, samples, documents: group[0].documents,
    ...Object.fromEntries(fields.map(field => [field, median(group.map(row => row[field]))])),
    ...(group[0].inflections ? {
      inflections: Object.fromEntries(Object.keys(group[0].inflections).map(key =>
        [key, median(group.map(row => row.inflections[key]))]))
    } : {}),
    queries: group[0].queries.map((query, i) => ({
      mode: query.mode, query: query.query, total: query.total,
      coldMs: median(group.map(row => row.queries[i].coldMs)), warmMedianMs: median(group.map(row => row.queries[i].warmMedianMs))
    }))
  });
  console.log(JSON.stringify(summaries.at(-1)));
}
writeFileSync(join(output, 'summary.json'), JSON.stringify({
  node: process.version, samples, commands, summaries, records,
  note: 'Each sample is a fresh process and worker; GC twice before/after dictionary load and build. Build deltas exclude explicit dictionary initialization; worker heap only, RSS process-wide. Query warm median is 3 calls; outer summary median is fresh-process samples.'
}, null, 2) + '\n', { flag: 'wx' });
