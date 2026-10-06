// Retrieval-only candidate preparation. Gold metadata is consulted only after pool selection.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import register from '../src/index.ts';
import { buildBlindCorpus } from './blind-harness-core.mjs';
import { compactedEntries, searchableEntryText } from '../src/history.mjs';
import { queryTerms, collectLocatorCandidates, rankLocatorCandidates, dedupeLocatorCandidates, formatRankedLocators, locatorWindow, locatorRow } from './archive/js-runtime/locator.mjs';
import { parseArgs } from 'node:util';
const { values: args } = parseArgs({ options: { data: { type: 'string' }, candidates: { type: 'string' }, results: { type: 'string' }, help: { type: 'boolean' } } });
if (args.help) { console.log('Usage: node benchmark/prepare-rerank.mjs --data QUESTIONS_JSON --candidates NEW_PRIVATE_JSON --results NEW_RETRIEVAL_JSON'); process.exit(0); }
if (!args.data || !args.candidates || !args.results) throw new Error('Explicit data, candidates and results paths required');
const hash = x => createHash('sha256').update(x).digest('hex');
const questions = JSON.parse(readFileSync(args.data));
const { branch } = buildBlindCorpus(questions), entries = compactedEntries(branch), byId = new Map(entries.map((e, i) => [e.id, { entry: e, recency: i }]));
const tools = new Map(); register({ registerTool: t => tools.set(t.name, t), on() { } });
const ctx = { sessionManager: { getBranch: () => branch.slice() } };
const execute = (name, params) => tools.get(name).execute('retrieval-comparison', params, undefined, undefined, ctx);
const rowIds = output => output?.split('\n').filter(x => x.startsWith('{')).map(JSON.parse).map(x => x.id) ?? [];
const results = [];
for (const question of questions) {
 const query = question.question, terms = queryTerms(query), pattern = terms.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
 let start = performance.now();
 const grep = await execute('history_grep', { pattern }); const grepMs = performance.now() - start;
 const grepIds = [...new Set(grep.content[0].text.split('\n').flatMap(line => { const m = line.match(/^\[([^\]]+)\]/); return m ? [m[1]] : []; }))];
 start = performance.now(); const recallIds = []; let offset = 0, recallCalls = 0;
 do { const page = await execute('history_recall', { query, limit: 50 - recallIds.length, offset }); recallCalls++; recallIds.push(...rowIds(page.content[0].text)); offset = page.details.nextOffset; } while (offset !== null && recallIds.length < 50);
 const recallMs = performance.now() - start;
 start = performance.now();
 const found = collectLocatorCandidates(query, branch), frequency = found?.frequency ?? new Map(), documents = found?.documents ?? 0;
 const candidates = new Map((found?.candidates ?? []).map(x => [x.id, x]));
 for (const id of grepIds) if (!candidates.has(id)) {
  const { entry, recency } = byId.get(id), text = searchableEntryText(entry); const match = text.match(new RegExp(pattern, 'i'));
  candidates.set(id, { id, recency, text, date: entry.timestamp.slice(0, 10), role: entry.message.role, matches: new Set(), offset: match?.index ?? 0 });
 }
 const grepCandidates = dedupeLocatorCandidates(grepIds.map(id => candidates.get(id)), frequency).sort((a, b) => a.recency - b.recency);
 const union = [...new Set([...grepIds, ...recallIds])].map(id => candidates.get(id));
 const rankedUnion = rankLocatorCandidates(union, frequency, documents);
 const pool = rankedUnion.slice(0, 50);
 const mechanicalMs = performance.now() - start;
 const grepOutput = formatRankedLocators(grepCandidates, frequency), mechanicalOutput = formatRankedLocators(pool, frequency);
 results.push({
  id: question.question_id, query, pattern, terms, grepMs, recallMs, mechanicalMs, recallCalls, grepReportedMatches: grep.details.total,
  candidateStats: { grepUniqueIds: grepIds.length, grepAfterDedupe: grepCandidates.length, recallIds: recallIds.length, unionUniqueIds: union.length, unionAfterDedupe: rankedUnion.length, finalPool: pool.length },
  grepCandidateIds: grepCandidates.map(x => x.id), recallCandidateIds: recallIds, poolIds: pool.map(x => x.id),
  grepTopIds: rowIds(grepOutput), mechanicalTopIds: rowIds(mechanicalOutput), grepOutput, mechanicalOutput,
  frequency: [...frequency], pool: pool.map(c => ({ id: c.id, recency: c.recency, row: locatorRow(c, frequency), passage: locatorWindow(c, frequency, 2048), sourceChars: Array.from(c.text).length }))
 });
 console.error(question.question_id, 'pool', pool.length, 'grep', grepIds.length, 'recall', recallIds.length);
}
// Post-selection evidence mapping. Never consulted by candidate selection/windowing.
const keyById = new Map(), goldByQuestion = new Map(), ownGold = new Map();
for (const q of questions) {
 const golden = new Set(), own = new Set(); goldByQuestion.set(q.question_id, golden); ownGold.set(q.question_id, own);
 const sessions = q.haystack_sessions.map((turns, i) => ({ turns, date: q.haystack_dates[i] })).sort((a, b) => a.date.replace(/ \(\w+\)/, '').localeCompare(b.date.replace(/ \(\w+\)/, '')));
 let seq = 0;
 for (const { turns } of sessions) {
  if (!turns.length) continue; if (turns[0].role !== 'user') seq++;
  for (const t of turns) { const id = `${q.question_id}:${(++seq).toString(16).padStart(8, '0')}`, key = hash(JSON.stringify([t.role, t.content])); keyById.set(id, key); if (t.has_answer) { golden.add(key); own.add(id); } }
 }
}
for (const r of results) {
 const gold = goldByQuestion.get(r.id); r.goldTotal = gold.size; r.goldPoolIds = r.poolIds.filter(id => gold.has(keyById.get(id))); r.ownGoldPoolIds = r.poolIds.filter(id => ownGold.get(r.id).has(id)); r.ownGoldIds = [...ownGold.get(r.id)];
 r.goldKeysById = Object.fromEntries([...new Set([...r.poolIds, ...r.grepCandidateIds])].filter(id => gold.has(keyById.get(id))).map(id => [id, keyById.get(id)]));
}
const payload = { protocol: 'fixed50-dedupe-before-rank-v1', sourceSha256: hash(readFileSync(args.data)), date: new Date().toISOString(), node: process.version, memory: process.memoryUsage(), questions: results };
// Model input file deliberately contains no gold fields, answers or evidence labels.
writeFileSync(args.candidates, JSON.stringify({ protocol: payload.protocol, questions: results.map(r => ({ id: r.id, query: r.query, pool: r.pool.map(({ id, passage }) => ({ id, passage })) })) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
writeFileSync(args.results, JSON.stringify({ ...payload, questions: results.map(({ pool, ...r }) => ({ ...r, pool: pool.map(({ passage, ...c }) => c) })) }, null, 2) + '\n', { flag: 'wx' });
