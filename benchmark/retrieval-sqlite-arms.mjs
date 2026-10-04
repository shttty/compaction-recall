// S6 mechanical retrieval only. No provider/config/profile/model entrypoints.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { runGroup1 } from './retrieval-group1.mjs';
import { validateArm } from '../prototype/soft-match-sqlite/arms.mjs';
import { parseAutoGate } from '../prototype/soft-match-sqlite/index.mjs';
import { takeAutomaticEvidence } from './retrieval-sqlite-engine.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['arm', 'data', 'gold', 'output', 'baseline'].map(name => [name, { type: 'string' }])) });
for (const name of ['data', 'gold', 'output', 'baseline']) if (!values[name]) throw new Error(`Explicit --${name} required`);
const arm = validateArm(values.arm ?? 'off');
process.env.COMPACTION_RECALL_SQLITE_ARM = arm;
const autoGate = parseAutoGate(process.env.COMPACTION_RECALL_AUTO_GATE);
const baselineBytes = readFileSync(values.baseline);
const baseline = JSON.parse(baselineBytes);
const report = await runGroup1({
  enginePath: new URL('./retrieval-sqlite-engine.mjs', import.meta.url).pathname,
  dataRoot: values.data, goldPath: values.gold, prototype: 'sqlite'
});
assert.equal(report.rows.length, 32);
assert.ok(report.summary.every(row => row.questions === 16 && row.goldTotal === 51));
report.arm = arm;
report.autoGate = autoGate;
report.baseline = { path: resolve(values.baseline), sha256: createHash('sha256').update(baselineBytes).digest('hex'), summary: baseline.summary };
report.comparison = report.rows.map(row => {
  const old = baseline.rows.find(item => item.key === row.key && item.language === row.language);
  assert.ok(old, `${row.key} ${row.language}`);
  if (arm === 'off') assert.deepEqual(row.results, old.results, `S5b exact id/score parity: ${row.key} ${row.language}`);
  return {
    key: row.key, language: row.language, mrrBefore: old.metrics.mrr, mrrAfter: row.metrics.mrr,
    mrrDelta: row.metrics.mrr - old.metrics.mrr, top5Before: old.metrics.top5Hit, top5After: row.metrics.top5Hit,
    topIdsBefore: old.results.slice(0, 5).map(item => item.id), topIdsAfter: row.results.slice(0, 5).map(item => item.id)
  };
});
report.offIdenticalToS5b = arm === 'off' ? true : undefined;
if (arm === 'inflect-wink') {
  const evidence = takeAutomaticEvidence();
  assert.equal(evidence.length, report.rows.length);
  report.automaticExpansions = report.rows.map((row, i) => ({ key: row.key, language: row.language, ...evidence[i] }));
}
mkdirSync(dirname(resolve(values.output)), { recursive: true });
writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ arm, autoGate, summary: report.summary, offIdenticalToS5b: report.offIdenticalToS5b }, null, 2));
