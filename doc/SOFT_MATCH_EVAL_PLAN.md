# 软匹配召回原型：LongMemEval 中文检索评测计划（v3）

- v1：2026-10-03 19:30 CST 冻结。
- v2（19:45）：新增「详细 trace」。
- v2.1（19:50）：trace 写进生产 timing 日志；不记思考；不记逐字原始 JSON。
- v3（19:58）：从 `~/.hermes/task-runs/recall-soft-match-20261003/eval-plan.md` 移入本仓库 `doc/`（凛音指定）；定下计分口径、query 由主模型自己决定、保留「中文拆双字」、grep/expand 描述、trace 一档进配置文件。
- v3.1（20:00）：提示词文件移入 `doc/SOFT_MATCH_PROMPTS.md`；benchmark 主模型定为 gpt-6-luna high；去掉"运行产物不进仓库"。
- v3.2（20:01）：第 2 组每题跑一次（同以往模型 benchmark）。待决项清空。
- v3.3（2026-10-04 13:20）：新增「搜索场景优化」待定项（编码场景下的查询语法与短语问题，凛音要求先记入计划）。

只是计划，尚未派给 OMP，也没开始跑。

## 被测对象

- 历史分支：`feat/background-index`；运行工作树由显式外部路径指定。
- 两个原型并行，不要求互相兼容：
  - `prototype/soft-match-sqlite`：内存 SQLite FTS5，原生 BM25
  - `prototype/soft-match-minisearch`：MiniSearch 7.2.0，默认 OR、prefix 开、fuzzy 0.2
- 两边当前索引一样：中文 = 相邻双字 + `Intl.Segmenter('zh')` 切出的 ≥3 字纯汉字词（同跨度去重，不加 trigram）；英文按整词。
  - 这个分词器只是临时方案，以后会换。本轮不针对它做任何优化，也不加"只用双字"的对照组。

## 数据

- 16题外部输入：`$DATA_ROOT/{dev8,hard8}/<id>/`，含英文`corpus.json`、中文`corpus-zh.json`与冻结`question-zh.json`；公开树只保留授权的中文题面，不含完整语料。
- 外部Gold：`$GOLD`；16题50条（47 user、3 assistant），来源`longmemeval_m.json`，sha256 `fb5413e3…daff2d9`，公开元数据只保留证据坐标。
- 中文、英文各跑一遍，英文用来对照翻译带来的影响。中英 corpus 的 gold 位置必须先校验一致，对不上就报错，不出分。

## 分组

- **第 1 组（纯机械）**：拿用户问句原文直接走自动 recall，`autocut=true`，后端按规则选词、去停用词。
  - 210 加权长度门槛：分词前计算，汉字算 2、其他字符算 1；超过 210 就跳过自动 recall，正好 210 不跳过。冻结的 16 道问句都没超（中文最长 107，英文最长 192）。
- **第 2 组（自动 recall + 主模型调用工具）**：先走自动 recall，再由主模型自己看情况决定要不要调 `history_recall`、调几次、query 怎么写，`autocut=false`。harness 不强制调用。
  - 插件不负责生成 query：生产里由主模型或用户自己决定，benchmark 里就是主模型。
  - query 原样交给引擎，后端不选词、不删词、不改写、不截断；出错时报错原样返回给模型。
  - 显式调用不受 210 门槛限制。
  - 每个原型用自己的原生查法：SQLite 写 FTS5 MATCH 表达式，MiniSearch 写字符串或 Query JSON。
  - 工具提示词见 `doc/SOFT_MATCH_PROMPTS.md`（冻结 v2，含 history_recall ×2、history_grep、history_expand）。只用于评测 harness，生产 `src/recall-extension.ts` 的描述不动。
  - benchmark 主模型：gpt-6-luna，reasoning effort high。写在 `benchmark/evaluate.py --config` 里（仓库不内置模型默认值）。

## Harness

- 只共用三样：题目、gold、指标计算。每个原型各接自己的适配层。
- 两条线分开报分，报告里不拆"引擎差异"和"提示词差异"。

## 指标

- MRR、nDCG@5/10/20、Recall@5/10/20、Precision@5/10/20
- top-5 命中、命中 gold 条数（沿用旧 rerank 的口径，方便对照）
- 延迟、内存单独报，不合并成一个总分
- 不做答题模型或 judge 的端到端评测
- 只有 16 题，逐题报告，结论谨慎解读
- 第 2 组每题跑一次，报告注明单次运行，不给波动范围

### 第 2 组计分

- Recall@K：自动 recall 的前 K 条，与每次 `history_recall` 调用的前 K 条，取并集后算。
- MRR、nDCG@K：按第一次 `history_recall` 调用的排序算。整题没调用的，用自动 recall 的排序（等于第 1 组该题分数）。
- 另报每题调用次数、没调用的题数。

## 详细 trace（history_recall，autocut=false）

- 开关：`<agentDir>/extensions/compaction-recall.json` 新增 `"trace": true`，默认 false。只有这一档，只进配置文件，不加环境变量。
  - 关闭：timing 日志保持现状，只记白名单里的数值和固定标签，不记正文、query、参数。
  - 开启：每次 `history_recall` 调用往 `COMPACTION_RECALL_TIMING_FILE` 多写一条 trace 事件（字段见下）。没设该文件就不写，加载时 warn 一次。
  - 连带改动：`src/recall-config.mjs` 已知字段加 `trace`；`doc/TIMING.md` 隐私说明改成"trace 关闭时不记内容"；`doc/PLUGIN.md` 配置示例补上。
