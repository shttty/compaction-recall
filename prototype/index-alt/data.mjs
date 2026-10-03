import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { estimateTokens, findCutPoint } from '@earendil-works/pi-coding-agent';
export const sha = value => createHash('sha256').update(value).digest('hex');
// Same bounded-record stream and SDK sizing rules as benchmark-scaling.mjs.
export async function extract(file, id = '577d4d32') {
  let depth = 0, quoted = false, escaped = false, pieces = [], recordIndex = 0;
  for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 65536 })) {
    let start = depth ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"' && depth) quoted = true;
      else if (ch === '{') { if (!depth) start = i; depth++; }
      else if (ch === '}' && !--depth) {
        pieces.push(chunk.slice(start, i + 1));
        const raw = pieces.join(''), record = JSON.parse(raw); recordIndex++;
        if (record.question_id === id) return { record, recordIndex, recordSha256: sha(raw) };
        pieces = []; start = -1;
      }
    }
    if (start >= 0) pieces.push(chunk.slice(start));
  }
  throw new Error('Question not found');
}
function message(raw, timestamp) {
  assert.ok(['user', 'assistant'].includes(raw.role)); assert.equal(typeof raw.content, 'string');
  if (raw.role === 'user') return { role: 'user', content: raw.content, timestamp };
  return {
    role: 'assistant', content: [{ type: 'text', text: raw.content }], timestamp,
    api: 'openai-completions', provider: 'offline', model: 'offline-history', stopReason: 'stop',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  };
}
function entry(msg, i) {
  return {
    type: 'message', id: `history-${String(i).padStart(6, '0')}`,
    parentId: i ? `history-${String(i - 1).padStart(6, '0')}` : null,
    timestamp: new Date(msg.timestamp).toISOString(), message: msg
  };
}
export function fixture(record, target) {
  const sessions = record.haystack_sessions.map((s, si) => s.map((m, mi) => message(m, Date.UTC(2023, 0, 1) + si * 86400000 + mi)));
  const tokens = sessions.map(s => s.reduce((n, m) => n + estimateTokens(m), 0));
  let count = 0, actualTokens = 0;
  while (count < sessions.length && actualTokens + tokens[count] <= target) actualTokens += tokens[count++];
  assert.ok(count > 1 && count < sessions.length);
  const messages = sessions.slice(0, count).flat(), originalCount = messages.length;
  const additions = [];
  for (const s of sessions.slice(count)) {
    for (let i = 0; i + 1 < s.length && additions.length < 20; i++) {
      if (s[i].role === 'user' && s[i + 1].role === 'assistant') additions.push(s[i], s[++i]);
    }
    if (additions.length === 20) break;
  }
  assert.equal(additions.length, 20);
  const entries = [...messages, ...additions].map(entry);
  const firstKept = findCutPoint(entries, 0, originalCount, 20000).firstKeptEntryIndex;
  const nextKept = findCutPoint(entries, 0, entries.length, 20000).firstKeptEntryIndex;
  const retainedTokens = messages.slice(firstKept).reduce((n, m) => n + estimateTokens(m), 0);
  const text = m => m.role === 'user' ? m.content : m.content[0].text;
  return {
    entries, originalCount, firstKept, nextKept,
    queries: [record.question, 'checking', 'go', 'id', '北京', 'HTTP HTTPServer', '中文 检索', 'xyzzynotpresent'],
    stats: {
      targetTokens: target, actualTokens, sessions: count, originalCount, compactedEntries: firstKept,
      retainedTokens, compactedTokens: actualTokens - retainedTokens,
      charactersUtf16: messages.reduce((n, m) => n + text(m).length, 0),
      addedEntries: 20, addedTokens: additions.reduce((n, m) => n + estimateTokens(m), 0),
      nextCompactedEntries: nextKept, querySha256: sha(record.question)
    }
  };
}
export function semanticFixture() {
  const texts = [
    'prefix '.repeat(13) + 'fooBar HTTPServer alpha_beta checking 中文检索 北京大学 go id' + ' suffix'.repeat(25),
    'A foobar has HTTPServer and go while said provides identity and ongoing work. 北京街道 中文例子',
    'foo fooBar 北京 大学 中文 检索',
    'A text with _private$id and HTTPServer and Checking. 𠀀𠀁𠀂 mixed Han.',
    '网关',
    '网，关',
    '搜索引擎',
    'CompactionResult',
    'compaction',
    'kvm',
    'vm',
    '修改youer服务端',
    'retained context', 'new live fooBar checking go 北京', 'another retained message',
  ];
  const entries = texts.map((content, i) => entry(message({ role: 'user', content }, Date.UTC(2023, 0, 1) + i), i));
  const originalCount = texts.length - 2, firstKept = originalCount - 1, nextKept = originalCount + 1;
  // Hit IDs are sets, not BM25 order; primary IDs must precede substring-only IDs.
  const semanticCases = [
    { query: 'foo foobar', hits: [0, 1, 2], addedHits: [originalCount], primary: [2] },
    { query: 'HTTP HTTPServer', hits: [0, 1, 3], primary: [] },
    { query: 'go', hits: [0, 1], addedHits: [originalCount] },
    { query: 'id', hits: [0, 3] },
    { query: '北京', hits: [0, 1, 2], addedHits: [originalCount] },
    { query: '中文 检索', hits: [0, 2] },
    { query: '_private$id', hits: [3] },
    { query: '𠀀𠀁', hits: [3] },
    { query: '网', hits: [4, 5] },
    { query: '网关', hits: [4] },
    { query: '索引', hits: [6] },
    { query: 'compaction', hits: [7, 8], primary: [8] },
    { query: 'vm', hits: [10] },
    { query: 'youer', hits: [11] },
  ].map(({ query, hits, addedHits = [], primary = hits }) => ({
    query,
    expectedB3HitIds: hits.map(i => entries[i].id),
    expectedB3PrimaryHitIds: primary.map(i => entries[i].id),
    expectedB3IncrementalHitIds: [...hits, ...addedHits].map(i => entries[i].id),
  }));
  return {
    entries, originalCount, firstKept, nextKept,
    queries: semanticCases.map(({ query }) => query),
    semanticCases,
    stats: { targetTokens: 'semantic', actualTokens: 0, originalCount, compactedEntries: firstKept, nextCompactedEntries: nextKept, addedEntries: 2 }
  };
}
