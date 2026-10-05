// Public retrieval-only inputs; gold stays outside the engine boundary.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactedEntries, searchableEntryText } from '../src/history.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
const cleanDate = date => date.replace(/ \(\w+\)/, '');

export function buildEvaluationCorpus({ questionId, haystack_dates, haystack_sessions }) {
  const entries = [], positions = new Map();
  const sessions = haystack_sessions.map((turns, session) => ({ turns, session, date: haystack_dates[session] }))
    .sort((a, b) => cleanDate(a.date).localeCompare(cleanDate(b.date)));
  let seq = 0;
  for (const { turns, session, date } of sessions) {
    if (!turns.length) continue;
    const base = Date.parse(cleanDate(date).replaceAll('/', '-').replace(' ', 'T') + ':00Z');
    const append = (role, content, turn) => {
      const id = `${questionId}:${(++seq).toString(16).padStart(8, '0')}`;
      const timestamp = new Date(base + seq * 1000).toISOString();
      entries.push({
        type: 'message', id, parentId: entries.at(-1)?.id ?? null, timestamp,
        message: { role, content: [{ type: 'text', text: content }], timestamp: Date.parse(timestamp) }
      });
      if (turn !== undefined) positions.set(`${session}:${turn}`, id);
    };
    if (turns[0].role !== 'user') append('user', `[Session Date: ${date}]`);
    turns.forEach((turn, i) => append(turn.role,
      i === 0 && turn.role === 'user' ? `[Session Date: ${date}]\n${turn.content}` : turn.content, i));
  }
  const tail = {
    type: 'message', id: 'retained:tail', timestamp: '2026-09-30T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'retained tail' }], timestamp: 0 }
  };
  const branch = [...entries, tail, {
    type: 'compaction', id: 'blind-simulated-final', timestamp: tail.timestamp,
    firstKeptEntryId: tail.id, summary: '', tokensBefore: 0
  }];
  const documents = compactedEntries(branch).flatMap(entry => {
    const text = searchableEntryText(entry);
    return text === undefined ? [] : [{ id: entry.id, text }];
  });
  return { branch, documents, positions };
}

// Validate every gold coordinate in both languages before returning any selected case.
export function loadEvaluationCases({ dataRoot, goldPath }) {
  const gold = load(goldPath).gold;
  if (!gold || Object.keys(gold).length !== 16) throw new Error('Gold must contain exactly 16 question keys');
  const cases = [];
  for (const [key, marks] of Object.entries(gold)) {
    if (!/^(dev8|hard8)\/[A-Za-z0-9_-]+$/.test(key)) throw new Error(`Invalid gold key: ${key}`);
    const dir = join(dataRoot, key), prompt = load(join(dir, 'question-zh.json'));
    const questionId = key.split('/')[1];
    if (prompt.question_id !== questionId || prompt.split !== key.split('/')[0]) throw new Error(`Question identity mismatch: ${key}`);
    const corpora = { en: load(join(dir, 'corpus.json')), zh: load(join(dir, 'corpus-zh.json')) };
    if (!Array.isArray(marks) || !marks.length) throw new Error(`Missing gold: ${key}`);
    for (const mark of marks) {
      if (!Number.isSafeInteger(mark.session) || mark.session < 0 || !Number.isSafeInteger(mark.turn) || mark.turn < 0 || !['user', 'assistant'].includes(mark.role)) throw new Error(`Invalid gold coordinate: ${key}`);
      for (const [language, corpus] of Object.entries(corpora)) {
        const turn = corpus.haystack_sessions?.[mark.session]?.[mark.turn];
        if (!turn || turn.role !== mark.role) throw new Error(`Gold role/position mismatch: ${key}/${language}/${mark.session}:${mark.turn}`);
      }
    }
    for (const [language, corpus] of Object.entries(corpora)) {
      const built = buildEvaluationCorpus({ questionId, haystack_dates: corpus.haystack_dates, haystack_sessions: corpus.haystack_sessions });
      const question = language === 'en' ? prompt.question_en : prompt.question;
      if (typeof question !== 'string') throw new Error(`Missing question: ${key}/${language}`);
      const goldIds = marks.map(mark => built.positions.get(`${mark.session}:${mark.turn}`));
      cases.push({ key, questionId, language, question, questionDate: prompt.question_date, ...built, goldIds });
    }
  }
  return cases;
}

export function weightedQuestionLength(question) {
  let length = 0;
  for (const char of question) length += /\p{Script=Han}/u.test(char) ? 2 : 1;
  return length;
}

export async function searchAutomatic(engine, question) {
  return weightedQuestionLength(question) > 210 ? [] : await engine.searchAuto(question);
}

export function validateRanking(results, documents) {
  const allowed = new Set(documents.map(doc => doc.id)), seen = new Set();
  if (!Array.isArray(results)) throw new Error('searchAuto must return the complete ranked array');
  for (const row of results) {
    if (!row || !allowed.has(row.id) || !Number.isFinite(row.score) || seen.has(row.id)) throw new Error('Invalid engine ranking (id, score or duplicate)');
    seen.add(row.id);
  }
  return results;
}

export function scoreRetrieval({ goldIds, autoResults, calls = [] }) {
  const gold = new Set(goldIds);
  if (!gold.size) throw new Error('Cannot score without gold');
  const ids = rows => rows.map(row => typeof row === 'string' ? row : row.id);
  const automatic = ids(autoResults), rankings = calls.map(call => ids(call.results ?? []));
  const ranked = rankings[0] ?? automatic;
  const hits = values => new Set(values.filter(id => gold.has(id))).size;
  const first = ranked.findIndex(id => gold.has(id));
  const metrics = {
    mrr: first < 0 ? 0 : 1 / (first + 1), goldTotal: gold.size,
    top5Hit: hits(ranked.slice(0, 5)) > 0, locatedGoldTurns: hits(ranked.slice(0, 5)),
    callCount: calls.length, noCall: calls.length === 0,
    queryMismatchCount: calls.filter(call => (Object.hasOwn(call, 'input_identical') ? call.input_identical : call.query_identical) === false).length,
    errorCount: calls.filter(call => call.error !== undefined && call.error !== null).length
  };
  for (const k of [5, 10, 20]) {
    const top = ranked.slice(0, k), seen = new Set();
    const dcg = top.reduce((sum, id, i) => {
      const relevant = gold.has(id) && !seen.has(id); seen.add(id);
      return sum + (relevant ? 1 / Math.log2(i + 2) : 0);
    }, 0);
    const ideal = Array.from({ length: Math.min(k, gold.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    metrics[`ndcg@${k}`] = dcg / ideal;
    metrics[`recall@${k}`] = hits([...automatic.slice(0, k), ...rankings.flatMap(rows => rows.slice(0, k))]) / gold.size;
    metrics[`precision@${k}`] = hits(top) / k;
  }
  return metrics;
}

export function summarizeRetrieval(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.prototype, row.language]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(group => {
    const sum = key => group.reduce((total, row) => total + Number(row.metrics[key]), 0);
    const means = Object.fromEntries(['mrr', ...[5, 10, 20].flatMap(k => [`ndcg@${k}`, `recall@${k}`, `precision@${k}`])].map(key => [key, sum(key) / group.length]));
    return {
      prototype: group[0].prototype, language: group[0].language, questions: group.length, ...means,
      top5HitQuestions: sum('top5Hit'), locatedGoldTurns: sum('locatedGoldTurns'), goldTotal: sum('goldTotal'),
      calls: sum('callCount'), noCallQuestions: sum('noCall'), queryMismatches: sum('queryMismatchCount'), errors: sum('errorCount')
    };
  });
}
