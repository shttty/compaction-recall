# SQLite FTS5 soft-match 原型

独立、可丢弃的匹配行为实验；生产 `src/` 不变。S1 在 `benchmark/` 接入独立评测适配层，不安装用户 profile。本方案是 **SQLite 原生 MATCH + BM25**，自动路径仍为 OR 精确词项，不是 MiniSearch 宽松匹配的等价替换，不作性能胜负结论。

## 运行与版本

仓库根目录执行，无需安装依赖：

```sh
node prototype/soft-match-sqlite/demo.mjs
node --test test/soft-match-sqlite.test.mjs
```

复现版本固定为本轮实际宿主：**Node v24.18.0 / ICU 78.3 / Unicode 17.0 / SQLite 3.53.1**，FTS5 已实测可用。npm 依赖为零，仅使用 Node 内置模块，因此没有 npm lockfile，也未修改根依赖。词典切分由该版本 ICU 决定；其他版本未经验证，不自动下载或更换宿主。

Demo 输出一份 JSON：运行版本、a–m 原文及分词、查询提取文本与加权长度、去重 queryTerms、skipped、全部候选数 total、命中 id/原始 BM25 分数及原文展开。两条命令在上述宿主均未观察到 SQLite 实验警告，未压制 stderr；其他 Node 版本若发出警告会原样显示。

## 接口与语义

`index.mjs` 导出：

- `tokenize(text): string[]`：保留全部词项和词频，不删除停用词。建索引直接使用；自动 search 查询端另行过滤英文停用词，再按首次出现顺序去重。显式 searchRaw 不调用 tokenize。
- `weightedLength(text): number`：按 Unicode 码点，Han 权重 2，其余权重 1，空格、标点、换行及 emoji 均计入。
- `extractText(content): string`：字符串原样返回；数组只提取字符串类型的 `text` 块，按原顺序以换行连接；图片和其他块忽略。
- `createIndex([{id, text}])`：输入使用唯一字符串 id 和字符串 text；返回 `search(query, {automatic=false, limit=20}={})`、`searchRaw(query, {limit}={})` 与 `close()`。search 的 query 可为字符串或消息 content 块数组；searchRaw 的 query 为原生 FTS5 MATCH 字符串；结束后调用 close。
- `search` 返回 `{skipped, total, results: [{id, score}], queryTerms}`。limit 为非负安全整数；`limit: 0` 仍返回真实 total。空查询、全英文停用词、单 Han 字无词项时正常返回空，不执行无效 MATCH。
- `searchRaw(query, {limit}={})` 返回 `{total, results:[{id,score}]}`。query 原样作为 `MATCH ?` 绑定参数，不分词、去停用词、拆双字、转义、截断或应用 210 门槛。默认完整排名；可选非负安全整数 limit 只取排名前缀，total 不变。同分按 id 排序，分页由调用方处理。FTS5 错误原样抛出，不改写消息；不把空串或错误转成零命中。

```js
import { createIndex } from './index.mjs';
const index = createIndex([{ id: 'a', text: '网关重启，中华人民共和国' }]);
try {
  console.log(index.searchRaw('网关 OR 重启'));
  console.log(index.searchRaw('共和国', { limit: 1 }));
} finally {
  index.close();
}
```

分词规则：

1. 每个连续 `\p{Script=Han}` 段生成相邻双字；不跨标点、中英边界或其他非 Han 字符。另对每段调用 `Intl.Segmenter('zh', {granularity:'word'})`，只接受 isWordLike、纯 Han、至少两个码点的词。
2. 两字词与同位置双字完全重合，只记一次；不同位置的重复仍计频次。按原文位置、短跨度优先排序，所有词共用命名空间。不加单字或滑动 trigram；ICU 确实产出的三字及更长词仍保留，例如本机的“共和国”。
3. `[A-Za-z0-9_]+` 为完整小写词项，包括一字符 ASCII 词；不拆 camelCase、不做内部子串、stemming 或前缀。两组英文停用词（常见功能词及 `please tell help about find show recall remember previous earlier history`）只在自动 search / searchAuto 查询端过滤，索引全部保留。集合仍为 `src/locator.mjs` 英文集合的同值副本，不使用生产 queryTerms/lex，不过滤中文停用词。
4. 自动查询先 extractText，再在分词、停用词过滤和去重前计长：**大于 210 整次跳过，等于 210 允许**；不截断后搜索。主动查询没有此闸，也不截断尾部。独立 image 块不计；已经拼入 text 的附件文字正常计入，块间连接的换行也计入。

