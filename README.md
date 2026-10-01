# pi-recall

Pi 原生压缩之后，自动给主模型一份与当前用户消息有关的短定位索引，再用 `history_recall` 主动定位、`history_expand` 核实原文；证据不足时用 `history_grep` 补充检索当前分支被压掉的原文。独立的小扩展，不加载主插件 `src/`，不接管压缩，不新增 SQLite、FTS、向量索引、后台任务或模型调用。已验证宿主 SDK：1.0.0。

本仓库从 `pi-lossless-context/prototype/recall-spike` 独立提取。原有 grep / expand 工具保留语义，新增的自动定位与 history_recall 不接管压缩；所有相对导入都在本仓库内，不依赖原项目。原项目目录和 benchmark 兼容入口保留在原处。`FINDINGS.md` 是历史实验结果，不是本次整理后重新跑分的结论。

## 加载

在仓库根目录临时加载，不改 profile：

```sh
pi -e ./index.ts
```

也可以将整个目录作为本地 Pi package 安装；这会修改用户的 Pi settings，需要你自己决定执行：

```sh
pi install /absolute/path/to/pi-recall
```

`package.json` 的 `pi.extensions` 指向 `index.ts`。本仓库也支持 `pi -e ./recall-extension.ts`。两个入口只选一个，避免重复注册。宿主提供 Pi SDK 和 `typebox`，不捆绑另一套 SDK；开发和测试使用本仓库 `package-lock.json` 锁定的依赖（Pi SDK 1.0.0）。本次没有安装到任何个人 profile，也没有发布包。

## 工具与范围

建议流程：自动短索引 → `history_recall` 用当前问题或改写关键词定位相关 id → `history_expand` 核实原文 → 如果证据仍不足，再用 `history_grep` 补充。自动索引已经给出有用 id 时，也可以直接展开。由主模型判断证据是否充足，扩展没有人为的“足够证据”分数门槛，也不强制自动调用 grep。grep 的定位类似底层文本搜索后备，但实现仍是 JavaScript 正则，不是 SQLite / SQL LIKE，不新增数据库。

- `history_recall({ query, limit?, offset? })`：主要的主动检索入口，复用自动索引的词面候选与相关性排序，但使用独立分页：默认及上限均为 50 条，`offset` 默认 0。正文和 `details` 都返回 `total`（去重后的命中总数）、`offset`、`limit`、`returned`、`nextOffset`、`hasMore`；继续同一查询时传回 `nextOffset`，不能直接假设 `offset + limit`。每页以 16,000 个 Unicode 码点为保护预算，正常的 50 条短结果可放下，转义内容或很长的元数据可能使本页少于 50 条；下一页从未返回的那条继续，绝不跳过。极端情况下单条 id / 元数据本身超过预算，会单独返回该条并设置 `budgetExceeded: true`，保证 id 完整且翻页能前进。这个预算不是 token 承诺。分页在相同查询和未变化的当前分支上保持稳定；分支或压缩边界改变后应从 offset 0 重查，不提供持久分页快照。搜索当前分支已压缩的用户 / 助手正文，以及助手 `toolCall` 的工具名和输入参数；排除 `toolResult` 正文。返回真实 id、条目日期、角色和短片段。可以改写关键词再次查找；例如原文是 `bicycle repair`，查询 `cycling` 不保证命中，改用 `bicycle repair` 才有词面依据。没有语义同义词扩展，也没有“无命中就证明从未提过”的保证。
- `history_grep({ pattern })`：证据不足时的补充后备，搜索范围与自动定位 / recall 一致（正文及工具名 / 输入，排除工具结果）；大小写不敏感的 JavaScript 正则；支持 `SF|San Francisco`。正则无效时按字面量搜索。按会话顺序返回 entry id、日期、角色及片段；最多 30 个片段，每条 entry 最多 3 个，仍统计全部匹配次数。空正则遵循 JavaScript 的零宽匹配语义。
- `history_expand({ id, before?, after? })`：按自动索引、recall 或 grep 的 id 展开原文文本及前后消息；前后默认各 2 条，各可设 0–20。只允许当前已压缩段里的 id，不读当前上下文或其他分支。
- 每次调用从 `ctx.sessionManager.getBranch()` 重新取当前分支。以最新 compaction 的 `firstKeptEntryId` 为界，仅扫描该条目之前的 message；尚未压缩则返回空。如果边界 id 缺失，沿用 spike 行为：扫描最新 compaction 之前的消息。
- 自动定位、recall、grep 共用可搜索文本提取：用户 / 助手的字符串或 `type: text` 正文，加上助手 `toolCall` 的工具名和完整输入参数。参数以对象键排序的确定性 JSON 表示，不在提取阶段截断；空值安全，异常循环引用以 `[Circular]` 标记，无法序列化的异常对象有显式占位。不会把 thinking、图片内容、摘要或自定义消息加入搜索。`toolResult` 记录完全排除，空正则也不对它产生伪命中。这是对旧版 grep 搜索范围的有意修改，正则语法、排序和计数规则不变。
- `history_expand` 单独读取可读原文：可按 id 查看 `toolResult` 的文字结果，也包含助手工具调用的名称 / 输入，便于验证搜索到的参数；仍排除 thinking / 图片。输出继续沿用 16,000 个 UTF-16 单元的截断限制。工具结果不会写进搜索索引，也不另存副本；Pi 已经删掉或省略的内容无法恢复。
- 只查当前分支，不跨会话、不跨 `parentSession`、不搜索被放弃的分支，也不搜索 compaction 摘要。

