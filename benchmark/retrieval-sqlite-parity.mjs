import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { loadEvaluationCases } from './retrieval-eval-core.mjs';
import { createEngine } from './retrieval-sqlite-engine.mjs';
import { SQLiteBackgroundIndex } from './sqlite-background-index.mjs';

const authorizedRoot = '/home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/sqlite';
const ranks = rows => rows.map(({ id, score }) => ({ id, score }));

export async function runParity({ output, dataRoot = '/home/rinne/workspace/pi-context-recall-dev/benchmark/data',
  goldPath = '/home/rinne/.hermes/task-runs/recall-soft-match-20261003/zh-retrieval/gold.json' }) {
  if (!output) throw new Error('--output is required');
  const destination = resolve(output);
  const subpath = relative(authorizedRoot, destination);
  if (!subpath || subpath === '..' || subpath.startsWith('../') || isAbsolute(subpath)) {
    throw new Error('Parity output must be a new directory beneath ' + authorizedRoot);
  }
  const cases = loadEvaluationCases({ dataRoot, goldPath }).filter(item => item.key === 'dev8/3d86fd0a');
  assert.deepEqual(cases.map(item => item.language).sort(), ['en', 'zh']);
  const report = {
    question: 'dev8/3d86fd0a', node: process.version, dataRoot, goldPath,
    arm: process.env.COMPACTION_RECALL_SQLITE_ARM ?? 'off', cases: []
  };
  for (const item of cases) {
    const sync = await createEngine(item.documents);
    const worker = new SQLiteBackgroundIndex({ engineModule: new URL('./retrieval-sqlite-worker.mjs', import.meta.url) });
    const results = [];
    try {
      const start = performance.now();
      await worker.prepare(item.branch, { preindexLive: true });
      const buildMs = performance.now() - start;
      const manualQueries = item.language === 'en'
        ? [{ concepts: [['coffee shop']] }, { concepts: [['coffee'], ['shop']], match: 'all' },
          { concepts: [['relationship', 'friend']] }, { concepts: [['Sophia']] }, { concepts: [['coffee']], exclude: ['absent'] }]
        : [{ concepts: [['咖啡商店']] }, { concepts: [['关系', '朋友']] }, { concepts: [['咖啡']] },
          { concepts: [['城市']] }, { concepts: [['强迫性性行为'], ['网关']] }];
      const automaticQueries = item.language === 'en' ? [item.question, 'Where coffee shops Sophia?', 'friend relationship']
        : [item.question, '咖啡商店 Sophia', '关系朋友'];
      for (const [mode, query] of [...automaticQueries.map(query => ['auto', query]), ...manualQueries.map(query => ['manual', query])]) {
        const before = performance.now();
        const expected = mode === 'auto' ? await sync.searchAuto(query) : (await sync.search(query)).results;
        const synchronousMs = performance.now() - before;
        const requested = performance.now();
        const actual = await worker.queryRanked(query, item.branch, { mode, options: { limit: 1, offset: 1 } });
        const workerMs = performance.now() - requested;
        assert.equal(actual.total, expected.length);
        assert.deepEqual(ranks(actual.results), expected, `${item.language} ${mode} ${JSON.stringify(query)}`);
        results.push({
          mode, query,
          total: actual.total, identicalRanksAndScores: true, synchronousMs, workerMs,
          ranking: ranks(actual.results)
        });
      }
      report.cases.push({ language: item.language, documents: item.documents.length, buildMs, results });
    } finally {
      await sync.dispose();
      await worker.dispose();
    }
  }
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination);
  writeFileSync(resolve(destination, 'parity.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, data: { type: 'string' }, gold: { type: 'string' } } });
  await runParity({ output: values.output, dataRoot: values.data, goldPath: values.gold });
  console.log('SQLite full-ranking parity passed for dev8/3d86fd0a en/zh; report: ' + resolve(values.output, 'parity.json'));
}
