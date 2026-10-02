# 插件行为与限制

生产代码全部在 `src/`，支持 `full`（默认）和 `lite` 两种模式。full 在 Pi 原生压缩后自动注入短定位提示，提供 `history_recall`、`history_grep`、`history_expand`，并使用会话内 worker 索引和未压缩消息预分词。lite 只提供 `history_grep` 和 `history_expand`，不自动注入提示、不启动 worker。两种模式都不接管压缩，不新增数据库、持久索引或模型调用。已核对宿主 SDK：1.0.0。

本仓库从 `pi-lossless-context/prototype/recall-spike` 独立提取。运行时相对导入均在本仓库内，不依赖原项目；这是来源路径，不是当前入口。[FINDINGS.md](FINDINGS.md) 是历史实验结果，不是目录整理后重新跑分的结论。

## 加载

在仓库根目录临时加载，不改 profile：

```sh
pi -e ./src/index.ts
```

也可以将整个目录作为本地 Pi package 安装；这会修改用户的 Pi settings，需要你自己决定执行：

```sh
pi install /absolute/path/to/compaction-recall
```

`package.json` 的 `pi.extensions` 指向 `src/index.ts`，也支持 `pi -e ./src/recall-extension.ts`。两个入口只选一个；根目录不保留 shim。宿主提供 Pi SDK 和 `typebox`，开发/测试使用锁定依赖（Pi SDK 1.0.0）。

## lite / full 模式

| 行为 | `lite` | `full`（默认） |
| --- | --- | --- |
| 工具 | `history_grep`、`history_expand` | 三个工具，另含 `history_recall` |
| 自动历史提示 | 不注册 `context` hook，不改写请求上下文 | 按最后一条用户消息注入隐藏短定位提示 |
| 后台工作 | 无 worker、预分词或索引生命周期 hook | worker 索引、预分词节奏和压缩后启用 |
| 查找时机 | 模型自己决定何时搜索，再展开核实 | 自动提示辅助定位，也可主动 recall / grep / expand |
| 可选计时 | 仅 grep/expand 调用链及其分支读取、文本提取、渲染阶段 | 自动提示、检索、worker 维护和三个工具阶段 |

配置文件**可选**，位置为 `<agent-dir>/extensions/compaction-recall.json`，放在 agent 目录的 `extensions` 子目录。`src/recall-config.mjs` 从 SDK 主入口 `@earendil-works/pi-coding-agent` 导入公开的 `getAgentDir()`，使用 `join(getAgentDir(), "extensions", "compaction-recall.json")` 定位；默认路径为 `~/.pi/agent/extensions/compaction-recall.json`，agent 目录可由 `PI_CODING_AGENT_DIR` 改变，不自行拼接默认目录，也不读取项目级配置。mode 和预分词参数共用一个文件及 `loadRecallConfig` 加载函数。完整示例：

```json
{
  "mode": "full",
  "preindex": {
    "userCycles": 10,
    "toolRounds": 10
  }
}
```

文件不存在时不警告、不创建文件，静默采用环境变量 / 默认值。`COMPACTION_RECALL_MODE=lite` / `COMPACTION_RECALL_MODE=full` 覆盖文件中的 `mode`；未配置时为 full。值区分大小写，只接受这两个字符串。非法文件值警告并回退 full；非法环境变量也警告并**直接回退 full**，不会重新使用文件里的 lite。预分词字段独立接受 1–100 的整数：有效 `COMPACTION_RECALL_PREINDEX_TURNS` / `COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS` 优先于文件字段，再回退到 10；非法环境值警告后保留有效文件值 / 默认值。文件大小上限为 65,536 字节；不可读、畸形、超限文件忽略并警告，未知字段忽略并警告，不打印非法值或文件内容。加载阶段的 warning 写入 stderr。

三个环境变量可以完整控制配置，无需配置文件。例如：

```sh
COMPACTION_RECALL_MODE=lite COMPACTION_RECALL_PREINDEX_TURNS=10 COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS=10 pi -e ./src/index.ts
```

