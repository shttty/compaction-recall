export const stamp = '2026-09-30T00:00:00.000Z';
export const msg = (i, text, role = 'user') => ({ type: 'message', id: `m${i}`, parentId: null, timestamp: stamp,
  message: { role, content: [{ type: 'text', text }], timestamp: i } });
export const compact = (id, firstKeptEntryId) => ({ type: 'compaction', id, firstKeptEntryId, timestamp: stamp, summary: 'summary', tokensBefore: 100 });
export function corpus(n) {
  const topics = ['数据库 connectionPool retryBudget', 'cacheInvalidation 缓存更新', 'invoice ledger payment', '用户登录 session_manager', 'HTTPServer requestTimeout', 'nebula telescope observation'];
  return Array.from({ length: n }, (_, i) => msg(i,
    `Project common discussion record ${i}. ${topics[i % topics.length]}. module_${i % 137} ticket${i % 997}. ` +
    'Decided to inspect the original evidence and verify the configuration. 需要确认具体参数再继续处理。 ' +
    (i % 503 === 0 ? 'rareQuasar rarequasar milestone ' : '') +
    `Detail owner${i % 61} version${i % 29}; follow-up notes for this historical task.`,
    i % 13 === 0 ? 'toolResult' : i % 2 ? 'assistant' : 'user'));
}
export const queries = ['common', 'rarequasar', '数据库 retryBudget', 'session_manager ticket42', 'absentzzzz', 'nebula invoice'];
export function initialBranch(records) { return [...records, msg('live', 'live'), compact('c1', 'mlive')]; }
export function extendedBranch(records, added) { return [...records, compact('c1', added[0].id), ...added, msg('live2', 'live'), compact('c2', 'mlive2')]; }