## 内存索引

只有一个 `new DatabaseSync(':memory:')` 和一张主 FTS5 虚表：

```sql
CREATE VIRTUAL TABLE terms USING fts5(
  tokens, content='', columnsize=1, detail=full,
  tokenize="ascii tokenchars '_'"
);
```

预分词结果以 ASCII 空格连接。FTS5 的 ascii tokenizer 保留非 ASCII Han 词项，显式 tokenchars 保留下划线；已实测 `foo_bar`、`_`、扩展区 Han 和重复词频不会被拆坏。contentless 不存原文或完整预分词文本副本，保留倒排频次、位置及 BM25 所需文档长度元数据；JavaScript 仅保留 rowid → id 映射。原文由 demo 的输入文档持有，展开时按 id 查回。

`temp_store=MEMORY`；不生成数据库、WAL、SHM 文件。构建为一次事务，close 释放连接。没有持久化、增量更新或服务。

自动 search 将每个选出的 MATCH 词项双引号包裹、内部双引号转义，再用 OR 连接并绑定参数；显式 searchRaw 直接绑定调用方的完整表达式，支持 FTS5 原生操作符、短语和前缀语义。无命中比例门槛、fuzzy、trigram tokenizer 或 LIKE 补救。SQLite `bm25(terms)` 原始分数为负，**越小越优先**；JavaScript 按该分数排序，同分按字符串 id 的确定性顺序排序。取出全部候选再应用 limit，total 不是返回数量；此原型不优化海量候选的内存/排序开销。

## 实际验证

S0 合成 demo 曾通过 11/11 测试；S1 在同一宿主运行 demo 的 32 个案例、SQLite 专项 **15/15**、当前本原型 worktree 的 `npm run check` **154/154**、Python unittest **16/16**，全部通过。初次全套检查曾因另一原型缺少 minisearch 依赖失败；Hermes 最终在 90442db 删除本 worktree 的另一原型测试后重跑通过，未修改 SQLite 实现来绕过失败。

S1 v2 把停用词过滤移到自动查询端后，再跑同一 demo、SQLite 专项 **18/18**、`npm run check` **157/157**、Python unittest **16/16**，全部通过。三条新增回归覆盖带 where 的原生 AND/短语查询、两组英文停用词（含 history/find）都能显式检索、自动查询仍去停用词；210 门槛和中文规则不变。

a–m 共同样本的 S1 v1 实测结果，id 按当时 demo 排序；v2 保留停用词改变了 BM25 文档长度及分数，下面的历史分数不重标为 v2：

| 查询 | 命中 |
| --- | --- |
| 网关重启后为什么断连？ | a, b |
| 网关 | b, a；不含标点隔开的 c |
| 索引 | d；文档中两个不同位置的“索引”均保留频次 |
| youer | e |
| 修改youer服务端配置 | e, b（b 只共享“配置”） |
| GPU显存 | m |
| What time do I stop checking work emails and messages? | k，score = -7.8939042424680315；不存在的 time/messages 不阻断候选 |
| vm / kvm | 分别仅 g / h |
| compaction / CompactionResult | 分别无 / f |
| moto / motorcycle | 分别无 / l |
| gatway / gateway | 分别无 / j, i |
| gateway nonexistentword | j, i |
| 网关 不存在的词 | b, a |
| 单字网、空串、全英文停用词 | 正常空结果，skipped=false |

测试还验证：仅有“搜索引擎”的文档可由相邻双字“索引”命中，而“搜索，引擎”不可；多字词、同跨度去重、重复词频影响 BM25、长度归一化、下划线和单字符 ASCII 整词、MATCH/SQL 外观输入、安全空词项、同分 id 顺序及真实 total。