mode 和预分词参数在**扩展加载时一起读取一次**，来源和生效时点一致。修改文件或环境变量后需重新加载扩展 / 重启 Pi。`session_start`、`session_tree` 只用已加载参数重置 cadence 计数器，不重新读取文件；无文件监听或每次工具调用的配置读取。lite 不使用预分词参数安排工作。检索方式是独立议题，本次没有加入嵌入模型配置或组合模式值。

**SDK 嵌入场景：** `getAgentDir()` 的目录覆盖只读取进程环境变量 `PI_CODING_AGENT_DIR`，不读取 `createAgentSession` 或资源加载器的 `agentDir` 选项。如果只通过 SDK `agentDir` 指定目录而未设置环境变量，扩展不会自动跟随该选项；应在加载扩展前设置 `PI_CODING_AGENT_DIR`，或直接用三个 `COMPACTION_RECALL_*` 环境变量控制配置。`process.cwd()`、`ctx.cwd` 与 SDK `agentDir` 可以不同，不会改变本扩展的配置来源。

lite 不额外注入隐藏历史提示，也不因此向模型服务商多发这类内容；但模型调用 grep/expand 后，工具返回的历史内容仍会随后续模型请求发送。它不是“历史绝不会发送给服务商”的隐私隔离开关。代价是模型要自行决定何时搜，以及搜索和核实的步骤；**不声称 lite 更快**。

归档评测里，等效 grep-only 组在多数对照中明显低于完整工具 / 自动提示组，例如 DEV8 grep-pages 为 3/8 对 8/8，HARD8 grep-pages 为 1/8 对 3/8；并非每组都更低，Sol/high 的两组均为 6/8。见 [历史结果](BENCHMARK_RESULTS.md)。当时使用的是冻结包装器，只保留 grep/expand、禁用自动提示，两个工具描述仍是 full 版文本；**不是用本次模式开关重新跑的结果**，也不能据此承诺普遍准确率差异。


## 工具与范围

full 建议流程：自动短索引 → `history_recall` 用当前问题或改写关键词定位相关 id → `history_expand` 核实原文 → 如果证据仍不足，再用 `history_grep` 补充。自动索引已经给出有用 id 时，也可以直接展开。lite 则由模型自行调用 `history_grep` 查找，再用 `history_expand` 核实；其工具描述和参数说明不提未注册的 recall 或定位提示。两种模式都由模型判断证据是否充足，没有人为的“足够证据”分数门槛，也不强制自动调用 grep。grep 实现仍是 JavaScript 正则，不是 SQLite / SQL LIKE，不新增数据库。

