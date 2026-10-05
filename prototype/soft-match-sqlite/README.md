# SQLite FTS5 soft-match 原型

## 当前覆盖契约：literal 概念组手动查询（2026-10-05）

本节优先于下文历史接口、切词、候选 arm 和提示词说明。历史评估数字及验证正文保持原文，不代表本轮已重跑。本轮为 SQLite 原型 / benchmark 接入，不是生产发布；不请求 provider 或模型评测。共享 `src/recall-trace.mjs` 仅增加可选结构输入模式，`src/index-worker.mjs` / `src/background-index.mjs` 仅保留自定义引擎错误 code；生产入口、schema、默认字符串 trace 及输出字节契约不变。

- **工具具名字段**：`history_recall({concepts:string[][],match?:'any'|'all',exclude?:string[],limit?,offset?})`。1..5 组，每组 1..4 个替代词面；默认 `any` 组间 OR，`all` 要求各组在同一索引记录命中。组内词面是 OR 替代，每个词面的分析路径外 OR、路径内词项 AND：只要求共现，不要求顺序、相邻或 phrase。词面是 literal 数据，不是 FTS / SQL / 任意 AST；不要求模型手切双字或写原生 MATCH。旧 `query` / `must` / `prefer` / raw 手动入口不兼容。
- **严格作者编译器**：纯 JS `concept-query-compiler.mjs` 由未修改作者 TypeScript 源码经 Node builtin `stripTypeScriptTypes` 生成，导出 `parseQuery` / `compileFts5` / `QueryError` / `LIMITS`；worker 不加载 TypeScript。参数只剥离 `limit` / `offset`，其他未知键保留给 strict compiler 拒绝。词面 trim 后非空，每个最多 256 Unicode 码点、全部最多 2048；拒绝非法控制字符和孤立 surrogate，不截断。分析最多每词面 4 路径、每路径 16 原子、每原子 4096 码点、累计 256 原子、编译 MATCH 32768 UTF-16 单位；无可搜索词项报 `EMPTY_ANALYSIS`。原始校验、限额和语义不改，MATCH 仍绑定 SQL 参数。
- **排除与分析**：`exclude` 最多 5 个 literal 词面，任意一个命中就硬排除整条记录，不是排名降权；过宽排除可能隐藏相关证据。查询使用真实基础 tokenizer，过滤 U+E000 位置屏障；`lemma-index` 对齐既有文档 normalize，其余不追加查询词干扩展。现有 arm / stems / jieba 默认及算法不变。snippetTerms 仅来自正向 concepts，不采 exclude。
- **自动与排名不变**：仅内部 `mode='auto'|'manual'` 分流。auto 仍接受自然语言、机器选词及默认 210 / 配置覆盖加权门槛，gate / cadence / lifecycle 不变；manual 接概念对象，无自动 gate。默认原生 BM25、全文去重、时间 tie-break 及 SQL 页序不变，不新增排名算法。
- **分页与错误**：`SQLiteBackgroundIndex.queryPage(queryObject,branch,{limit?,offset?})` 返回 `{total,page,ids}`。默认 / 最大 50 条、16000 码点页预算、默认 240 加权 snippet 单位（Han 2 / 其他 1）、nextOffset 和超长元数据进度例外不变。真实 `total===0` 才提示检查概念分组、any/all 和词面；正 total 的 offset 空页不误报。`QueryError` 的 name / code / message 经 worker 保留，native Error / code 保留；错误后健康 worker 不清缓存、不回退。原 cooperative deadline 不变。
- **工具顺序与 trace**：自动 locator → history_recall → history_expand 核验；证据不足再 history_grep。正常 trace 保存完整原始 params 和完整 model.arguments。SQLite 使用 `inputFields:['concepts','match','exclude']`，生成 `execute.input` / `input_identical`，固定字段键序比较而保留数组顺序，不假称 query 改写；错误为 `{name,code,message}`。生产默认仍 `execute.query` / `query_identical` / 字符串 error；trace off 不新增行为。不记录 thinking 或 provider credentials。

后文 `searchRaw`、implicit OR、原生手写 MATCH、自动 Porter/长 Han、mixed index 等接口和说明均为历史设计 / 评估证据，不覆盖本节当前手动概念组协议。

独立、可丢弃的匹配行为实验；生产 `src/` 不变。S1 在 `benchmark/` 接入独立评测适配层，不安装用户 profile。默认 `off` 是 **SQLite 原生 MATCH + BM25**，自动路径仍为 OR 精确词项，不是 MiniSearch 宽松匹配的等价替换。S6 候选仅在评测入口显式启用，见文末。

2026-10-05 经凛音同意，**英文 v8 已应用 SQLite 原型适配层**，用于 RSM-SQLITE-V8-JSFAST-20261005 端到端对比；[完整描述、参数与逐句依据](../../doc/SOFT_MATCH_PROMPTS_V9.md)。正式 `src/recall-extension.ts`、冻结 `doc/SOFT_MATCH_PROMPTS.md` 和历史 benchmark 结果不改。应用描述不是已运行模型评测的声明。

## 运行与版本