- 插件内两处抓取，用 toolCallId 对上：
  - 模型输出：`pi.on("message_end")` 读 assistant 消息里 `history_recall` 的 ToolCall（SDK 1.0.0 已解析成 JSON 对象）。
  - 插件收到：`history_recall` execute 拿到的 params（第一个参数就是 toolCallId）。
  - SDK 的 `tool_call` 事件允许其他扩展原地改 `event.input`，所以两者可能不一致，`query_identical` 有实际意义。
  - codemode 发起的嵌套调用（带 parentToolCallId，id 形如 `<parent>/<n>`）在消息里没有对应 ToolCall，模型输出一栏记为缺失并标出 parent。
- 每次 `history_recall` 调用写一行，至少包含：
  - 插件侧：session id、本 session 内第几次调用、toolCallId（原型 / 语言 / 题号插件不知道，由 harness 按"一题一个 trace 文件"或按 session id 关联补上）
  - **模型输出**：这次工具调用的 `arguments`（SDK 已解析的对象，原样序列化），以及同一条 assistant 消息的正文文本。不记思考内容，不记逐字原始 JSON 字符串。
  - **插件收到**：`history_recall` execute 拿到的 `query` 原值（autocut=false），不做任何处理
  - `query_identical`：模型输出里的 query 与插件收到的 query 是否逐字节一致
  - 返回结果：命中 id 按排名顺序、total；报错时记报错原文（如 FTS5 语法错误、JSON 解析错误）
- 第 2 组跑分时开 trace，trace 文件放 `~/.hermes/task-runs/recall-soft-match-20261003/` 的运行输出下。

## 已定

1. 第 2 组计分：按上面「第 2 组计分」（凛音：用建议，19:55）。
2. query 由主模型/用户自己决定，插件不负责；benchmark 主模型 gpt-6-luna high（20:00）。
3. 提示词里「中文拆双字」保留（19:55）。
4. history_grep / history_expand 描述通过，已并入提示词文件 v2（19:55）。
5. 不补"索引无单字"（19:50）。
6. trace 不记模型思考内容（19:50）。
7. trace 一档，进配置文件（19:55）。
8. 第 2 组每题跑一次，同 `BENCHMARK.md` / `BENCHMARK_RESULTS.md` 以往口径（20:01）。

## 待决

- 搜索场景优化：见下一节，未定，不进 S6。

## 搜索场景优化（待定，2026-10-04）

**为什么要单列**：LongMemEval 是闲聊记忆，题目里没有技术写法。v4、S4 两轮 SQLite 一共 120 次显式查询，带 `$` 的 0 次，带引号的短语 2 次（`"The Power"`、`"past month"`），NEAR 0 次。插件实际是给 Pi 编码会话用的，路径、命令行参数、`$VAR`、带点的名字、驼峰/下划线标识符、报错原文都是常态，这批评测覆盖不到，0 次不代表少见。

**已核实的问题**

SQLite（S5，`7cc5eba`）
1. FTS5 不加引号的词只认字母、数字、下划线、非 ASCII 字符。`src/locator.mjs`、`--no-extensions`、`v26.7.0`、`$HOME`、`foo-bar` 直接报语法错误；`node:sqlite` 的 `:` 被当成列过滤，报"没有这一列"。报错原样返回给模型，模型加引号就能查。
2. 驼峰/下划线拆出来的小词追加在整词后面、写进同一列：`getUserName returns` 存成 `getusername get user name returns`。模型正确写出的短语 `"getusername returns"` 查不到，NEAR 的距离也被拉长。这条与模型能力无关，写对了也会漏。
3. 中文双字重叠切分（苏联/联动/动画），中文短语 `"苏联 动画"` 对不上；整串加引号会变成索引里没有的一个长词。

MiniSearch（S5，`d13628f`）
4. 字符串查询先切词再匹配，不报语法错误；没有短语功能，所以也没有位置问题。实测 `src/locator.mjs`、`node:sqlite`、`--no-extensions`、`$HOME`、`E2BIG` 正确那条都排第一。
5. 模糊和前缀匹配会把相近的标识符混进来：搜 `locator.mjs` 带出 `locator.cjs`，搜 `v26` 带出 `v25`，`--no-extensions` 里的 `no` 前缀带出 `node`。都排在正确条目之后，但没法要求"就要这个写法"。
6. 以 `{` 开头的查询会被当成 MiniSearch Query JSON 解析：`{"a": 1}` 直接抛 `Cannot read properties of undefined (reading 'map')`。

**候选改动（都未定）**

- SQLite a：显式查询里不合规的词由后端自动加引号。凛音倾向不做：写合格的 FTS5 查询在模型能力范围内。
- SQLite b：小词另放一列 `parts`，主列只放整词、保持原文顺序；不加引号的词默认搜所有列，`user` 仍能命中 `getUser`。
- 编码场景离线用例（两边都跑）：路径、参数、`$VAR`、带点的名字、驼峰、`snake_case`、报错原文、`node:xxx`；检查不报错、短语命中的是对的消息。查询和答案最好取自真实 Pi 编码会话。
- MiniSearch：`{` 开头的查询只在符合 Query JSON 格式时按 JSON 处理，其余当普通文本；标识符类词（含数字、`$`、`_`）关掉模糊匹配，做成开关离线对比。
- 中文短语：在提示词里说明，或另议。
- 编码会话评测集：迟早要另做，单独议。

## 约束

- 不提交、不推送、不切分支、不发布，不装进个人 profile；不跨目录去写相邻的原型。
- 跑 benchmark 或调用真实模型之前，要先拿到凛音授权（仓库 AGENTS.md 也这么要求）。