- `history_recall({ query, limit?, offset? })`：主要的主动检索入口，复用自动索引的词面候选与相关性排序，但使用独立分页：默认及上限均为 50 条，`offset` 默认 0。正文和 `details` 都返回 `total`（去重后的命中总数）、`offset`、`limit`、`returned`、`nextOffset`、`hasMore`；继续同一查询时传回 `nextOffset`，不能直接假设 `offset + limit`。每页以 16,000 个 Unicode 码点为保护预算，正常的 50 条短结果可放下，转义内容或很长的元数据可能使本页少于 50 条；下一页从未返回的那条继续，绝不跳过。极端情况下单条 id / 元数据本身超过预算，会单独返回该条并设置 `budgetExceeded: true`，保证 id 完整且翻页能前进。这个预算不是 token 承诺。分页在相同查询和未变化的当前分支上保持稳定；分支或压缩边界改变后应从 offset 0 重查，不提供持久分页快照。搜索当前分支已压缩的用户 / 助手正文，以及助手 `toolCall` 的工具名和输入参数；排除 `toolResult` 正文。返回真实 id、条目日期、角色和短片段。可以改写关键词再次查找；例如原文是 `bicycle repair`，查询 `cycling` 不保证命中，改用 `bicycle repair` 才有词面依据。没有语义同义词扩展，也没有“无命中就证明从未提过”的保证。
- `history_grep({ pattern, limit?, offset? })`：证据不足时的补充后备，搜索当前分支有效压缩历史中的用户 / 助手正文及助手 tool-call 名称 / 输入，排除 `toolResult`、thinking、图片；尊重 `context_edit`。大小写不敏感的 JavaScript `gi` 正则；非法 regex 回退为字面量，空 regex 保留 JS 零宽匹配语义。按分支顺序对**匹配 entry**分页：默认 `limit: 30`，最大 50，`offset` 默认 0；同一 pattern 和未变化分支下用 `nextOffset` 续页，改变编辑或压缩边界后从 0 重查。正文和 `details` 都给 `offset`、`returned`、`nextOffset`、`hasMore`；`returned` 是本页实际消费的匹配 entry 数（含显式跳过的超长 metadata），不是正则出现数；`total` 是所有原始 regex 匹配数，`totalEntries` 是匹配 entry 数。最多 30 条代表性片段行、每 entry 最多 3 个，完整输出最多 16,000 Unicode 码点。`covered` 是本次响应片段中完整可见的其他原始匹配数（仅本页片段）；`omitted = total - snippets - covered` 是本次响应任何片段都未展示的全局原始匹配数，包含前后其他页及超长 metadata 的遗漏，不记录或扣除之前响应读过的内容。正文页头也明确给出此全局口径。超长 metadata 只有在该 entry 实际被消费时才警告并计入遗漏，分页仍推进。长匹配可以裁切；片段对超出可见范围的匹配不计覆盖，空白折叠也不伪称覆盖。每条只展示代表性上下文，不保证展示所有 match 文本；用 `history_expand` 读取完整 entry，或用更窄 pattern 查找未展示上下文。无命中不证明历史从未提过。固定输出界限为每页最多 30 条片段行、每行最多 500 码点，连同固定页头 / 状态及保守的 32 位计数位数仍低于 16,000 码点；实现保留运行时预算检查。
- `history_expand({ id, before?, after?, offset? })`：按自动索引、recall 或 grep 的 id 展开原文；请求条目始终优先显示，前后邻居默认各 2 条、各可设 0–20。输出上限为 16,000 个 Unicode 码点；正文和 `details` 都返回请求条目的码点 `offset`、`total`、`returned`、`nextOffset`、`hasMore`。若 `hasMore: true`，对相同 id 和 before/after 传回 `nextOffset`，可逐页读完长条目；offset 超过正文长度时按正文末尾处理。只允许当前已压缩段里的 id，不读当前上下文或其他分支。
- 每次调用从 `ctx.sessionManager.getBranch()` 重新取当前分支。以最新 compaction 的原始 `firstKeptEntryId` 为界，仅暴露该条目之前的 message；尚未压缩则返回空。如果边界 id 缺失，沿用 spike 行为：选择最新 compaction 之前的消息。边界消息被省略时仍以它的原始位置划界，不把保留段误当作已压缩历史。
- 自动定位、recall、grep、expand（包括前后邻居）共用当前分支的 `context_edit` 投影：整条分支扫描，同一目标最后一次编辑生效；`replacement: null` 的条目不可检索或展开，替换条目只暴露替换内容，不回退到原文。字符串及合法文本块均支持，助手 / toolResult 的字符串按 Pi 1.0 归一化为文本块。压缩前后追加的编辑都生效；不修改原始条目，回到编辑之前或另一分支会恢复该分支的视图。编辑后手动分页应从 offset 0 重查。这里的“原文”指分支编辑生效后的正文，不是绕过编辑读取原始存储；仍不搜索 toolResult，但未省略的结果可展开.
- 自动定位、recall、grep 共用可搜索文本提取：用户 / 助手的字符串或 `type: text` 正文，加上助手 `toolCall` 的工具名和完整输入参数。参数以对象键排序的确定性 JSON 表示，不在提取阶段截断；空值安全，异常循环引用以 `[Circular]` 标记，无法序列化的异常对象有显式占位。不会把 thinking、图片内容、摘要或自定义消息加入搜索。`toolResult` 记录完全排除，空正则也不对它产生伪命中。这是对旧版 grep 搜索范围的有意修改，正则语法、排序和计数规则不变。
- `history_expand` 单独读取可读原文：可按 id 查看 `toolResult` 的文字结果，也包含助手工具调用名称 / 输入；仍排除 thinking / 图片。请求条目的分页 offset 以 Unicode 码点计数，不切断代理对；目标条目先返回，只有目标本页完整且邻居整条可放入剩余预算时才返回邻居。页状态会显示在模型可见文本中；继续时沿用 id、before、after 和 `nextOffset`。工具结果不会写进搜索索引，也不另存副本；Pi 已经删掉或省略的内容无法恢复。
- 只查当前分支，不跨会话、不跨 `parentSession`、不搜索被放弃的分支，也不搜索 compaction 摘要。