仓库根目录执行。默认 off 的 demo 只用内置模块；运行 jieba、porter-jieba、porter-js、inflect-wink 或 lemma-index 候选前先执行 `npm ci --ignore-scripts`：

```sh
node prototype/soft-match-sqlite/demo.mjs
node --test test/soft-match-sqlite.test.mjs
```

本轮实际宿主：**Node v24.18.0 / ICU 78.3 / Unicode 17.0 / SQLite 3.53.1**，FTS5 已实测可用。默认 off 不调用第三方依赖；S6 锁定运行时依赖 `@node-rs/jieba@2.0.3`、`@orama/stemmers@3.1.18`、`wink-lemmatizer@3.0.4`，声明在根 package.json dependencies 与 package-lock.json。默认词典切分仍由 ICU 决定，不自动更换宿主。

Demo 输出一份 JSON：运行版本、a–m 原文及分词、查询提取文本与加权长度、去重 queryTerms、skipped、全部候选数 total、命中 id/原始 BM25 分数及原文展开。两条命令在上述宿主均未观察到 SQLite 实验警告，未压制 stderr；其他 Node 版本若发出警告会原样显示。

## 接口与语义

本节描述默认 off；所有候选默认关闭，不能叠加。

`index.mjs` 导出：

- `tokenize(text): string[]` / `tokenizeSpans(text)`：建索引不删除停用词；英文整词及组件词按主线 lex 规则、长度 ≥2。自动 query 再过滤完整 STOPWORDS（含中文），按首次出现顺序去重；显式 MATCH 不改写为分词串。spans 为原文码点左闭右开位置。
- `weightedLength(text): number`：按 Unicode 码点，Han 权重 2，其余权重 1，空格、标点、换行及 emoji 均计入。
- `extractText(content): string`：字符串原样返回；数组只提取字符串类型的 `text` 块，按原顺序以换行连接；图片和其他块忽略。
- `implicitOr(query): string`：无状态纯函数，把 FTS5 操作数之间的隐式 AND 连接改为 OR；显式操作符及其分组保留。相同原始 query 得到相同 MATCH 字符串，供执行及事后复算使用，详见 v4 规则。
- `createIndex([{id,text,sourcePosition?,timestamp?,date?,role?}], {arm='off',autoGate=210,snippetBudget=240,timer}={})`：最新同 id 覆盖旧正文，空正文排除；所有 snippetBudget 都是 Han 2 / 其他码点 1 的加权单位，无 legacy 默认分支。SQL 按完整正文规范化空白后的 SHA-256 分组；组内取 BM25 最优，同分按 timestamp、原位置、rowid 倒序，最终按同一分数/时间顺序分页。无 bounds 的 queryRows 保留完整排名；queryPage 的 SQL LIMIT/OFFSET 只取当前页并用 count(DISTINCT content_hash) 返回真实 total。stats() 返回数据库页数、页大小及逻辑字节数，只在主动测量时调用。
- `search` 返回 `{skipped, total, results: [{id, score}], queryTerms}`。limit 为非负安全整数；`limit: 0` 仍返回真实 total。空查询、全英文停用词、单 Han 字无词项时正常返回空，不执行无效 MATCH。
- `searchRaw(query, {limit}={})`：沿用完整 MATCH 重写、不截断输入。SQL 按消息内容哈希去重，按 BM25/时间排序，再取 limit；不再按相同查询片段去重或用命中不同词数排序。结果只投影 id/score；工具页投影 id/date/role/snippet。

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

1. 每个连续 `\p{Script=Han}` 段生成相邻双字；不跨标点、中英边界或其他非 Han 字符。另对每段调用 `Intl.Segmenter('zh', {granularity:'word'})`，只接受 isWordLike、纯 Han、至少三个码点的词。
2. 两字词与同位置双字完全重合，只记一次；不同位置的重复仍计频次。按原文位置、短跨度优先排序，所有词共用命名空间。不加单字或滑动 trigram；ICU 确实产出的三字及更长词仍保留，例如本机的“共和国”。
3. 非汉字分支同主线 `[A-Za-z0-9_$]+`：整词小写且长度 ≥2；驼峰、缩写边界和 `_`/`$` 组件也索引（长度 ≥2、不等于整词）。完整 STOPWORDS 是 `ec16440:src/locator.mjs` 值拷贝，含中文；只过滤自动 query，不过滤索引。长度规则仍会淘汰单字母、单个数字，不能把这归因于停用词。
4. 自动查询先 extractText，再在分词、停用词过滤和去重前计长：**大于 autoGate 整次跳过，等于门槛允许**，默认 210；不截断后搜索。主动查询没有此闸，也不截断尾部。独立 image 块不计；已经拼入 text 的附件文字正常计入，块间连接的换行也计入。

## 内存索引

默认 off 只有一个 `new DatabaseSync(':memory:')` 和一张主 FTS5 虚表：

```sql
CREATE VIRTUAL TABLE terms USING fts5(
  tokens, content='', columnsize=1, detail=full,
  tokenize="ascii tokenchars '_$'"
);
```

