# 0.1 插件行为与限制

当前生产入口为 `src/index.ts`，替代入口 `src/recall-extension.ts` 只选一个。full 默认使用 SQLite FTS5 **内存库**与原生 Node worker；lite 仅注册 history_grep/history_expand。两种模式不接管 Pi 压缩，不持久化索引，不新增模型调用。要求 Node.js **>=24.18.0**；已检查宿主 Pi SDK **1.0.0** 的 docs/examples、加载和事件接口。SDK/typebox 维持宿主 peer；生产 npm 依赖仅 `@node-rs/jieba`。

0.1.0 是本地准备版本，本任务没有 npm publish、远端 push 或发布 tag。旧 JS 运行时、原说明与测量保留在 `benchmark/archive/js-runtime/`；本页描述当前 SQLite 行为，历史数字不是本次生产验收成绩。

## 加载与依赖

```sh
npm ci --ignore-scripts
pi -e ./src/index.ts
```

也可用 `pi -e /absolute/path/to/compaction-recall` 临时加载 package，不写 profile。Pi 本地目录不自动安装依赖，应先安装；Pi 管理的 npm/git 来源会安装 `dependencies`，宿主映射 SDK/typebox。`pi install` 会修改 settings，本次发布准备未执行。worker 整条依赖链是原生 `.mjs`，不依赖宿主 TypeScript loader、兄弟工作树、benchmark/prototype 模块或 warning suppression。jieba 原生词典仅在 worker 初始化。

## full / lite

| 行为 | full（默认） | lite |
|---|---|---|
| 工具 | recall / grep / expand | grep / expand |
| 自动内容 | 最近用户问题的短词面定位提示 | 不注册 context hook，不额外注入隐藏提示 |
| 索引 | 当前分支已压缩记录的 SQLite 内存 FTS | 无索引、worker 或预热 hook |
| 生命周期 | 代次隔离、预热节奏、等待 shutdown | 工具调用时读当前分支 |
| optional timing | worker、查询与三个工具 | 仅 grep / expand 调用链 |

模型决定何时查找、展开、补充 grep，没有固定证据分数门槛。lite 工具说明不提未注册的 recall/locators。不声称 lite 更快；工具返回的历史仍可能发给 provider，lite 不是隐私隔离模式。

## 一次性 agent 配置

文件可选：`<getAgentDir()>/extensions/compaction-recall.json`，默认目录 `~/.pi/agent`；从 SDK 公共根导入 `getAgentDir()`。`PI_CODING_AGENT_DIR` 改变 agent 目录，不使用 cwd、项目 `.pi` 文件、`ctx.cwd` 或 SDK loader/createAgentSession 的 `agentDir` 选项。SDK 嵌入时也应在加载前设置该环境变量。

```json
{
  "mode": "full",
  "jieba": true,
  "autoGate": 280,
  "snippetBudget": 240,
  "recallTimeoutMs": 5000,
  "trace": false,
  "preindex": { "userCycles": 10, "toolRounds": 10 }
}
```

| 文件字段 | 环境覆盖 | 默认与校验 |
|---|---|---|
| mode | COMPACTION_RECALL_MODE | full；只接受 full/lite，非法环境覆盖直接回退 full |
| jieba | COMPACTION_RECALL_JIEBA | true；文件仅布尔，环境仅 on/off；非法所选值警告并回退开启 |
| autoGate | COMPACTION_RECALL_AUTO_GATE | 280；正安全整数；环境须严格十进制字符串 |
| snippetBudget | COMPACTION_RECALL_SNIPPET_BUDGET | 240；同上 |
| recallTimeoutMs | COMPACTION_RECALL_QUERY_TIMEOUT_MS | 5000 ms；同上 |
| preindex.userCycles | COMPACTION_RECALL_PREINDEX_TURNS | 10；1–100 整数 |
| preindex.toolRounds | COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS | 10；1–100 整数 |
| trace | 无 | false；仅文件布尔 |

所有值在扩展注册时读取一次；文件/环境改变后重载。session_start/tree 用已加载参数重置，不重读配置。无文件时静默采用默认/环境，不创建配置。文件上限 65,536 bytes；畸形、不可读、超限文件忽略并警告，未知字段警告但不打印内容。mode 非法直接 full；非法 cadence 环境值保留有效文件/默认值；非法检索数值覆盖静默回退正式默认，不取回有效文件值。trace/jieba 非法值警告，不暴露原值。

