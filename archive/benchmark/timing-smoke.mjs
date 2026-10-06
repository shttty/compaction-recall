// Offline timing smoke on an explicitly supplied history; no provider/credentials accessed.
import fs from 'node:fs';
import { StageTiming } from '../../src/timing.mjs';
import { CompactionIndex } from '../js-runtime/inverted-index.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
const { values: args } = parseArgs({ options: { source: { type: 'string' }, query: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
if (args.help) { console.log('Usage: node benchmark/timing-smoke.mjs --source SESSION_JSONL --query TEXT --output NEW_RESULT_JSON'); process.exit(0); }
if (!args.source || !args.query) throw new Error('Explicit source and query required');
const output = args.output ?? join(fs.mkdtempSync(join(tmpdir(), 'pi-recall-timing-')), 'timing.json');
const timer = new StageTiming();
const branch = timer.run('read_parse_session', () => fs.readFileSync(args.source, 'utf8').trim().split('\n').map(JSON.parse));
const index = new CompactionIndex(timer), query = args.query;
const cold = timer.run('cold_auto_total', () => index.query(query, branch));
const warm = timer.run('warm_auto_total', () => index.query(query, branch));
if (cold !== warm) throw new Error('Cold/warm output mismatch');
timer.run('warm_manual_total', () => index.recall(query, branch));
const boundaries = branch.flatMap((entry, i) => entry.type === 'compaction' ? [i] : []);
const growing = new CompactionIndex(timer);
timer.run('first_boundary_build_total', () => growing.query(query, branch.slice(0, boundaries[0] + 1)));
timer.run('next_boundary_update_total', () => growing.query(query, branch.slice(0, boundaries[1] + 1)));
const artifact = { kind: 'single offline local timing smoke, not a benchmark distribution', units: 'milliseconds', clock: 'performance.now monotonic', execution: 'synchronous main thread; no background worker', events: timer.events };
fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(timer.events.filter(e => e.parentId === null).map(({ stage, durationMs }) => ({ stage, durationMs }))));