预分词结果以 ASCII 空格连接。FTS5 的 ascii tokenizer 保留非 ASCII Han 词项，tokenchars 保留 `_` / `$`。contentless 不存原文或完整预分词文本副本，保留倒排频次、位置及 BM25 所需文档长度元数据；JavaScript 保留 id/date/role/recency 及原文引用，查询时惰性缓存词项跨度和 document.chars 码点数组，展开仍按 id 查回。

`temp_store=MEMORY`；不生成数据库、WAL、SHM 文件。构建为一次事务，close 释放连接。没有持久化、增量更新或服务。

自动 search 将选出的 MATCH 词项双引号包裹、内部双引号转义，再用 OR 连接并绑定参数；searchRaw 只改写原生隐式连接，支持显式操作符、短语和前缀。没有 fuzzy、trigram 或 LIKE 补救。SQL 先按规范化全文哈希分组并取 BM25 最佳代表，同分按时间/原位置/rowid 倒序，再按分数/时间排序并 LIMIT/OFFSET；total 是 distinct 内容组数，不是本页行数。snippet 仅在所选行展示时生成，窗口不参与去重。

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

## S1 提示词 v3

`history_recall` 的评测描述与 `doc/SOFT_MATCH_PROMPTS.md` ① 冻结 v3 一致，新增「空格=AND，要 OR 就写 OR。」；参数说明、查询及排序行为不变。SQLite 专项测试通过真实 SDK 加载适配层，比较注册工具描述与文档代码块正文的 UTF-8 字节，防止两边分叉，不扫描适配层源字符串。

本次 SQLite 专项 **19/19**、`npm run check` **158/158** 通过。新只读包为 `adapter-package-v3/`；离线实际 SDK 自动提示、翻页、原生错误和 trace 链路通过，记录在 `sdk-smoke-prompt-v3/`。真实运行须先满足包源文件与当前 HEAD 逐文件一致的前置条件；旧 `group2-formal/` 保留为 v2 对照。

## S1 v4：显式查询的隐式 OR

只改变 searchRaw；search / searchAuto 的选词、查询端停用词、210 门槛、索引和第 1 组均不变。适配层描述与冻结 v4 ① 一致：「query = FTS5 MATCH 语法。」和「空格=OR。」；现有 SDK 加载后的描述逐字节契约测试继续使用文档作为依据。