正式默认依据为 7820047 的最新冻结 LME/SWE manifest：**英文 Porter＋纯汉字双字、280 / 240 / 5000、jieba 开**。生产固定策略，不提供 S6 arm 选择器，不读取 `COMPACTION_RECALL_SQLITE_ARM`、`COMPACTION_RECALL_SQLITE_BIGRAM_ONLY` 或 `COMPACTION_RECALL_SQLITE_HAN_PHRASE_TRIAL`；旧变量仅保留在评测适配层。

## recall：概念组与候选语义

`history_recall({concepts:string[][], match?:'any'|'all', exclude?:string[], limit?, offset?})`。

- 1–5 组，每组 1–4 替代词面；默认 any 是组间 OR，all 要求每组在同一索引记录命中。组内是替代 OR；一个词面的分析路径外 OR、路径内词项 AND，表示同记录共现，不保证顺序、相邻或 phrase。
- 词面是 literal 数据，不是 SQL、原生 MATCH、任意 AST、regex。每面非空 trim 后最多 256 Unicode 码点，总计 2048；未知字段失败。旧 query/must/prefer 不兼容，不提供别名。
- 沿用未经修改的作者 parseQuery/compileFts5；FTS MATCH 单独决定候选。索引包含基础词项与原生 Porter aliases；自动查询使用现有 porterTerm。主动 compiler 不推断 stemming/synonym 扩展，须自行给替代词面；不是语义搜索。
- 分析完整性检查同原候选：零 token 保留 QueryError/EMPTY_ANALYSIS；部分 Letter/Number/Mark 损失继续按实际词项 FTS，并携带短 warning。例：`Warning: "7:30" → ["30"]. Suggestion: revise query terms or use history_grep.` 不丢词面、不扩大候选、不扫描兜底、不恢复 rarity。声明忽略的标点/大小写和合法归一不加 warning。
- exclude 最多 5 个词面，用同一 compiler 分析，任何匹配硬排除该记录；部分损失同样 warning。exclude 不选片段、不贡献 jieba 排名。
- 保留已接受的英文聚合段：计数/求和/列表先收集有证据的不同项目，再核时间范围、状态与重复；检索 entry 数不是项目数，首轮/首页不是完整清单，不猜缺项。

### SQL 排名、去重与页

复用原长词提取和 `han_rank(rowid,term)`：jieba cutForSearch 的纯 Han 至少三字词只进辅助表，不改基础 FTS token 流。先固定 MATCH 与 BM25/full-content 去重代表项（规范化空白的全文 SHA-256），然后 SQL 按 **不同正向长词面命中数 DESC → BM25 → timestamp DESC → recency DESC → rowid DESC** 排序，最后 LIMIT/OFFSET。词面来自正向 concepts，不从 exclude 取分；没有 JS 全候选或当前页重排，没有 jiebaRankingPending。

自动提示复用同一 collector/SQL，但仅用原先选出的 queryTerms。已测纯汉字双字自动词项通常不含至少三字词面，因此开关一般不改变中文自动提示的长词分；不为制造重排效果而补词或改候选。这是保留实测候选行为，不把旧 ICU 增词对照当正式策略。

recall 默认及上限 50 条，offset 默认 0；正文/details 返回 total、returned、nextOffset、hasMore。总数为不同规范化全文，SQL 去重和分页在片段生成之前完成，仅为实际页渲染片段。使用返回 nextOffset；同查询、未变分支才稳定，编辑/压缩/换树后从 0 重查。每页目标 16,000 码点；warning 计入预算。单条 metadata 超预算时完整返回并 budgetExceeded，保持可前进。片段默认 240 加权单位（Han2，其余1），不切代理对；日期为 entry 日期，不推断事件日期/摘要归属。

### 自动提示与期限

context 查最近真实用户消息；没有文字/词项、未压缩、无命中不补旧问题。加权 query 长度 **280 允许、281 跳过**，不再使用旧 4000 字/24 词截断；主动查询不受 autoGate 限制。取 SQL 前五名再应用 1500 码点显示预算，不用第六名以后回填。提示 display:false，紧随最后一条真实用户消息，不写 session、不累积，不打断 tool-call/result 邻接。