## 自动短定位索引（仅 full）

- 在 SDK 1.0.0 的异步 `context` hook 中运行：每次模型请求移除本扩展旧的定位消息，从实际 `event.messages` 找最后一条 `role: user` 的文字，查询当前分支的已压缩历史索引。已被消费的 steering / follow-up 消息因此也会成为新查询。不依赖 `input` 或 `before_agent_start`；每次取当前分支并检查原始条目引用，未变化时复用有效投影和索引。worker 尚未完成必要维护时等待就绪；只有 live 预分词、不改变可检索集合时可继续查询旧索引。
- 自动候选包括用户 / 助手正文和助手工具调用名称 / 输入；自动定位、recall、grep 都排除工具结果正文，只有 expand 可按 id 读取它。thinking、图片、摘要和自定义消息不进入搜索。最新用户消息只有图片或没有有效关键词时，不回退到更早的问题；无压缩、无匹配时不添加提示。
- 查询最多取前 4,000 个 Unicode 码点、24 个去重关键词。英文不区分大小写，保留代码标识符并拆出 `snake_case`、`camelCase`、`HTTPServer` 的词段；连续汉字用重叠双字词组，过滤一组常见中英文停用词。没有模型、embedding、词典分词或新依赖。
- 按不同查询词的覆盖评分，较少历史条目包含的词权重更高（`1 + log((文档数 + 1) / (含词文档数 + 1))`），重复堆词不会提高分数；同分时按覆盖词数、然后按分支条目新旧排序。先按 id 和相同片段（忽略空白差异）去重，确定性地保留分支中较新的代表，再计算相关性排序；自动提示先选前 5 条，最后应用长度预算，不用第 6 名以后回填。每条包括真实 entry id、条目日期、角色及最多 120 个 Unicode 码点的上下文片段（另可加省略号）：以本条匹配词中历史文档频率最低、信息权重最高的词为中心，约各取前后半个窗口；同频时选原文位置更早的词，靠近文本边缘时平移窗口，不切断 Unicode 代理对；整个提示含固定说明和元数据不超过 1,500 个 Unicode 码点。前 5 条里预算放不下的整行略过，绝不截断或捏造 id。
- 提示作为 `display: false` 的自定义消息紧随最后一条真实用户消息插入，仅改变本次请求上下文，不写进 session、不修改输入消息、不累积提示，也不拆开后续助手工具调用与结果。UI 隐藏并不等于隐私隔离：提示会随模型请求发送给当前配置的模型服务。
- 固定说明将片段标为不可信历史数据，而非指令或已验证答案，提示以 `history_recall` 改写关键词定位、用 `history_expand` 的 id 核实精确细节，证据不足时再用 `history_grep` 补充搜索。JSON 转义隔离换行、控制字符和提示分隔符；这降低结构混淆风险，但不能保证模型完全免受历史文本的提示注入影响。日期只是条目日期，不推断事件日期或原文属于哪条摘要。

离线测试只验证注册、边界、排序和上下文转换等机制，不证明检索质量或主模型回答准确率提升。已有真实 DEV8 / HARD8 三组对比、失败记录和父级审计见 [benchmark/README.md](BENCHMARK.md)；均为小样本、单轮描述性结果。本次归置没有重跑评测或进行在线模型调用。