依据 [SQLite FTS5 原生语法](https://www.sqlite.org/fts5.html#fts5_boolean_operators)：隐式连接发生在相邻短语或 NEAR 组之间（包括列过滤、前缀和初始词约束），且原本比显式 NOT/AND/OR 结合更紧。implicitOr 保留这些隐式组的边界，用括号维持显式操作符的作用范围；只插入 OR 和必要的分组括号，不重写原有字符或空白。

| 原始 query | 实际 MATCH |
| --- | --- |
| `alpha beta gamma` | `(alpha OR beta OR gamma)` |
| `网关 Gateway 重启` | `(网关 OR Gateway OR 重启)` |
| `alpha OR beta` | `alpha OR beta` |
| `alpha AND beta gamma` | `alpha AND (beta OR gamma)` |
| `alpha NOT beta gamma` | `alpha NOT (beta OR gamma)` |
| `"alpha beta" gamma` | `("alpha beta" OR gamma)` |
| `alpha + beta gamma` | `(alpha + beta OR gamma)` |
| `(alpha beta) AND gamma` | `((alpha OR beta)) AND gamma` |
| `NEAR(alpha beta, 0) gamma` | `(NEAR(alpha beta, 0) OR gamma)` |
| `tokens:^alp* beta` | `(tokens:^alp* OR beta)` |
| `tokens:(alpha beta)` | `tokens:((alpha OR beta))` |

NEAR 内部的短语分隔、双引号内空格与 `""` 转义、`+` 拼接、列名/列集合/负列过滤、`*` 和 `^` 保留。普通括号表达式前后原本不支持隐式连接，例如 `(alpha OR beta) gamma` 仍报语法错误，不帮调用方修复。按实测 native lexer，分隔空白为普通空格、tab、CR、LF；NBSP 属于原生 bareword 的非 ASCII 字符，不把它当分隔符，FF/VT 的原生错误不吞掉。

空串和全空白仍由 SQLite 报错。不配对引号不改写，保持原始 `unterminated string`。其他非法输入的实际诊断取自执行的改写式：回归包含非法短语拼接 `alpha beta + ^gamma` → `(alpha OR beta) + ^gamma`，原式已非法，改写后可能报不同的位置；直接比较执行改写式的 SQLite 原生错误，确保不改写其消息。不会故意把合法原式改坏来制造语法错误。

v4 离线验收：SQLite 专项 **25/25**、`npm run check` 类型检查及 **164/164**、Python unittest **16/16** 全部通过。实际 Node/SQLite 引擎 smoke 中 `alpha beta` 改成 `(alpha OR beta)` 命中 5 条，显式 `alpha AND beta` 仍命中 2 条；上述非法拼接原式报 `fts5: syntax error near "^"`，实际改写式原样报 `fts5: syntax error near "+"`。另与冻结 v3 包对照 10 个合成自动查询（含中英、停用词、非法 MATCH 外观及 210/211 边界），完整 id/score 排名逐字相同。日志为运行根目录 `acceptance-prompt-v4-*`，smoke 为 `implicit-or-smoke-v4.json`；本阶段未打包或调用真实模型。

trace 两侧仍保存模型/工具收到的原始 query；实际 MATCH 可用本次只读包内 `prototype/soft-match-sqlite/index.mjs` 导出的 implicitOr 逐次复算，不把改写式写回工具参数。这是 v4 对 S0/v2/v3「原样 MATCH」规则的明确覆盖，其余接口及生产渲染不变。代码和离线验证完成后先交 Hermes 复验提交；提交后才打 v4 包、核对 HEAD 并运行授权的 32 个真实会话。

## S1 评测适配层

`benchmark/retrieval-sqlite-engine.mjs` 导出 S0 `createEngine(documents)`：searchAuto 用现有 search 且保留完整排名；searchRaw 用显式入口；dispose 关闭内存数据库。适配层入口为 `benchmark/retrieval-sqlite-adapter.ts`，只用于评测，不注册生产入口。

适配层使用 `benchmark/sqlite-background-index.mjs` 的 `SQLiteBackgroundIndex`，继承公共 `BackgroundIndex` 的分批传输、分支代次与生命周期；原生 JavaScript `src/index-worker.mjs` 继续运行在现有 Worker 线程，引擎仍为 `benchmark/retrieval-sqlite-worker.mjs` 的 `createWorkerEngine()`。主线程收集当前分支投影、关联 trace，并渲染自动定位；实际手动调用走 `SQLiteBackgroundIndex.queryPage`，在 worker 内通过 index.queryPage 与 `sqliteRecallPage` 生成既有正文/details，仅传回实际页和返回 ids。沿用 session_start / compaction / tree / cadence 与 awaited shutdown；协作式 deadline 不重置 healthy worker。只有 `sourcePosition < eligibleCount` 的 user/assistant 进入索引；live 不进入候选或统计。机械 `createEngine` 及 `queryRows` 保留同步 / 线程完整排名对照，不读取 agent 配置，BM25 与排序不变。

窗口选择使用共享 `selectFts5Range`：默认 240 加权单位，Han 2 / 其他码点 1；配置覆盖仍加载一次、环境优先。自动/手动共用。SQL 在完整可见语料上 MATCH、按全文 SHA-256 分组、选 BM25 最佳代表、按分数/时间排序，然后 LIMIT/OFFSET；total 由 count(DISTINCT content_hash) 得到。片段命中跨度、窗口和显示字符串均只在返回行被展示时计算并缓存，页外不生成。去重从「查询片段相同」改为「规范化全文相同」，不再承诺旧输出逐字节等价。

显式 `history_recall` 不设查询长度、关键词数量或不同词数量上限，也不截取前 4000 码点。已删除 execute 的 5 词拒绝检查、`countKeywords` 函数及其计数测试；原始 query 完整进入 MATCH 重写和执行。自动提示仍只受 `autoGate` 加权长度门槛约束，不新增查询截断。下述 16000 码点预算仅约束工具输出，不是查询输入上限。

SQLite 通过内存 fts5vocab 检查缺词，不改 query、不拆长中文。生产页内缺词行最多列 10 个词，每词最多 40 码点再加 …，整行最多 512 码点并受当前页剩余 16000 码点预算限制；其余写明省略 N 个。若本页没有最小省略提示的空间，则减少返回行重渲染，nextOffset 始终指向尚未返回行，不清空全部片段。生产单个异常超长 id 的预算进度例外保留，缺词行不会给已耗尽预算的元数据再加字符。

shared `history_recall_trace` 保留 toolCallId、模型 / execute 原始 query 与原文错误，不再附加 `keywordCount` / `rejected`；成功页只记录实际返回 ids，过期结果丢弃。trace 关闭不写正文；timing 的 `index_memory` 保留线程模式的 processRssBytes / mainHeapUsedBytes / workerHeapBytes / entries，没有额外宿主进程 RSS 或 IPC 日志字段。worker 堆已包含在进程 RSS 中，不能重复相加。

### 显式查询超时与配置（2026-10-05）

`src/recall-config.mjs` 在扩展加载时读取一次 `<getAgentDir()>/extensions/compaction-recall.json`；不读项目配置，SDK 嵌入请在注册前设置 `PI_CODING_AGENT_DIR`。两个原型根键与 mode / preindex / trace 共用文件：

```json
{
  "recallTimeoutMs": 5000,
  "autoGate": 210
}
```

`COMPACTION_RECALL_QUERY_TIMEOUT_MS` 优先于 `recallTimeoutMs`，`COMPACTION_RECALL_AUTO_GATE` 优先于 `autoGate`。文件值为正安全整数；环境值为严格十进制正安全整数字符串。所选值非法静默回退默认 5000 / 210，不报错，非法环境覆盖也不退回有效文件值。缺文件静默；畸形、不可读、超限文件的已有 warning 规则不变。`session_start` / `session_tree` 继续用已加载常量，超时不重建 worker，环境 / 文件变化需重载。实验 280 仍可显式设置；不是新默认，历史结果不变。只有 agent 配置加载器宽容回退；纯 `createIndex` / 机械 engine 的显式非法 `autoGate` 仍由 `parseAutoGate` 抛错。

根键 `snippetBudget` 与优先环境变量 `COMPACTION_RECALL_SNIPPET_BUDGET` 加载一次：文件接受正安全整数，环境接受严格十进制正安全整数字符串；缺省/非法所选值回退 240 加权单位，非法环境不回取有效文件值。所有有效预算都按 Han 2 / 其他码点 1 计算，自动和手动共用；没有旧 120 码点默认分支或兼容开关。省略号、自动提示整体预算和工具页预算不变。


显式 recall 的协作式 JavaScript deadline 从父线程请求起始计时，覆盖必要的索引准备、排队、MATCH 与后处理；自动提示不增加超时。JS 循环/阶段与 MATCH 前后检查，worker 回复及父线程接收再丢弃 late results。到检查点抛 `TimeoutError`，模型收到 `history_recall timed out after N ms; narrow the query or use history_grep`。同步 native MATCH 不可抢占，允许超过名义期限直到 native call 返回检查点；5000 ms 不是硬停止或精确墙钟返回承诺。超时不 terminate/reset worker、不清空索引/惰性跨度缓存、不取消其他排队请求、不回退同步主线程扫描；后续请求正常复用 healthy worker caches。真正 session/tree/shutdown 生命周期仍按公共 seam 处理，与单请求 deadline 不同。

中断能力已按当前 **Node 24.18.0 / Bun 1.4.2** 查官方文档、发布标签源码和实际 API：均无公开 interrupt / progress handler。SQLite C 本身有 [sqlite3_interrupt](https://www.sqlite.org/c3ref/interrupt.html) / [progress handler](https://www.sqlite.org/c3ref/progress_handler.html)，但 JS 绑定未提供。Node 的构造参数 timeout 是锁等待 busy timeout，不是执行期限（[版本文档](https://nodejs.org/download/release/v24.18.0/docs/api/sqlite.html#new-databasesyncpath-options)、[绑定源码](https://github.com/nodejs/node/blob/v24.18.0/src/node_sqlite.cc)）；Bun 的 handle 是数组编号而非可传给 FFI 的 sqlite3 指针（[官方文档](https://bun.sh/docs/runtime/sqlite)、[1.4.2 类型声明](https://github.com/oven-sh/bun/blob/bun-v1.4.2/packages/bun-types/sqlite.d.ts)、[原生注册表](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/jsc/bindings/sqlite/JSSQLStatement.cpp)）。

Node [Worker.terminate](https://nodejs.org/download/release/v24.18.0/docs/api/worker_threads.html#workerterminate) 只承诺尽快停止 JS。历史实证：同步 SQLite 递归聚合运行中 terminate 后 1 / 3 秒仍占 CPU 约 1.001 / 3.002 秒，有限查询仍等 1570 ms 才退出，而纯 JS 循环只需 2.03 ms；Bun 线程终止未实测，不对其作保证。这些实证解释为何当前 deadline 只保证 JS 检查点与过期结果丢弃，不声称中断 native SQL。

当前仅保留一个 worker 线程，不增加宿主进程、跨进程 IPC 或额外 RSS 字段；deadline 不损失现有索引/span 缓存，也不取消同代次其他有效请求。grep / expand 执行器仍独立可用。没有持久化索引或新增模型调用，默认生产 worker 不变。旧授权 run 的 `runs/sqlite/nocap-timeout-20261005.json` 属于历史实验，不是当前协作式 deadline 的证明或历史评测重跑。


S4 第 3 步离线验收：本原型三份测试 **34/34**、`npm run check` 类型检查及 **202/202**、Python unittest **28/28** 全部通过。首次预算测试 fixture 未触发分页而断言 nextOffset 错误，已改成真正超预算的长 id fixture；首次 fake-provider 完成断言后未 emit SDK session_shutdown 导致 worker 留存超时，已修成 await extension shutdown 后 dispose，重跑 **0.98 秒正常退出**。没有改公共代码来绕过失败。

真实语料 dev8/3d86fd0a en/zh 各 5035 条，en 自动+6 个显式 query、zh 自动+5 个显式 query，worker 与同步版完整 id 和 score 全部逐项相同；包含 OR、隐式 OR、短语、NEAR、列过滤及 NOT。证据在 `parity-s4/parity.json`。合成测试另覆盖同分、完整分页前排名、live 不影响候选/统计、激活/编辑、native error 后恢复、码点跨度和句首不加分片段。

实际 SDK 假 provider 在 `sdk-smoke-s4-retry/` 通过自动提示→第一页→第二页→6 词拒绝→原生引号错误→完成；4 次 trace 的 keywordCount=2/2/6/0，rejected=false/false/true/false，query_identical 全 true。MRR=1，Recall@5/10/20=1，errorCount=2（两次有意错误）。index_memory 示例：RSS=227520512、主堆=46909568、worker 堆=8132848 bytes、entries=3；entries 为公共 seam 传输的消息条目数，不是 SQLite eligible 文档数，含本 fixture 的 1 条 live。测试日志保留在 `acceptance-s4-*` / `acceptance-s4-retry-*`。第 3 步完成即停止，等待 Hermes 提交后再打包、运行第 1/2 组和授权评分。

最终补齐中英混合和全空白关键词用例后，依次再跑三份原型测试、npm check、Python 全套，仍分别 **34/34、202/202、28/28**；随后 `sdk-smoke-s4-final/` 以相同链路和指标 **1.00 秒正常退出**。最终日志为 `acceptance-s4-final-*`，早期失败及重跑产物不覆盖。

打包命令（输出目录必须新建且位于本轮授权输出根目录）：

```sh
node benchmark/retrieval-sqlite-package.mjs --output /home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/sqlite/adapter-package-s4
```

包包含源依赖闭包、内置 SQLite 引擎和许可证，每个文件只读，manifest 只有一个 pi.extensions 入口。SDK/typebox 由宿主提供，无额外 npm 引擎依赖。runner 用法以 `benchmark/RETRIEVAL_CONTRACT.md` 为准，外部 config/profile 仅交给 runner，不复制凭据。trace 复用生产 history_recall 事件；另记 trace 开启时实际 provider payload 中本适配层提示的存在性及可识别的 reasoning effort，不记录完整请求或思考。

## S5 主线对齐

基线为 `ec16440`，本 worktree 的只读 src/locator.mjs SHA-256 与它完全一致，测试直接对照其 lex。保留中文双字+≥3词、BM25、索引停用词、implicit OR、关键词上限、fts5Snippet sentenceBonus=false、210 门槛等已定差异。未引入 jieba、翻译或额外前缀逻辑。
本节记录 S5 历史接口与验证；当前完整排名仍由 `queryRows` 提供，实际手动工具已切换到前述 worker 内 `queryPage`，共享同一窗口/去重/排名实现，历史成本和验证数字不重标为本轮结果。


同步和 worker 共用 index.queryRows：最新 id 及空正文处理、候选 snippet、规范化片段去重、不同查询词计数及同分 recency 顺序只有一份实现。Snippet 去重发生在 total/分页之前；相同片段始终以最新消息代表，不用较旧的高分消息覆盖它。命中计数使用缓存文档词集合，前缀计数按不同查询词归并，不按展开词数量加分；原生分数仍是第一排序项。

自动提示调用 displayRows，手动页也在分页渲染之前投影 `{id,date,role,snippet}`；其他引擎字段不进入模型或字符预算。词表里同时保存 `_`、`$` 字符：`$x` 可索引、自动搜索可查，显式原生 MATCH 必须写 `"$x"`；裸 `$x` 仍是 FTS5 语法错误，backend 不代加引号。JS 组件词用空格序列写入 FTS5，不能在此 SQL/ascii 路径把别名放到原词同一位置；因此 phrase/NEAR 的位置按序列化词流，不保证与原标识符文本距离一致。单字 `s` 和单个数字仍可被原生 MATCH 解析，但索引没有这些项。

去重成本的可重复脚本为 benchmark/retrieval-sqlite-dedupe-cost.mjs，计时拆分 native_query、candidate_materialization、snippet_render、deduplicate、mechanical_rank。原生对照只做 MATCH/BM25 候选收集，不含片段；不能把整条查询与原生对照的差额都称为新增 Map 去重成本，S4 worker 本来也生成候选片段。阶段证据与 cold/warm 结果记录在运行根目录 s5-dedupe-cost/，正式评测留到 Hermes 复验提交后。

S5 第 5 步最终验收：四份本原型测试 **48/48**、`npm run check` 类型检查及 **216/216**、Python 全套 **28/28** 通过。旧 fixture 把 foo_b 当成纯前缀而断言空结果，已纠正：主线自动 lex 会生成 foo 组件，自动查询命中是正确的；原生 raw foo_b 仍零命中。新增原生不同匹配词数的精确 BM25 同分例子（较旧双词优先于较新单词），以及旧片段代表原生分数更好时仍只留最新的回归。

dev8/3d86fd0a 中英各 5035 条真实输入，en 1 自动+6 显式、zh 1 自动+5 显式，worker 与同步版新规则完整 id/score 全部相等；记录为 parity-s5-final/parity.json。实际 SDK fake provider 同时检查自动提示及两页 recall 的 JSON 行只有四字段、同分最新在前；保留六词拒绝、引号错误、trace 和 index_memory，MRR=1、Recall@5/10/20=1。首次单独 smoke 0.98 秒正常退出，最终复跑同样通过；最终记录为 sdk-smoke-s5-final/。无真实模型或评分调用，等待 Hermes 复验提交再打包。

最终成本样本在 s5-dedupe-cost-final/：5000 条、约 4495–4498 码点/条、单词 aurora 全匹配，5 次 warm；独特片段/五倍重复两种语料返回 5000/1000 条。warm 总耗时 **427.77/424.01 ms**，其中 snippet_render **388.18/386.04 ms**、规范化 Map 去重 **6.43/6.01 ms**，native-only 对照 **4.23/4.18 ms**。cold 首查询 **2563.95/2473.37 ms**（含首次 span 缓存构造）；不是操作系统冷缓存。不能把 warm 对照差额当作 S4 worker 的全部新增成本，S4 也已算片段。

## 确定的限制

- 这是词面召回，不理解语义；原生 phrase/NEAR 约束作用于序列化索引词流。OR 会保留仅命中少量词的候选；历史“重启断连”查询中的 b、“修改youer…”中的 b 均非相关事实证据。双字可能跨词边界形成偶然命中，例如“搜索引擎”中的“索引”。
- 自动查询不补救错字、任意英文前缀/内部子串及单 Han 字；不能由 gatway 推出 gateway 或由 moto 推出 motorcycle。S5 的确切标识符组件可以命中原词，如 compaction 命中 CompactionResult；这不是任意前缀匹配。显式可使用原生 FTS5 前缀语法，不自动补写；无结果不代表历史没有相关语义。
- 同时索引双字与词语会影响 BM25 的词频和文档长度；分数不是概率，不应与另一引擎直接比较。ICU 升级可能改变多字词和排名。
- 已完成 16 题机械评测及 v2/v3 各 32 个正式会话，均是单次运行，不给波动范围或跨引擎结论。v4 在显式查询端只替换隐式连接，显式 AND 仍要求全部操作数匹配，NEAR 和短语不放宽。片段窗口不保证展示最相关证据，应 expand 核实；OR 可能返回更多弱相关候选。

## S6：默认关闭的离线候选

评测入口 `retrieval-sqlite-engine.mjs` / `retrieval-sqlite-worker.mjs` 读取单值 `COMPACTION_RECALL_SQLITE_ARM`；允许 `off`、`prefix-all`、`prefix-min4`、`jieba`、`porter`、`porter-jieba`、`porter-js`、`inflect-wink`、`lemma-index`，默认 off，各值互斥，未知值或自行拼接组合报错。`createIndex` 只接受显式 `{arm,autoGate}`，不读取环境；生产检索语义和原始 query trace 不变，当前显式查询已取消关键词上限。主线 89 个停用词只过滤自动提示，索引和显式查询保留它们。

`COMPACTION_RECALL_AUTO_GATE` 控制所有评测 arm 的自动提示加权长度门槛：Han 每码点 2，其余（含空格、标点、emoji）每码点 1。默认仍为 210。机械 engine / worker 工厂创建时读取环境一次，非法值仍由 `parseAutoGate` 抛 `RangeError`；实际扩展入口先通过上述 agent 配置加载器解析环境 / 文件、宽容回退后显式传给 worker，每次重建继续使用已加载值。设置 280 时，279/280 允许，281 跳过；显式 searchRaw / history_recall 不受门槛影响。生产插件不启用这些原型检索选项。第 1 组结果的 autoGate 字段及历史文件不修改。

```sh
COMPACTION_RECALL_SQLITE_ARM=porter-jieba COMPACTION_RECALL_AUTO_GATE=280 pi -e ./benchmark/retrieval-sqlite-adapter.ts
```

- **prefix-all**：自动选出的全部词项加原生 `*`；显式 MATCH 仅扩展裸操作数。引号、已有 `*`、`^` / `+` 所属短语及完整 NEAR 组不改；AND/OR/NOT、列名和分组保留。列作用域内独立裸词仍扩展。
- **prefix-min4**：同上，仅扩展至少 4 字符的 ASCII 字母/数字/下划线裸词；不扩展 Han。
- **jieba**：`Jieba.withDict(dict)`、`cutForSearch(hanRun,true)`，只替换连续 Han 段的 Intl 长词；双字不变。纯 Han 至少 3 码点的输出按 term/start/end 去重，重叠及重复位置仍保留。每 worker 惰性加载一次；主线程评测入口不加载 native addon 或字典，自动切词也在 worker。同步 createIndex 可在 worker 内使用；主线程同步启用 jieba 会明确拒绝，group1 引擎桥接到 worker 内同步索引。显式 MATCH 本身不切词改写。
- **porter**：FTS5 的 tokenizer 是表级而非列级，因此用同连接内的 `tokenize='porter ascii'` 辅助表按原生位置生成英语 stems，再存入主表 tokens/stems 双列，执行 `bm25(terms,1.0,0.5)`。Han 不进入 stems。未加引号且未显式指定列的操作数走原词/词干；引号与显式列过滤保留 exact/native 语义。同词别名相同时使用单个跨列短语，其频次为 `1.0*origTF+0.5*stemTF` 后统一饱和；别名不同时为两条原生 OR phrase 的 BM25 相加，不能视为完全消除了重复贡献。命中词计数及片段按原始查询词去重。含引号的 NEAR/+ 单元保持原列完整短语；纯裸单元不做跨列混合短语；stems 排除 Han 会压缩该列位置，双列也改变原生文档长度统计。
- **porter-jieba**：组合已有 jieba tokenizer 与原生 porter helper，不另建切词或查询实现。Han 索引和自动查询保留双字底座及 jieba 搜索模式 ≥3 字词；ASCII 词沿用 porter 的原词/stems 双列、1.0/0.5 权重、操作数改写、命中计数及原文跨度。Han 不进入 stems。显式 MATCH 沿用 porter 的引号/列过滤 exact 语义，不额外改写中文。和 jieba 一样仅在 worker 内创建同步索引，第 1 组评测入口自动桥接；默认关闭。双列仍会影响中文 BM25 文档长度，不能把组合排名简单等同于两组单独排名。
- **porter-js**：复用 porter 的 tokens/stems 双列及完整 query 重写/片段/去重语义；仅改为 JS `@orama/stemmers/english` 预生成词干，列权重 1.0/1.0。不创建 native porter 辅助表。JS helper 按 native ascii 边界拆 `_`/`$`、保持顺序及重复，Han 不进入 stems；依赖仅此 arm 初始化时加载。booked/booking/book、attended/attending、workshops、played→plai、assembled 与 native porter ascii 抽样一致。原 porter 保持 native helper 与 1.0/0.5 权重作对照。
- **inflect-wink**：worker 内对实际索引词表的每个不同纯 ASCII 字母词，调用 wink 的 noun/verb/adjective，建立 lemma→索引词 Set。查询词按三种 lemma 共享关系扩展到实际索引词并保留自身；不自行补后缀规则、过滤词性歧义或修改库返回值。没有新列、tokenizer 或 postings。自动词项及显式独立裸词转换为 OR 组；引号、短语、已有 `*`、NEAR、完整显式列作用域不扩展，空格仍先按原 implicit OR 改写。默认 210 门槛和原关键词上限不变，自动门槛可由上述变量覆盖。FTS5 原生叠加每个变体：测试同文档 book/booked 两项得 -2.4475508632442313，单变体得 -1.2237754316221157，不做分数组内去重。同步索引在 worker 内运行，主线程评测桥接，不加载 wink 词典。完整 16 题英文逐词扩展清单、lemma 表统计、12 个 GC 样本和排名证据见运行报告；库的 noun/verb/adjective 联合集合也可能产生 am→are/be/been/is/was/were、games→gamer 等扩展，照实接受。
- **lemma-index**：复用锁定 wink 3.0.4，在 worker 内缓存每个纯 ASCII 字母词的单个原形：verb、noun、adjective 依次取第一个与原词不同的结果。索引和查询共用函数；每个 lex 位置替换一个词，不增列、不增变体位置，重复原形仍保留原有实际词频。自动词项还原后 Set 去重；显式裸词及引号短语内原生 `_`/`$` 边界词还原，AND/OR/NOT/NEAR 与列名保留，列作用域内词项正常还原。已有 `*` 词不还原；带 `*` 短语的最后前缀词保持原样。还原索引里 booking* 不保证仍匹配 book，这是保留用户前缀字面语义的结果。归一化 spans 保留原文 codepoint 偏移，snippet 窗口能选到原文实际词形；共享 renderer 仍输出纯文本，不加额外标记。已测试 booking→book、leaves→leave、sold→sell、better→good、attendance 不变、原生短语位置和与直接归一化语料的 BM25 完全一致。

各候选最新离线验收、同步/background worker 完整排名对照及 off 对 S5b 的逐项 id/score 一致性见授权 runs/sqlite/s6-arms.md。auto-stopwords-iso 已移除代码、测试和依赖；此前结果仅保留存档，不代表当前可运行开关。

复现（需要显式指定只读数据/gold 与新的输出；不调用模型）：

```sh
node benchmark/retrieval-sqlite-arms.mjs --arm prefix-min4 --data "$DATA" --gold "$GOLD" --baseline "$RUNS/group1-s5b.json" --output "$RUNS/group1-s6-prefix-min4.json"
COMPACTION_RECALL_SQLITE_ARM=off node benchmark/retrieval-sqlite-parity.mjs --data "$DATA" --gold "$GOLD" --output "$RUNS/parity-s6-off"
node benchmark/retrieval-sqlite-measure.mjs --data "$DATA" --gold "$GOLD" --output "$RUNS/s6-memory" --samples 3
```

测量每个样本为独立 `node --expose-gc` 进程，统一在 worker 内运行同步索引；字典加载及建索引前后各 GC 两次。输入 documents 在 before 之前已存在，活堆增量不包含输入原文，也不包含查询后惰性 spans 缓存；RSS 不是数据库物理大小或峰值。jieba 字典加载另报，不能把仅 build 的 RSS 增量当总成本。每查询首调用及 3 次 warm 单独记录；汇总为 3 个新进程的中位数。

本轮完整指标、四份语料的内存/构建/五条查询时间、实际命令与 git diff SHA256 位于授权 runs/sqlite/s6-arms.md；raw samples 在 s6-memory/summary.json，逐题匹配及排名证据在 group1-s6-evidence-complete.json。只完成离线候选，没有第 2 组或真实模型调用，也没有提交。
