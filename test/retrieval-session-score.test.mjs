import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../benchmark/retrieval-session.mjs', import.meta.url));

test('actual score CLI preserves structured mismatches through row metrics and summary, with legacy query semantics', t => {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-score-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cases = [];
  const fixtures = [
    { key: 'structured', input_identical: false, query_identical: true,
      model: { arguments: { concepts: [['C++']], match: 'all', exclude: ['low'] } },
      execute: { params: { concepts: [['C++']], match: 'all', exclude: [] } } },
    { key: 'legacy-mismatch', query_identical: false },
    { key: 'legacy-identical', query_identical: true },
    { key: 'unknown' },
    { key: 'both-mismatch', input_identical: false, query_identical: false }
  ];
  for (const fixture of fixtures) {
    const metadata = join(root, fixture.key + '.json');
    const trace = join(root, fixture.key + '.jsonl');
    writeFileSync(metadata, JSON.stringify({ key: fixture.key, language: 'zh', goldIds: ['gold'],
      autoResults: [], preparation: { wallMs: 1 } }));
    writeFileSync(trace, JSON.stringify({ type: 'history_recall_trace', callIndex: 1, toolCallId: 'one',
      ...fixture, result: { ids: ['gold'], fallback: { surfaces: ['C++'], scannedDocuments: 7, ranking: 'rarity' } } }) + '\n'
      + JSON.stringify({ type: 'timing', stage: 'fallback_scan' }) + '\n');
    cases.push({ metadata, trace, recallCalls: 1 });
  }
  const report = join(root, 'report.json');
  const request = join(root, 'request.json');
  writeFileSync(request, JSON.stringify({ prototype: 'synthetic-offline', cases, report }));
  const result = spawnSync(process.execPath, [cli, 'score', request], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(readFileSync(report, 'utf8'));
  assert.deepEqual(output.rows.map(row => row.metrics.queryMismatchCount), [1, 1, 0, 0, 1]);
  assert.deepEqual(output.rows.map(row => row.metrics.callCount), [1, 1, 1, 1, 1]);
  assert.equal(output.summary[0].queryMismatches, 3);
  assert.equal(output.summary[0].calls, 5);
  assert.equal(JSON.parse(result.stdout).summary[0].queryMismatches, 3);
});