## 自动短定位索引

- 在 SDK 1.0.0 的 `context` hook 中运行：每次模型请求先移除本扩展旧的定位消息，从实际 `event.messages` 找最后一条 `role: user` 的文字，再扫描当前分支的已压缩原文。已被消费的 steering / follow-up 消息因此也会成为新查询。不依赖 `input` 或 `before_agent_start`，不记录查询状态、不缓存、不启动后台工作。
- 自动候选包括用户 / 助手正文和助手工具调用名称 / 输入；自动定位、recall、grep 都排除工具结果正文，只有 expand 可按 id 读取它。thinking、图片、摘要和自定义消息不进入搜索。最新用户消息只有图片或没有有效关键词时，不回退到更早的问题；无压缩、无匹配时不添加提示。
- 查询最多取前 4,000 个 Unicode 码点、24 个去重关键词。英文不区分大小写，保留代码标识符并拆出 `snake_case`、`camelCase`、`HTTPServer` 的词段；连续汉字用重叠双字词组，过滤一组常见中英文停用词。没有模型、embedding、词典分词或新依赖。
- 按不同查询词的覆盖评分，较少历史条目包含的词权重更高（`1 + log((文档数 + 1) / (含词文档数 + 1))`），重复堆词不会提高分数；同分时按覆盖词数、然后按分支条目新旧排序。先按 id 和相同片段（忽略空白差异）去重，确定性地保留分支中较新的代表，再计算相关性排序；自动提示先选前 5 条，最后应用长度预算，不用第 6 名以后回填。每条包括真实 entry id、条目日期、角色及最多 120 个 Unicode 码点的上下文片段（另可加省略号）：以本条匹配词中历史文档频率最低、信息权重最高的词为中心，约各取前后半个窗口；同频时选原文位置更早的词，靠近文本边缘时平移窗口，不切断 Unicode 代理对；整个提示含固定说明和元数据不超过 1,500 个 Unicode 码点。前 5 条里预算放不下的整行略过，绝不截断或捏造 id。
- 提示作为 `display: false` 的自定义消息紧随最后一条真实用户消息插入，仅改变本次请求上下文，不写进 session、不修改输入消息、不累积提示，也不拆开后续助手工具调用与结果。UI 隐藏并不等于隐私隔离：提示会随模型请求发送给当前配置的模型服务。
- 固定说明将片段标为不可信历史数据，而非指令或已验证答案，提示以 `history_recall` 改写关键词定位、用 `history_expand` 的 id 核实精确细节，证据不足时再用 `history_grep` 补充搜索。JSON 转义隔离换行、控制字符和提示分隔符；这降低结构混淆风险，但不能保证模型完全免受历史文本的提示注入影响。日期只是条目日期，不推断事件日期或原文属于哪条摘要。

离线测试只验证注册、边界、排序和上下文转换等机制，不证明检索质量或主模型回答准确率提升；是否有实际收益尚需基于真实任务的消融对比。本次没有进行该效果评估或在线模型调用。

这是词面提示，不是语义检索：同义词、单字中文、代词指代、拼写变体、无文字图片以及查询前 4,000 字之外的内容可能漏检；常见词和汉字交界双字也可能误匹配。没有提示不能证明历史没有该信息，提示也不强制模型执行回查。每次请求重新线性扫描已压缩文本，再排序命中条目，大会话会增加本地处理成本。

