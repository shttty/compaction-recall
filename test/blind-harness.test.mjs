import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlindHarness, buildBlindCorpus } from '../prototype/blind-harness-core.mjs';
const question = { question_id: 'blindq', question: 'What is the quasar code?', question_date: '2023/06/01 (Thu) 12:00',
  answer: 'ORACLE_SENTINEL_DO_NOT_EXPOSE', answer_session_ids: ['secret-evidence'],
  haystack_dates: ['2023/05/20 (Sat) 12:00'], haystack_sessions: [[
    { role: 'user', content: 'The quasar code is blue.', has_answer: true, extra_oracle: 'GOLD_METADATA' },
    { role: 'assistant', content: 'Quasar noted.' },
  ]] };
test('blind adapter strips machine oracle fields and uses actual context/tool functions', async () => {
  const corpus = buildBlindCorpus([question]);
  assert.doesNotMatch(JSON.stringify(corpus.branch), /has_answer|answer_session_ids|ORACLE_SENTINEL|GOLD_METADATA/);
  const h = createBlindHarness([question]);
  const start = await h.start('blindq');
  assert.equal(start.question, question.question);
  assert.equal(start.questionDate, question.question_date);
  assert.deepEqual(start.tools.map(t=>t.name), ['history_recall','history_grep','history_expand']);
  const recall = await h.execute('history_recall', { query: question.question });
  assert.equal(start.automaticLocators[0], recall.content[0].text);
  assert.match((await h.execute('history_expand', { id: 'blindq:00000001', before: 0, after: 0 })).content[0].text, /quasar code is blue/);
  assert.equal((await h.execute('history_grep', { pattern: 'quasar' })).details.total, 2);
  for (const value of [start, recall]) assert.doesNotMatch(JSON.stringify(value), /ORACLE_SENTINEL|GOLD_METADATA|has_answer|answer_session_ids/);
  await assert.rejects(h.execute('history_expand', { id: 'blindq:00000001', before: -1 }));
  await assert.rejects(h.execute('other_tool', {}));
});
