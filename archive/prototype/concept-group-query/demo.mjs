import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { documents } from '../structured-tool-query/demo.mjs';
import { analyzeQuery, compileQuery, createIndex, createTool } from './index.mjs';

export const examples = [
  { concepts: [['迁移', '升级'], ['SQLite'], ['备份', '回滚']], exclude: ['Android'] },
  { concepts: [['雪松'], ['迁移'], ['SQLite']], match: 'all' },
  { concepts: [['绿萝'], ['叶片发黄'], ['换土']] },
  { concepts: [['修改youer服务端配置'], ['HTTPServer', 'retry_delay']], match: 'all' },
  { concepts: [['共和国']] },
  { concepts: [['备份 OR 回滚']] },
  { concepts: [['say "hello"']] },
];
async function main() {
  const start = performance.now(), before = process.memoryUsage();
  const index = createIndex(documents), buildMs = performance.now() - start;
  const tool = createTool(index);
  try {
    const cases = [];
    for (const input of examples) {
      const began = performance.now();
      const result = await tool.execute('demo', input);
      cases.push({ input, compiled: compileQuery(input), result: result.details, toolMs: performance.now() - began });
    }
    console.log(JSON.stringify({ runtime: { node: process.version, sqlite: process.versions.sqlite },
      corpusSize: documents.length, buildMs, before, after: process.memoryUsage(),
      maxRSSKiB: process.resourceUsage().maxRSS,
      analysis: Object.fromEntries(['HTTPServer', 'retry_delay', '共和国', '中', 'C++', '雪松 中 C++', 'OR', 'say "hello"'].map(s => [s, analyzeQuery(s)])), cases,
    }, null, 2));
  } finally { index.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