这是词面提示，不是语义检索：同义词、单字中文、代词指代、拼写变体、无文字图片以及查询前 4,000 字之外的内容可能漏检；常见词和汉字交界双字也可能误匹配。没有提示不能证明历史没有该信息，提示也不强制模型执行回查。主线程仍要复制 / 校验当前分支、在变化时投影编辑和提取可搜索文本，并提交结构化克隆批次；分词、倒排维护、查询、去重排序和 recall 渲染在 worker 中执行。大对象参数提取、冷启动等待和内存副本仍有成本，不承诺实时性。

## 后台预分词与生命周期（仅 full）、可选计时

- 每个扩展实例最多一个活动 worker。`session_start` 按已加载配置重置计数器并安排预热；`session_compact` 刷新新增来源并启用已压缩 token；`session_tree` 清除旧分支代次、重置计数器并重建。两者均不重读配置。`session_shutdown` 取消待执行回调 / 请求并等待 worker 终止，适用于 quit、reload、new、resume、fork。
- 默认每 **10 轮完成的用户对话或 10 轮完成的工具调用批次**（先到先触发）预分词。用户 `message_end` 只记待完成标志，成功的 `agent_end` 才累计用户轮；工具轮在 `turn_end` 按已持久化 `messageEntryId` 去重，多个并行工具结果算一轮，已完成的错误工具结果也计入，aborted/error 助手轮不计。SDK 1.0.0 的 `message_end` 先于持久化，不能在此回调直接索引消息；`agent_end` 没有独立 error 字段。
- 未压缩文本只保留 worker token 缓存，不建影子倒排、不进入候选或 DF/N。压缩后直接激活缓存。预热与前台查询重叠时，不取消同一分支的有效前台查询；分支切换、编辑和代次失效仍会取消过期结果。
- 配置来自上述可选 agent 文件和三个环境变量，在扩展加载时统一固定；计数器阈值不随 cwd、文件或环境变量的后续变化而改变。调度一次时两个计数器一起清零，排队后的新活动保留给下一批。
- worker 启动失败、请求失败或中途退出时，同一实例使用共享同步扫描回退，不自动重启循环。下一次显式生命周期 reset 可以创建新 worker。同步扫描保持输出一致，但可能阻塞主线程。
- Pi 1.0.0 用 jiti 加载 `.ts` 扩展。worker URL 按原始源码文件定位 `src/index-worker.mjs`，不依赖 cwd 或编译缓存路径。worker 的整个依赖链都是原生 `.mjs`；历史投影、词法 / 渲染和计时分别在 `history.mjs`、`locator.mjs`、`timing.mjs`，主线程扫描与 worker 共用唯一实现。安装在 `node_modules` 下也不需要 TypeScript 加载 hook、宿主 jiti 别名或 warning 抑制。正常启动、查询与 shutdown 不向 stderr 输出。
- 仅设置 `COMPACTION_RECALL_TIMING_FILE=/absolute/private/path.jsonl` 才启用阶段日志；默认不读计时时钟、不写日志、不产生计时事件。日志不含正文、查询、片段、工具参数或凭据，文件权限 0600；日志失败不改变工具结果。阶段和父子 span 说明见 [TIMING.md](TIMING.md)，生命周期细节见 [BACKGROUND_INDEX.md](BACKGROUND_INDEX.md)。


## 文件

- `src/index.ts`：公开 Pi package 入口
- `src/recall-extension.ts`：三个工具及 context hook 注册、结果格式；替代加载入口
- `src/history.mjs`：无副作用的条目文本、压缩边界及正则辅助函数
- `src/locator.mjs`：词面定位、自动短索引预算、手动分页和非持久上下文转换
- `src/background-index.mjs` / `src/index-worker.mjs` / `src/inverted-index.mjs`：worker 协调、原生线程入口、倒排检索；失败回退共享扫描
- `src/preindex-cadence.mjs` / `src/recall-config.mjs`：双计数器，以及模式 / 预分词共用的 agent 配置加载函数
- `src/timing.mjs`：主线程和 worker 共用的可选计时、跨线程 span 合并与私有日志
- `test/locator.test.mjs`：自动定位与上下文生命周期回归测试
- `test/recall.test.mjs`：工具的离线行为与边界测试
- `test/production-worker.test.mjs`：生产分页 / 生命周期等价和真实 SDK 隔离加载 / 退出测试
- 共享 `.mjs` 使用 JSDoc 和 `@ts-check` 保留类型检查；`tsconfig.json` 的 `allowJs` 用于 TypeScript 入口消费这些模块，不是运行时转译设置。

