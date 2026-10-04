// Deterministic worker-only fixture: exercises raw objects, async commits and native errors.
import { isMainThread } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
export function createWorkerEngine() {
  if (isMainThread) throw new Error('Fixture engine must run in worker');
  let entries = [];
  return {
    prepareEntry(entry) { return entry; },
    async commit(next, { eligibleCount }) {
      await new Promise(resolve => setImmediate(resolve));
      entries = next.filter(entry => entry.sourcePosition < eligibleCount && entry.message.content);
      if (entries.some(entry => entry.message.content === 'commit-error')) throw new SyntaxError('synthetic commit 原文');
      return { documents: entries.length };
    },
    async query(query, { mode }) {
      if (query === 'syntax-error') throw new SyntaxError('synthetic MATCH 原文: "unterminated');
      const text = typeof query === 'string' ? query : query.term;
      const results = entries.filter(entry => entry.message.content.includes(text)).slice().reverse().map((entry, index) => ({
        id: entry.id, date: entry.timestamp.slice(0, 10), role: entry.message.role,
        snippet: Array.from(entry.message.content).slice(0, 120).join(''), score: 10 - index,
      }));
      return { total: results.length, results };
    },
    async dispose() {
      await new Promise(resolve => setTimeout(resolve, 10));
      const destination = entries.find(entry => entry.message.content.startsWith('dispose-file:'));
      if (destination) writeFileSync(destination.message.content.slice('dispose-file:'.length), 'disposed');
    },
  };
}