协作 deadline 从主动请求准备/排队前开始，覆盖编译、完整性检查、native MATCH、去重、片段/渲染。同步 MATCH 不可抢占，不能承诺准确墙钟返回；检查点丢弃过期结果，TimeoutError 建议缩小查询或 grep。超时不终止健康 worker、清缓存或取消其他请求。grep 自身没有 regex 执行超时。

## grep / expand 与范围

- `history_grep({pattern,limit?,offset?})`：大小写不敏感 JavaScript gi regex，非法 regex 字面回退；不是 SQL LIKE。按匹配 entry 的分支顺序分页，默认 30、最多 50。total 是原始 occurrence 总数，totalEntries 是匹配记录数；最多 30 个片段/每 entry3 个，输出最多 16,000 码点。covered/omitted 描述本响应覆盖/遗漏，含其他页；消费到超长 metadata 才警告并推进。零宽/裁切等规则保留原 grep 实现。
- `history_expand({id,before?,after?,offset?})`：目标优先，最多 16,000 码点；offset/returned/total/nextOffset 为码点。目标完整后才放完整邻居，默认各2、范围0–20；不显示的邻居不计 from/to。可读 toolResult 可展开，thinking/图片不展示。
- 每次读取当前分支最新 compaction 的原始 firstKeptEntryId 边界，只暴露此前消息；缺边界沿既有行为取最新 compaction 前的消息。先用原始位置划界，边界省略不泄露 live 区。
- 自动、recall、grep、expand 共用 branch-local context_edit：最后编辑生效，null 省略不可用、替换遮原文，不绕过编辑读取旧存储。只搜索用户/助手文本及助手工具名/输入，排除 toolResult/思考/图片/摘要；原输入确定性序列化，异常循环安全。不跨 session/parentSession/被放弃分支。

## 生命周期、失败与可选日志

复用既有 batched worker 协议、分支投影、代次取消与 large-entry 传输。session_start/tree 清旧代次、重置节奏并预热；session_compact 刷新 eligible 记录；默认每10完成用户轮或10完成工具批次安排合并预热。user message_end 发生在 SDK 持久化前，只计 pending；agent_end/turn_end 用完成状态和 entry id 去重。

SQLite worker 仅索引 sourcePosition < eligibleCount 的记录；live 文本可暂存于传输/staging，但不成为 FTS 候选。当前 SQLite 候选没有沿用旧 JS 的 live token/DF缓存：eligible 投影内容变化时在内存重建，未变时复用。查询等待必要维护；同 eligible 的 live-only 准备不改变可见集。worker/传输失败直接报错，不切回 JS 扫描；显式生命周期重置可重建。shutdown 取消待回调/请求并 await dispose/worker termination，无跨 session 缓存。

`COMPACTION_RECALL_TIMING_FILE=/absolute/private/path.jsonl` 才启用 timing（0600），默认不计时、不写日志。trace 是同一 agent 文件 opt-in；关闭时不加 trace hooks，开启时记录模型参数/执行 concepts/match/exclude、实际返回 id/页与原错误 name/code/message，不记 thinking/凭据，不保存 provider wire。trace 延迟到 agent_end/shutdown 关联，带内容，应视作敏感文件；没有 timing 目标时只警告一次不记录。内存 mark 的 process RSS、main heap、worker heap/external 不能相加，SQLite/jieba 原生内存可能只反映在 RSS。详细历史机制见 TIMING.md，当前 worker 说明见 BACKGROUND_INDEX.md。

## 验证与历史记录

```sh
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

离线行为/隔离SDK/worker检查不证明模型准确率；本次未付费重判或重测性能。`benchmark/archive/release-0.1.0/INDEX.md` 公开来源、处理、运行hash、判分代码与非正文指标，并保留授权的16题中文译文。英文原题、参考、最终回答、裁判理由、检索摘录及全文会话留外部；逐字复现需对应外部输入，不能只凭来源链接恢复冻结回答。sw08人工认可与机器7/8独立，修订参考版本/hash与旧中文grading input分开。旧性能数字未重标；npm仍只含src、双语README、许可证和clean aggregate。
