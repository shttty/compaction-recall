#!/usr/bin/env node
// Shared preparation/scoring only; model execution remains evaluate.py -> sdk-rpc.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadEvaluationCases, searchAutomatic, validateRanking, scoreRetrieval, summarizeRetrieval } from './retrieval-eval-core.mjs';

const [operation, requestPath] = process.argv.slice(2);
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const save = (filename, value) => writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
if (operation === 'prepare') {
  const cases = loadEvaluationCases({ dataRoot: request.dataRoot, goldPath: request.goldPath });
  const selected = cases.filter(c => (!request.questions?.length || request.questions.includes(c.key)) && (!request.languages?.length || request.languages.includes(c.language)));
  if (!selected.length) throw new Error('No selected question/language');
  for (const key of request.questions ?? []) if (!cases.some(c => c.key === key)) throw new Error(`Unknown question: ${key}`);
  const { createEngine } = await import(pathToFileURL(path.resolve(request.engine)).href);
  const manifest = [];
  for (const c of selected) {
    const directory = path.join(request.output, c.key, c.language);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const started = performance.now();
    const engine = await createEngine(c.documents);
    let autoResults;
    const prompt = request.prompts[`${c.key}/${c.language}`];
    if (typeof prompt !== 'string') throw new Error('Missing exact ASK prompt');
    const automaticQuery = c.question;
    try { autoResults = validateRanking(await searchAutomatic(engine, automaticQuery), c.documents); }
    finally { await engine.dispose?.(); }
    const preparation = { wallMs: performance.now() - started, rssBytes: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS };
    const snapshot = path.join(directory, 'snapshot.jsonl');
    const now = new Date().toISOString();
    const rows = [{ type: 'session', version: 3, id: randomUUID(), timestamp: now, cwd: request.output }];
    let parentId = null;
    for (const entry of c.branch) { rows.push({ ...entry, parentId }); parentId = entry.id; }
    writeFileSync(snapshot, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    const metadata = { key: c.key, questionId: c.questionId, language: c.language, question: c.question, questionDate: c.questionDate, goldIds: c.goldIds, autoResults, automaticQuery, preparation, snapshot, directory };
    save(path.join(directory, 'retrieval.json'), metadata);
    const inputPath = path.join(directory, 'input.json');
    writeFileSync(inputPath, JSON.stringify({ question: c.question, question_date: c.questionDate, prompt }) + '\n', { mode: 0o444, flag: 'wx' });
    manifest.push(metadata);
  }
  save(path.join(request.output, 'cases.json'), manifest);
  console.log(JSON.stringify({ prepared: manifest.length, validated: cases.length }));
} else if (operation === 'score') {
  const rows = [];
  for (const item of request.cases) {
    const metadata = JSON.parse(readFileSync(item.metadata, 'utf8'));
    const events = readFileSync(item.trace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const traces = events.filter(event => event.type === 'history_recall_trace').sort((a, b) => a.callIndex - b.callIndex);
    if (traces.length !== item.recallCalls) throw new Error(`Incomplete trace for ${metadata.key}/${metadata.language}: expected ${item.recallCalls}, got ${traces.length}`);
    const calls = traces.map(event => ({ results: event.result?.ids ?? [], query_identical: event.query_identical, error: event.error }));
    rows.push({
      prototype: request.prototype, key: metadata.key, language: metadata.language,
      metrics: scoreRetrieval({ goldIds: metadata.goldIds, autoResults: metadata.autoResults, calls }),
      latency: { preparationMs: metadata.preparation.wallMs, answerWallMs: item.answerWallMs, sdk: item.timing },
      memory: { preparation: metadata.preparation, sdk: item.memory }, answerPath: item.answerPath
    });
  }
  const report = { group: 2, singleRun: true, rows, summary: summarizeRetrieval(rows) };
  save(request.report, report);
  console.log(JSON.stringify({ report: request.report, questions: rows.length, summary: report.summary }));
} else throw new Error('Expected prepare|score REQUEST.json');