ASCII / Han / 混合输入均覆盖 210 边界：ASCII、混合 211 跳过，纯 Han 下一个长度 212 跳过；附加覆盖停用词/重复词去重前计数、非 BMP Han、emoji、独立图片排除、附件 text 210/211（包括连接换行），以及超过 210 且命中词在尾部的主动查询。`gateway` 配合 `limit:1` 的 demo 返回 1 条但 total=2。

S1 显式入口实测（文档 a=`网关重启，中华人民共和国 Gateway`，b=`网关 Gateway`）：`网关 OR 重启` → a,b；`共和国` → a；`GATEWAY` → b,a，与小写原生大小写语义一致。未配对引号 `"gateway` 原样报 `unterminated string`；空串原样报 `fts5: syntax error near ""`，均为 `ERR_SQLITE_ERROR`。新增测试还覆盖默认完整 25 条排名、同分 id 顺序、limit=0/1、超过 210 的显式查询，以及 raw 调用前后原有 search 结果不变。

## S1 v1 授权评测结果（2026-10-03）

运行根目录：`/home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/sqlite/`。完整逐题排名、指标、构建/检索延迟和内存记录在 `group1.json`；32 个中英文案例校验通过。以下每格三项按 K=5/10/20，宏平均，语言分开报告：

| 语言 | MRR | nDCG | Recall | Precision | top5 命中题 / gold 条数 |
| --- | --- | --- | --- | --- | --- |
| en | 0.561401 | 0.506250 / 0.512515 / 0.534041 | 0.547917 / 0.568750 / 0.618750 | 0.200000 / 0.112500 / 0.068750 | 12/16；16/50 |
| zh | 0.514165 | 0.450422 / 0.465655 / 0.503268 | 0.505208 / 0.540625 / 0.630208 | 0.162500 / 0.100000 / 0.071875 | 11/16；13/50 |

构建 / 搜索中位数：en 203.815 / 1.955 ms，zh 1238.929 / 1.552 ms。进程整体 peak RSS 597412 KiB，不是逐题隔离峰值，不与相关性指标合并。

假 provider 的真实 SDK 链路通过，记录在 `sdk-smoke/`：自动提示进入 provider、limit=1 翻页一次、原生 FTS5 错误送达 provider、3 次 recall trace query 一致；MRR=1，Recall@5/10/20=1，错误数=1（有意的语法错误）。

真实试跑仅 dev8/3d86fd0a 中英各一次，gpt-6-luna/high，独立保存在 `trial-3d86fd0a/`，不计入正式第 2 组结果：en 调 recall/grep/expand 各一次，recall 原文 `Sophia coffee shop city where met`，原生隐式 AND 返回零命中，trace 两侧 query 一致；MRR/nDCG=0，Recall@5/10/20=1（自动结果命中）。zh 仅 expand 一次，无 recall，因此使用自动排名：MRR/nDCG/Recall=1。两边实际 provider 请求均包含自动提示、reasoning effort high，会话也记录 thinking_level_change=high。核验摘录在 `trial-3d86fd0a-checks.json`；不记录或读取 profile 内容。未运行其余真实会话或 judge。

## S1 v2 查询端停用词过滤（2026-10-03）

旧结果和包均未覆盖。v2 产物仍在同一运行根目录：`adapter-package-v2/`（18 个只读文件）、`sdk-smoke-v2/`、`group1-v2.json`、`comparison-v2.json`、`raw-probe-v2.json`；验收日志为 `acceptance1-*-v2.{stdout,stderr}.log`。新包重新加载实际 SDK，自动提示、翻页、原生错误、trace 和指标链路全部通过；3 次 recall，query mismatch=0，1 次有意的 FTS5 错误。v2 未调用真实模型。

第 1 组完整重跑 16 题 × 中英，宏平均对比：

| 语言 | MRR v1 → v2 | ΔMRR | top5 命中题 v1 → v2 |
| --- | --- | --- | --- |
| en | 0.561401216 → 0.563833047 | +0.002431831 | 12/16 → 12/16 |
| zh | 0.514164976 → 0.514164976 | 0 | 11/16 → 11/16 |

