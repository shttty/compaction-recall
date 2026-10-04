import assert from 'node:assert/strict';
import test from 'node:test';
import { selectFts5Range, selectFts5Window } from '../benchmark/fts5-snippet.mjs';
import { createWorkerEngine } from '../benchmark/retrieval-sqlite-worker.mjs';
import { weightedLength } from '../prototype/soft-match-sqlite/index.mjs';

const body = snippet => snippet.replace(/^…|…$/gu, '');

test('weighted windows preserve whole targets and respect Han and astral boundaries', () => {
  const text = `${'甲'.repeat(150)}答案${'乙'.repeat(148)}`;
  const selected = selectFts5Window(text, [{ term: '答案', start: 150, end: 152 }], 240, { weighted: true });
  assert.ok(selected.snippet.includes('答案'));
  assert.equal(weightedLength(body(selected.snippet)), 240);
  assert.equal(Array.from(body(selected.snippet)).length, 120);
  assert.equal(selectFts5Range(Array.from('甲乙'), [], 1, { weighted: true }).end, 0);
  const astral = selectFts5Window('😀甲', [{ term: '😀', start: 0, end: 1 }], 1, { weighted: true });
  assert.equal(body(astral.snippet), '😀');
});

test('weighted coverage favors three English hits over a cluster outside the Han budget', () => {
  const mixedText = `${'甲'.repeat(600)}${'x'.repeat(600)}`;
  const hits = [50, 150, 250, 900, 980, 1060].map((start, i) => ({ term: `term${i}`, start, end: start + 1 }));
  const selected = selectFts5Range(Array.from(mixedText), hits, 240, { weighted: true, sentenceBonus: false });
  assert.deepEqual(hits.filter(hit => hit.start >= selected.start && hit.end <= selected.end).map(hit => hit.term), ['term3', 'term4', 'term5']);
  assert.equal(weightedLength(Array.from(mixedText).slice(selected.start, selected.end).join('')), 240);
});

test('actual SQLite auto and manual output default to 240 weighted units and accept explicit overrides', t => {
  const previous = process.env.COMPACTION_RECALL_SNIPPET_BUDGET;
  delete process.env.COMPACTION_RECALL_SNIPPET_BUDGET;
  t.after(() => { if (previous === undefined) delete process.env.COMPACTION_RECALL_SNIPPET_BUDGET; else process.env.COMPACTION_RECALL_SNIPPET_BUDGET = previous; });
  const fixtures = [
    { text: `${'left '.repeat(80)}NeedleID ${'right '.repeat(80)}`, query: 'NeedleID', target: 'NeedleID', points: 240 },
    { text: `${'甲'.repeat(150)}网关${'乙'.repeat(150)}`, query: '网关', target: '网关', points: 120 },
  ];
  for (const snippetBudget of [undefined, 80, 0, null]) {
    const worker = createWorkerEngine({ arm: 'off', snippetBudget });
    t.after(() => worker.dispose());
    for (const fixture of fixtures) {
      worker.commit([{ type: 'message', id: 'target', sourcePosition: 0, timestamp: '2026-10-04T12:00:00Z', message: { role: 'user', content: fixture.text } }], { eligibleCount: 1 });
      for (const mode of ['auto', 'manual']) {
        const result = worker.query(fixture.query, { mode });
        assert.deepEqual(result.results.map(row => row.id), ['target']);
        const snippet = body(result.results[0].snippet);
        assert.ok(snippet.includes(fixture.target));
        const budget = snippetBudget === 80 ? 80 : 240;
        assert.equal(weightedLength(snippet), budget);
        assert.equal(Array.from(snippet).length, fixture.points * budget / 240);
      }
    }
  }
});
