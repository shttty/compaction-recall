import './isolated-agent-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBlindCorpus } from '../benchmark/blind-harness-core.mjs';
import { compactedEntries } from '../src/history.mjs';
import { buildEvaluationCorpus, loadEvaluationCases, searchAutomatic, scoreRetrieval, summarizeRetrieval } from '../benchmark/retrieval-eval-core.mjs';
import { runGroup1 } from '../benchmark/retrieval-group1.mjs';
import { buildRecallPage, collectLocatorCandidates, rankLocatorCandidates, locatorRow, recallPageFromRows } from '../src/locator.mjs';

const question = { question_id: 'q', question: 'quasar?', question_date: '2023/06/01 (Thu) 12:00',
  answer: 'ORACLE_SECRET', judge: 'JUDGE_SECRET', labels: ['LABEL_SECRET'],
  haystack_dates: ['2023/05/22 (Mon) 12:00', '2023/05/20 (Sat) 12:00', '2023/05/20 (Sat) 12:00'],
  haystack_sessions: [[{ role: 'user', content: 'quasar later', has_answer: true }],
    [{ role: 'assistant', content: 'quasar earlier', labels: ['LABEL_SECRET'] }, { role: 'user', content: 'quasar reply' }],
    [{ role: 'user', content: 'quasar tied' }]] };
const corpus = () => buildEvaluationCorpus({ questionId: question.question_id, ...question });

test('corpus matches blind chronology, inserted dates, compaction and original coordinates without oracle fields', () => {
  const built = corpus();
  assert.deepEqual(built.branch, buildBlindCorpus([question]).branch);
  assert.equal(built.positions.get('1:0'), 'q:00000002');
  assert.equal(built.positions.get('2:0'), 'q:00000004');
  assert.equal(built.positions.get('0:0'), 'q:00000005');
  assert.equal(compactedEntries(built.branch).length, 5);
  assert.equal(built.branch.at(-1).summary, '');
  assert.doesNotMatch(JSON.stringify(built), /ORACLE_SECRET|JUDGE_SECRET|LABEL_SECRET|has_answer|judge|labels/);
  assert.deepEqual(built.documents.map(doc => doc.id), ['q:00000001', 'q:00000002', 'q:00000003', 'q:00000004', 'q:00000005']);
});

test('already-ranked pagination preserves production bytes, order, offsets and oversized-row progress', () => {
  const branch = corpus().branch, found = collectLocatorCandidates('quasar', branch);
  const ranked = rankLocatorCandidates(found.candidates, found.frequency, found.documents);
  const rows = ranked.map(candidate => locatorRow(candidate, found.frequency));
  for (const options of [{}, { limit: 1 }, { limit: 2, offset: 1 }, { offset: 100 }]) {
    assert.deepEqual(recallPageFromRows(rows, options), buildRecallPage('quasar', branch, options));
  }
  const reversed = [...rows].reverse();
  const first = recallPageFromRows(reversed, { limit: 1 });
  assert.equal(JSON.parse(first.text.split('\n').find(line => line.startsWith('{'))).id, reversed[0].id);
  const huge = recallPageFromRows([{ id: 'x'.repeat(17000), date: '', role: 'user', snippet: '' }, ...rows], { limit: 2 });
  assert.equal(huge.details.returned, 1);
  assert.equal(huge.details.nextOffset, 1);
  assert.equal(huge.details.budgetExceeded, true);
  assert.throws(() => recallPageFromRows(rows, { offset: -1 }), /offset/);
  assert.deepEqual(recallPageFromRows([]), buildRecallPage('unfindable', branch));
});

test('automatic threshold permits exactly 210 weighted characters and does not rewrite accepted input', async () => {
  const seen = [], engine = { searchAuto(query) { seen.push(query); return [{ id: 'a', score: 1 }]; } };
  assert.deepEqual(await searchAutomatic(engine, '中'.repeat(105)), [{ id: 'a', score: 1 }]);
  assert.deepEqual(await searchAutomatic(engine, 'a'.repeat(210)), [{ id: 'a', score: 1 }]);
  assert.deepEqual(await searchAutomatic(engine, '中'.repeat(105) + 'a'), []);
  assert.deepEqual(await searchAutomatic(engine, 'a'.repeat(211)), []);
  assert.deepEqual(seen, ['中'.repeat(105), 'a'.repeat(210)]);
  const error = new Error('raw engine failure');
  await assert.rejects(searchAutomatic({ searchAuto() { throw error; } }, 'valid'), caught => caught === error);
});

