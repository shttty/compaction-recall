// Post-hoc evidence evaluation only; never used by retrieval/rerank models.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { formatLocatorRows, lex, rankLocatorCandidates } from './archive/js-runtime/locator.mjs';
import { buildBlindCorpus } from './blind-harness-core.mjs';
import { searchableEntryText, compactedEntries } from '../src/history.mjs';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
const { values: args } = parseArgs({ options: { config: { type: 'string' }, help: { type: 'boolean' } } });
if (args.help) { console.log('Usage: node benchmark/summarize-rerank.mjs --config SUMMARY_CONFIG_JSON'); process.exit(0); }
if (!args.config) throw new Error('Explicit summary config required');
const config = JSON.parse(readFileSync(args.config)), baseDir = dirname(resolve(args.config));
for (const key of ['retrieval', 'inputs', 'data', 'output']) if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Missing path: ${key}`);
if (!config.models || typeof config.models !== 'object' || Array.isArray(config.models) || !Object.keys(config.models).length) throw new Error('Explicit model label -> result path mapping required');
for (const [name, file] of Object.entries(config.models)) if (!/^[A-Za-z0-9_-]+$/.test(name) || ['grep', 'mechanical', '__proto__', 'constructor', 'prototype'].includes(name) || typeof file !== 'string' || !file) throw new Error('Invalid model result label/path');
const load = file => JSON.parse(readFileSync(resolve(baseDir, file)));
const base = load(config.retrieval), inputs = load(config.inputs);
const models = Object.fromEntries(Object.entries(config.models).map(([name, file]) => [name, load(file)]));
const inputHash = createHash('sha256').update(readFileSync(resolve(baseDir, config.inputs))).digest('hex');
for (const result of Object.values(models)) if (result.inputSha256 !== inputHash) throw Error('Model input hash differs');
const rawQuestions = load(config.data);
const entries = compactedEntries(buildBlindCorpus(rawQuestions).branch), entryById = new Map(entries.map((e, i) => [e.id, { entry: e, recency: i }]));
const eligibleDocumentCount = entries.filter(e => searchableEntryText(e)).length;
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const outputIds = s => s?.split('\n').filter(x => x.startsWith('{')).map(JSON.parse).map(x => x.id) ?? [];
const ownGoldByQuestion = new Map();
for (const q of rawQuestions) { const ids = new Set(); let seq = 0; const sessions = q.haystack_sessions.map((turns, i) => ({ turns, date: q.haystack_dates[i] })).sort((a, b) => a.date.replace(/ \(\w+\)/, '').localeCompare(b.date.replace(/ \(\w+\)/, ''))); for (const { turns } of sessions) { if (!turns.length) continue; if (turns[0].role !== 'user') seq++; for (const t of turns) { const id = `${q.question_id}:${(++seq).toString(16).padStart(8, '0')}`; if (t.has_answer) ids.add(id); } } ownGoldByQuestion.set(q.question_id, ids); }
const rows = [];
for (const q of base.questions) {
 const rowById = new Map(q.pool.map(x => [x.id, x.row]));
 const unionIds = [...new Set([...q.grepCandidateIds, ...q.recallCandidateIds])], wanted = new Set(q.terms);
 const reconstructed = unionIds.map(id => { const { entry, recency } = entryById.get(id), text = searchableEntryText(entry), matches = new Set(), offsets = new Map(); for (const t of lex(text)) if (wanted.has(t.term)) { matches.add(t.term); if (!offsets.has(t.term)) offsets.set(t.term, t.offset); } return { id, recency, text, date: entry.timestamp.slice(0, 10), role: entry.message.role, matches, offsets, offset: offsets.size ? [...offsets.values()][0] : text.match(new RegExp(q.pattern, 'i'))?.index ?? 0 }; });
 const distinct = rankLocatorCandidates(reconstructed, new Map(q.frequency), eligibleDocumentCount);
 // Reconstruct with the exact searchable nonempty-document count.
 if (JSON.stringify(distinct.slice(0, 50).map(c => c.id)) !== JSON.stringify(q.poolIds)) throw Error('Reconstructed pool differs');
 const evidence = ids => ({
  locatedGoldTurns: new Set(ids.filter(id => q.goldKeysById[id]).map(id => q.goldKeysById[id])).size,
  hit: ids.some(id => q.goldKeysById[id]), ownSourceHit: ids.some(id => ownGoldByQuestion.get(q.id).has(id)), returned: ids.length
 });
 const item = {
  id: q.id, query: q.query, candidateStats: { grepAfterDedupe: q.grepCandidateIds.length, recallIds: q.recallCandidateIds.length, mergedUniqueIds: unionIds.length, afterCrossSourceDedupe: distinct.length, finalPool: q.poolIds.length, sourceWindowShortened: q.pool.filter(c => c.sourceChars > 2048).length }, goldTotal: q.goldTotal, poolSize: q.poolIds.length, poolEvidence: evidence(q.poolIds),
  grep: { ids: q.grepTopIds, ...evidence(q.grepTopIds), beforeBudget: evidence(q.grepCandidateIds.slice(0, 5)) }, mechanical: { ids: q.mechanicalTopIds, ...evidence(q.mechanicalTopIds), beforeBudget: evidence(q.poolIds.slice(0, 5)) },
  timingsMs: { grepTool: q.grepMs, recallTools: q.recallMs, sharedPreparation: q.mechanicalMs }
 };
 const target = norm(rawQuestions.find(x => x.question_id === q.id).answer);
 const windows = inputs.questions.find(x => x.id === q.id).pool;
 item.referenceLiteralAppearsInPoolWindow = !!target && windows.some(x => norm(x.passage).includes(target));
 for (const name of Object.keys(models)) {
  const result = models[name].results.find(x => x.id === q.id); if (!result) throw Error('Incomplete model run');
  if (Object.values(result.scores).some(score => !Number.isFinite(score))) throw Error('Non-finite reranker score');
  if (result.orderedIds.length !== q.poolIds.length || new Set(result.orderedIds).size !== q.poolIds.length || result.orderedIds.some(id => !rowById.has(id))) throw Error('Candidate pool changed');
  const output = formatLocatorRows(result.orderedIds.map(id => rowById.get(id))), ids = outputIds(output);
  item[name] = { ids, output, ...evidence(ids), beforeBudget: evidence(result.orderedIds.slice(0, 5)), rerankMs: result.seconds * 1000, maxInputTokens: result.maxInputTokens, cappedAt512: result.cappedAt512 };
 }
 rows.push(item);
}
const median = xs => { const s = [...xs].sort((a, b) => a - b), i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const aggregate = {};
for (const arm of ['grep', 'mechanical', ...Object.keys(models)]) aggregate[arm] = {
 questionsWithGold: rows.filter(x => x[arm].hit).length,
 questionsWithAllMarkedTurns: rows.filter(x => x[arm].locatedGoldTurns === x.goldTotal).length, beforeBudgetQuestionsWithGold: rows.filter(x => x[arm].beforeBudget.hit).length, ownSourceQuestionsWithGold: rows.filter(x => x[arm].ownSourceHit).length, goldTurnsLocated: rows.reduce((s, x) => s + x[arm].locatedGoldTurns, 0),
 medianRerankMs: models[arm] ? median(rows.map(x => x[arm].rerankMs)) : null, peakRssMiB: models[arm]?.peakRssMiB ?? null, loadSeconds: models[arm]?.loadSeconds ?? null
};
const summary = {
 date: new Date().toISOString(), protocol: base.protocol, queryCount: rows.length, goldTurns: rows.reduce((s, x) => s + x.goldTotal, 0),
 candidateCeiling: { questionsWithGold: rows.filter(x => x.poolEvidence.hit).length, goldTurns: rows.reduce((s, x) => s + x.poolEvidence.locatedGoldTurns, 0) },
 retrievalMediansMs: { grepTool: median(rows.map(x => x.timingsMs.grepTool)), recallTools: median(rows.map(x => x.timingsMs.recallTools)), sharedPreparation: median(rows.map(x => x.timingsMs.sharedPreparation)) }, aggregate, rows
};
writeFileSync(resolve(baseDir, config.output), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
