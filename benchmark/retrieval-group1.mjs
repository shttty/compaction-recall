// Mechanical retrieval only: no model, answer generation, judge or implicit engine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEvaluationCases, searchAutomatic, validateRanking, scoreRetrieval, summarizeRetrieval } from './retrieval-eval-core.mjs';

export async function runGroup1({ enginePath, dataRoot, goldPath, prototype, question, language }) {
  // Validation of all 16 bilingual corpora precedes engine loading and any scoring.
  const all = loadEvaluationCases({ dataRoot, goldPath });
  if (language !== undefined && !['en', 'zh'].includes(language)) throw new Error('language must be en or zh');
  const selected = all.filter(item => (!question || item.key === question || item.questionId === question) && (!language || item.language === language));
  if (!selected.length) throw new Error('No matching evaluation cases');
  const { createEngine } = await import(pathToFileURL(resolve(enginePath)).href);
  if (typeof createEngine !== 'function') throw new Error('Engine module must export createEngine(documents)');
  const rows = [];
  for (const item of selected) {
    const memoryBefore = process.memoryUsage();
    const start = performance.now();
    const engine = await createEngine(item.documents);
    const buildMs = performance.now() - start;
    try {
      if (typeof engine.searchAuto !== 'function' || typeof engine.searchRaw !== 'function') throw new Error('Engine requires searchAuto and searchRaw');
      const searchStart = performance.now();
      const results = await searchAutomatic(engine, item.question);
      const searchMs = performance.now() - searchStart;
      validateRanking(results, item.documents);
      rows.push({
        key: item.key, questionId: item.questionId, language: item.language, prototype,
        question: item.question, results, metrics: scoreRetrieval({ goldIds: item.goldIds, autoResults: results }),
        latency: { buildMs, searchMs }, memory: { before: memoryBefore, after: process.memoryUsage() }
      });
    } finally {
      await engine.dispose?.();
    }
  }
  return {
    group: 1, protocol: 'question-verbatim-auto', rows, summary: summarizeRetrieval(rows),
    resources: { maxRssKiB: process.resourceUsage().maxRSS, note: 'Process-wide high-water mark; latency and memory are not relevance scores.' }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['engine', 'data', 'gold', 'output', 'prototype', 'question', 'language'].map(name => [name, { type: 'string' }])) });
  for (const name of ['engine', 'data', 'gold', 'output', 'prototype']) if (!values[name]) throw new Error(`Explicit --${name} required`);
  const report = await runGroup1({
    enginePath: values.engine, dataRoot: values.data, goldPath: values.gold,
    prototype: values.prototype, question: values.question, language: values.language
  });
  mkdirSync(dirname(resolve(values.output)), { recursive: true });
  writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report.summary, null, 2));
}
