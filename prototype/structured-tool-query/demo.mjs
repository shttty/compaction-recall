import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { compileQuery, createIndex, createTool } from './index.mjs';

// Independent synthetic notes; no benchmark histories, questions or gold answers.
export const documents = [
  { id: 'cedar-migrate', text: '雪松项目迁移 SQLite 数据库，周五先做备份，再核验回滚步骤。' },
  { id: 'cedar-upgrade', text: '雪松项目升级 SQLite，演练备份与回滚；操作窗口在周六。' },
  { id: 'cedar-android', text: '雪松项目 Android 迁移 SQLite，备份缓存后回滚。' },
  { id: 'cedar-postgres', text: '雪松项目迁移 PostgreSQL，已经备份，暂不使用 SQLite。' },
  { id: 'birch-migrate', text: '白桦项目迁移 SQLite，备份由值班同事负责。' },
  { id: 'cedar-plain', text: '雪松项目迁移文件目录，不涉及数据库。' },
  { id: 'cedar-pause', text: '雪松项目暂停升级，评审会上讨论了回滚风险。' },
  { id: 'gateway-retry', text: '网关重启后断连，调整 HTTPServer 的 retry_delay，服务端配置已经同步。' },
  { id: 'gateway-timeout', text: '网关超时需要观察，修改 youer 服务端配置，暂时保留 CompactionResult。' },
  { id: 'identifier-mixed', text: '修改youer服务端配置后，将 HTTPServer 的 retry_delay 设置为 42。' },
  { id: 'identifier-separated', text: 'HTTP server 文档介绍 retry delay；不要把这两个词当作完整标识的原文证据。' },
  { id: 'garden', text: '阳台绿萝叶片发黄，浇水改为每周一次，避免积水。' },
  { id: 'garden-soil', text: '阳台绿萝换土需要透气，叶片状态再观察两周。' },
  { id: 'long-han', text: '中华人民共和国资料卡记录整理规则。' },
  { id: 'split-han', text: '共和，和国是两段拆开的示例，不是连续长词。' },
  { id: 'literal-operator', text: '标签文字是备份 OR 回滚，界面还显示 say "hello"。' },
];

export const examples = [
  { must: [{ any_of: ['迁移', '升级'] }], prefer: [{ any_of: ['SQLite'] }, { any_of: ['备份', '回滚'] }], exclude: ['Android'], limit: 20 },
  { prefer: [{ any_of: ['绿萝'] }, { any_of: ['叶片发黄'] }] },
  { must: [{ any_of: ['修改youer服务端配置'] }], prefer: [{ any_of: ['HTTPServer', 'retry_delay'] }] },
  { must: [{ any_of: ['中华人民共和国'] }] },
  { must: [{ any_of: ['备份 OR 回滚'] }] },
  { must: [{ any_of: ['say "hello"'] }] },
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
    console.log(JSON.stringify({
      runtime: { node: process.version, sqlite: process.versions.sqlite },
      corpusSize: documents.length, buildMs, before, after: process.memoryUsage(),
      maxRSSKiB: process.resourceUsage().maxRSS, cases,
    }, null, 2));
  } finally { index.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