## 离线验证

需要 Node 24+ 和 npm。在仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run check
```

安装依赖需要网络或已有 npm 缓存；`typecheck` 和 `test` 离线运行，不调用模型。测试覆盖扫描 / worker 自动输出和手动分页逐字节等价、编辑与分支恢复、压缩后缓存启用、DF/N 隔离、失败回退、节奏和计时开关。SDK 隔离检查覆盖计时关闭 / 开启、独立目录 / `node_modules` 安装布局，以及 package、`src/index.ts` 和兼容入口：启动、查询、shutdown 全程断言子进程 stderr 为空；计时开启时还必须实际产生 worker 线程查询 span，不能用静默回退冒充成功。只复制 `src/` 与 manifest，正常退出且不修改个人 profile。

## 来源与许可

提取自 `pi-lossless-context` 的工作区版本，基于提交 `62012df340d0774698ece6705062777b82d2f0e3`，包含当时尚未提交的 recall 整理。没有复制原仓库 Git 历史、会话、日志、凭据或数据库。

本项目采用 [MIT LICENSE](../LICENSE)，Copyright (c) 2026 shttty；上文的 recall-spike 提取来源仍予保留。[LongMemEval 评测来源与许可](../THIRD_PARTY_NOTICES.md#longmemeval-evaluation-material) 单独记录评测材料的 Copyright (c) 2024 Di Wu 及 MIT 文本，不替代本项目 LICENSE。已归档模型评测使用 ORIGINAL LongMemEval_M（原始 M），不是 cleaned、S 或 oracle-only 历史；仓内只保留选定评测摘录和输出，不包含完整外部数据集。合成离线 Node/Python 单元测试 fixture 属于另一类测试，并非全部源自 LongMemEval；包运行时不依赖该数据集，也不自动下载数据。

## 当前限制

grep 的正则行为和 expand 的边界 / 截断规则沿用 recall spike；搜索范围已按新需求纳入工具名 / 输入并排除 toolResult，不再与旧版检索语义完全相同。没有重新运行在线基准。手动正则扫描是线性的遍历，但正则本身没有执行超时，避免高回溯的复杂表达式。grep 结果仍按原文顺序，不按相关性排序。自动定位独立按相关性排序，但不自动调用工具。

- `history_expand` 原先对选中消息拼接后按 16,000 个 UTF-16 单元做头部截断，导致长前文挤掉目标、长目标尾部不可达且可能切断代理对。现在每页最多 16,000 个 Unicode 码点，目标优先，返回可见的页状态与码点 offset；模型可用 `nextOffset` 读取目标后续页。只有目标完整时才尝试加入完整邻居；未显示的邻居不会计入 `details.from/to`。grep 完整回复也最多 16,000 个 Unicode 码点，单行最多 500；匹配 entry 按原文顺序分页，最多 30 个片段 / 每 entry 3 个，单个片段对超长匹配仍会裁切。`covered` 只计当前响应片段真实覆盖的其他原始匹配，`omitted` 计全局未展示的原始匹配，包括不在当前页的命中；超长 metadata 仅在消费时明确警告并计为遗漏。代理对内多个 JS regex occurrence 即使映射到同一 Unicode 码点范围，也按独立 occurrence 统计。超长匹配被裁切的部分不计覆盖；空白折叠也不伪称覆盖。

历史实验设计和已完成结果统一见 [BENCHMARK.md](BENCHMARK.md)。生产 worker 的迁入不把历史扫描 / 同步索引跑分重标为新实现结果，也不代表检索或答题准确率提高。
