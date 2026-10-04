import assert from 'node:assert/strict';
import test from 'node:test';
import { selectFts5Range, selectFts5Window } from '../benchmark/fts5-snippet.mjs';

const weight = text => Array.from(text).reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0);

// These assertions describe the visible window, not the configuration plumbing.
test('explicit 240 weighted budget keeps 120 Han codepoints with the whole match', () => {
  const text = `${'甲'.repeat(150)}答案${'乙'.repeat(148)}`;
  const selected = selectFts5Window(text, [{ term: '答案', start: 150, end: 152 }], 240, { weighted: true });
  assert.deepEqual(selected, {
    start: 91, end: 211, score: 1000,
    snippet: `…${'甲'.repeat(59)}答案${'乙'.repeat(59)}…`,
  });
  assert.equal(weight(Array.from(text).slice(selected.start, selected.end).join('')), 240);
});

test('explicit 240 weighted budget keeps 240 English codepoints, rather than legacy 120', () => {
  const text = `${'a'.repeat(150)}needle${'b'.repeat(144)}`;
  const hits = [{ term: 'needle', start: 150, end: 156 }];
  assert.deepEqual(selectFts5Window(text, hits, 240, { weighted: true, sentenceBonus: false }), {
    start: 33, end: 273, score: 1000,
    snippet: `…${'a'.repeat(117)}needle${'b'.repeat(117)}…`,
  });
  assert.deepEqual(selectFts5Window(text, hits), {
    start: 93, end: 213, score: 1000,
    snippet: `…${'a'.repeat(57)}needle${'b'.repeat(57)}…`,
  });
});

test('mixed weighted centering rounds inward at Han boundaries and respects total weight', () => {
  const text = `${'甲'.repeat(80)}${'x'.repeat(240)}${'乙'.repeat(80)}`;
  const hits = [{ term: 'x', start: 190, end: 191 }];
  const selected = selectFts5Window(text, hits, 240, { weighted: true });
  assert.deepEqual(selected, {
    start: 76, end: 311, score: 1000,
    snippet: `…${'甲'.repeat(4)}${'x'.repeat(231)}…`,
  });
  assert.equal(weight(Array.from(text).slice(selected.start, selected.end).join('')), 239);
  assert.deepEqual(selectFts5Window(text, hits), {
    start: 131, end: 251, score: 1000, snippet: `…${'x'.repeat(120)}…`,
  });
});

test('weighted coverage selects the winning cluster before rendering, not a truncated old window', () => {
  const text = `${'甲'.repeat(600)}${'x'.repeat(600)}`;
  const hits = [50, 150, 250, 900, 980, 1060].map((start, i) => ({ term: `term${i}`, start, end: start + 1 }));
  const selected = selectFts5Range(Array.from(text), hits, 240, { weighted: true, sentenceBonus: false });
  assert.deepEqual(selected, { start: 861, end: 1101, score: 3000 });
  assert.deepEqual(hits.filter(hit => hit.start >= selected.start && hit.end <= selected.end).map(hit => hit.term), ['term3', 'term4', 'term5']);
  assert.equal(weight(Array.from(text).slice(selected.start, selected.end).join('')), 240);
});

test('one-unit budgets never split Han or astral characters', () => {
  assert.deepEqual(selectFts5Range(Array.from('甲乙'), [], 1, { weighted: true }), { start: 0, end: 0, score: 0 });
  assert.deepEqual(selectFts5Window('😀甲', [{ term: '😀', start: 0, end: 1 }], 1, { weighted: true }), {
    start: 0, end: 1, score: 1120, snippet: '😀…',
  });
});