test('group2 recall unions per-call top K, while rank metrics use only first call even on error', () => {
  const goldIds = ['a', 'b', 'c'];
  const autoResults = ['a', 'x', 'y', 'z', 'w', 'c'];
  const calls = [{ results: ['x', 'b'], query_identical: false }, { results: ['c', 'b'] }];
  const scores = scoreRetrieval({ goldIds, autoResults, calls });
  assert.equal(scores.mrr, 0.5);
  assert.equal(scores['recall@5'], 1);
  assert.equal(scores['precision@5'], 1 / 5);
  assert.equal(scores['ndcg@5'], (1 / Math.log2(3)) / (1 + 1 / Math.log2(3) + 1 / Math.log2(4)));
  assert.equal(scores.locatedGoldTurns, 1);
  assert.equal(scores.queryMismatchCount, 1);
  const none = scoreRetrieval({ goldIds, autoResults });
  assert.equal(none.mrr, 1);
  assert.equal(none['recall@5'], 1 / 3);
  assert.equal(none['recall@10'], 2 / 3);
  assert.equal(none.noCall, true);
  const failed = scoreRetrieval({ goldIds, autoResults, calls: [{ error: 'syntax error' }, { results: ['b'] }] });
  assert.equal(failed.mrr, 0);
  assert.equal(failed['ndcg@5'], 0);
  assert.equal(failed['recall@5'], 2 / 3);
  assert.equal(failed.errorCount, 1);
  const grouped = summarizeRetrieval([{ prototype: 'p', language: 'zh', metrics: scores }, { prototype: 'p', language: 'zh', metrics: none }, { prototype: 'p', language: 'en', metrics: failed }]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].mrr, 0.75);
  assert.equal(grouped[0].noCallQuestions, 1);
});

function dataset(t) {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-eval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gold = {};
  for (let i = 0; i < 16; i++) {
    const key = `${i < 8 ? 'dev8' : 'hard8'}/q${i}`, dir = join(root, key);
    mkdirSync(dir, { recursive: true });
    const raw = { ...question, question_id: `q${i}` };
    for (const name of ['corpus.json', 'corpus-zh.json']) writeFileSync(join(dir, name), JSON.stringify(raw));
    writeFileSync(join(dir, 'question-zh.json'), JSON.stringify({ question_id: `q${i}`, split: key.split('/')[0], question: '中文', question_en: 'English', question_date: question.question_date, answer: 'ORACLE_SECRET' }));
    gold[key] = [{ session: 1, turn: 0, role: 'assistant' }];
  }
  const goldPath = join(root, 'gold.json');
  writeFileSync(goldPath, JSON.stringify({ gold }));
  return { root, goldPath };
}

test('loader validates all 16 bilingual gold positions before selected runs and strips oracle metadata', async t => {
  const { root, goldPath } = dataset(t);
  const cases = loadEvaluationCases({ dataRoot: root, goldPath });
  assert.equal(cases.length, 32);
  assert.deepEqual(cases[0].goldIds, ['q0:00000002']);
  assert.equal(cases[0].question, 'English');
  assert.equal(cases[1].question, '中文');
  assert.doesNotMatch(JSON.stringify(cases), /ORACLE_SECRET|JUDGE_SECRET|LABEL_SECRET|has_answer|answer|judge|labels/);
  const broken = { ...question, haystack_sessions: [[{ role: 'user', content: 'x' }]] };
  writeFileSync(join(root, 'hard8/q15/corpus-zh.json'), JSON.stringify(broken));
  await assert.rejects(runGroup1({ enginePath: join(root, 'absent-engine.mjs'), dataRoot: root, goldPath, prototype: 'test', question: 'q0', language: 'en' }), /Gold role\/position mismatch: hard8\/q15\/zh/);
});