## 文件

- `index.ts`：公开 Pi package 入口
- `recall-extension.ts`：三个工具及 context hook 的注册、结果格式；兼容 benchmark 旧入口
- `history.ts`：无副作用的条目文本、压缩边界及正则辅助函数
- `locator.ts`：无状态词面定位、自动短索引预算、手动分页和非持久上下文转换
- `test/locator.test.mjs`：自动定位与上下文生命周期回归测试
- `test/recall.test.mjs`：离线行为与独立目录加载测试

## 离线验证

需要 Node 24+（本次 Node 24.19.0）和 npm。在本仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run check
```

安装依赖需要网络或已有 npm 缓存；`typecheck` 和 `test` 离线运行，不调用模型。测试覆盖 grep / expand 的原有行为、history_recall 与自动定位的一致性、自动定位边界和上下文生命周期，并通过 Pi SDK 从临时隔离目录加载 package、`index.ts` 和兼容入口。隔离目录只包含运行时文件和 manifest，不含 node_modules 或 Git 数据，测试后删除；不修改用户 profile。

## 来源与许可

提取自 `pi-lossless-context` 的工作区版本，基于提交 `62012df340d0774698ece6705062777b82d2f0e3`，包含当时尚未提交的 recall 整理。没有复制原仓库 Git 历史、会话、日志、凭据或数据库。

原项目未提供适用于自身代码的 LICENSE，本仓库未擅自指定开源许可证。`THIRD_PARTY_NOTICES.md` 保留原项目的 hermes-lcm 设计来源及其 MIT 声明；该声明不等于本仓库自身采用 MIT。公开发布或分发前应由维护者确认代码授权及本仓库许可证。

## 当前限制

grep 的正则行为和 expand 的边界 / 截断规则沿用 recall spike；搜索范围已按新需求纳入工具名 / 输入并排除 toolResult，不再与旧版检索语义完全相同。没有重新运行在线基准。手动正则扫描是线性的遍历，但正则本身没有执行超时，避免高回溯的复杂表达式。grep 结果仍按原文顺序，不按相关性排序。自动定位独立按相关性排序，但不自动调用工具。

展开输出沿用 16000 个 UTF-16 单元的头部截断，并附 `[truncated]`，还没有分页；可能切断代理对。很长的前文可能挤掉请求条目，先用 `before: 0, after: 0` 聚焦，但单条长文本尾部仍不可达。`details.from/to` 表示选中的消息范围，不保证截断后全部可见。grep 的匹配计数是完整计数，片段本身没有全局字符上限，特别长的正则匹配可能产生很大的片段。后续若修这些限制，应单独做行为变更与基准验证。

## 压缩时索引原型实验

`prototype/README.md` 记录了 DEV8 真实单题 `577d4d32` 的扫描 / 内存倒排索引对比，以及可复现脚本和原始结果。该实验未替换生产扫描，也未新增生产持久化；速度结果只适用于这次语料和方法，不代表主模型答题准确率提升。

## 项目级工具链验证 skill

`.agents/skills/recall-tool-validation/SKILL.md` 提供可复用的逻辑检查、全新上下文盲测 solver 和作答后评审流程。入口为 `prototype/blind-harness.mjs`，复用真实 context hook 与三个工具的 execute 函数；`single` / `stacked` 使用已有真实语料，不自动下载或调用外部模型。当前机械验证见 `prototype/BLIND_VALIDATION.md`；机械通过不等于已完成盲测或真实 Pi 模型评测。

## 本地 reranker 对比

`prototype/RERANK.md` 记录纯 grep、grep + recall 机械排序，以及相同候选池上的本地 mMiniLMv2 / Qwen3 reranker 对比。候选先去重再排序 / 限额；神经模型仍是隔离原型，不接入生产扩展。主语料为英文，少量中文样例只用于运行检查，不代表多语言质量已得到验证。

## 真实 Pi DEV8 与阶段耗时

`prototype/PI_DEV8.md` 记录 Pi 0.99.1 / gpt-6-luna high 的三组真实答题结果与端到端耗时；`prototype/TIMING.md` 说明后续加入的分阶段计时。历史缺失的首字、工具细分耗时不会补造。该已完成跑分使用的是同步索引版本。后续 worker / 每5轮批量预索引优化见 `prototype/BACKGROUND_INDEX.md`：真实后台线程处理重活，保留主线程传输开销和未就绪等待的说明；生产入口仍使用扫描。