32 个自动查询的候选 id 集合全部与 v1 相同，但完整排名均有变化。按首个 gold 的绝对排名变化，最大四项均为英文：hard8/gpt4_731e37d7 45→57；hard8/2ce6a0f2 73→83；hard8/gpt4_15e38248 5→4；hard8/9d25d4e0 14→15。中文首个 gold 排名全部不变。按任意候选最大位移，英文 hard8/2ce6a0f2 为 231 位、hard8/gpt4_7fce9456 为 215 位、hard8/9d25d4e0 为 192 位；这不是 gold 位移。

直接加载 v2 包中的引擎，输入只含 dev8/3d86fd0a 英文 documents；gold 仅用于结果核验。原样调用 `searchRaw('Sophia coffee shop city where met')`，原生隐式 AND 返回 total=1：`3d86fd0a:0000051f`，BM25=-37.56001277756897，唯一 gold 排名=1。未拆词、补 OR 或调用模型；v1 索引删除 where 导致旧试跑零命中，此探测证明保留停用词修复了该查询。详见 raw-probe-v2.json。

## S1 评测适配层

`benchmark/retrieval-sqlite-engine.mjs` 导出 S0 `createEngine(documents)`：searchAuto 用现有 search 且保留完整排名；searchRaw 用显式入口；dispose 关闭内存数据库。适配层入口为 `benchmark/retrieval-sqlite-adapter.ts`，只用于评测，不注册生产入口。

自动提示复用生产 `formatLocatorRows` / `withLocators`，前五条及生产预算；显式查询复用 `recallPageFromRows`，完整排名后按 limit/offset 分页，每页 16000 码点。grep/expand 复用生产执行函数，只替换冻结的描述和参数说明；不启动生产 worker。

片段定位仅影响显示：生产 lex(query) 提供显示定位词，选择原文中最早的不区分大小写字面出现位置，最多取其前 40 码点、窗口共 120 码点，首尾可附省略号；找不到则从正文开头取窗。不解析 FTS 表达式或选择最稀有词；不改 MATCH 输入或排序。每次操作重取当前分支投影；id/text 改变时整库重建，无持久索引。

打包命令（输出目录必须新建且位于本轮授权输出根目录）：

```sh
node benchmark/retrieval-sqlite-package.mjs --output /home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/sqlite/adapter-package
```

包包含源依赖闭包、内置 SQLite 引擎和许可证，每个文件只读，manifest 只有一个 pi.extensions 入口。SDK/typebox 由宿主提供，无额外 npm 引擎依赖。runner 用法以 `benchmark/RETRIEVAL_CONTRACT.md` 为准，外部 config/profile 仅交给 runner，不复制凭据。trace 复用生产 history_recall 事件；另记 trace 开启时实际 provider payload 中本适配层提示的存在性及可识别的 reasoning effort，不记录完整请求或思考。

## 确定的限制

- 这是词面召回，不理解语义或短语约束。OR 会保留仅命中少量词的候选；上述“重启断连”查询中的 b、“修改youer…”中的 b 均非相关事实证据。双字还可能跨词边界形成偶然命中，例如“搜索引擎”中的“索引”。
- 自动查询不补救错字、英文前缀/内部子串及单 Han 字；不能由 gatway 推出 gateway，也不能由 compaction/moto 推出完整标识符/单词。显式入口可由调用方使用原生 FTS5 前缀语法，但不会自动补写。无结果不代表历史没有相关语义。
- 同时索引双字与词语会影响 BM25 的词频和文档长度；分数不是概率，不应与另一引擎直接比较。ICU 升级可能改变多字词和排名。
- 仅 16 题机械评测和 v1 一个题目的中英真实单次试跑；v2 只做离线评测及直接引擎探测。未运行大规模性能矩阵或正式第 2 组其余题目，不给波动范围或跨引擎结论。FTS5 空格连接词项默认 AND，必须每个词项都存在；v2 修复索引删除停用词的问题，不放宽原生语义。片段窗口不保证展示最相关证据，应 expand 核实。
