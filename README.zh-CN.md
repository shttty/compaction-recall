# pi-context-recall

[English](README.md) | [简体中文](README.zh-CN.md)

面向 Pi 原生压缩历史的词面回查扩展。
**自动定位索引 → `history_recall` → `history_expand` → 证据不足时用 `history_grep`。**
只读取当前分支，不接管压缩，不增加数据库、后台任务或模型调用。

## 安装与试用

需要 **Node.js 24+** 和 Pi；已验证 Pi SDK **1.0.0**。Pi SDK 与 TypeBox 由宿主提供。

作为 Pi package 安装（会更新 Pi settings）：

```sh
pi install npm:pi-context-recall
```

仅在本次调用中试用，不将包永久写入 settings（Pi 仍可能下载或缓存包）：

```sh
pi -e npm:pi-context-recall
```

在源码 checkout 根目录试用本地入口：

```sh
pi -e ./src/index.ts
```

只加载一份扩展。package 入口是 `src/index.ts`，无需根目录兼容入口。
以上是使用方法，不表示 0.1.0 已经发布。

## 工作流程

1. 原生压缩后，`context` hook 根据实际请求中最后一条用户文字，生成简短、按相关性排序的定位提示。
2. 主模型可调用 `history_recall`，以聚焦关键词或改写后的措辞定位 entry ID。
3. `history_expand` 按 ID 阅读当前分支编辑生效后的正文，核实精确细节；自动提示已有有用 ID 时可以直接展开。
4. 证据仍不足时，`history_grep` 对相同可搜索历史提供正则后备检索。

扩展不强制调用工具，也不自行判断证据是否充足。片段是线索，不是已经核实的答案。
自动提示最多选择五个候选，连同元数据不超过 **1,500 个 Unicode 码点**。
提示仅在本次请求中插入最后一条用户消息之后，不写入 session，也不跨请求累积。
虽然 UI 隐藏提示，它仍会作为正常模型请求的一部分发送给当前配置的模型服务。
历史文字会被标记为不可信数据并转义，但这不能消除提示注入风险。

### 工具示例

以下是供模型调用的工具，不是 shell 命令。请将 `ENTRY_ID` 换成工具实际返回的 ID。

```js
history_recall({ query: "bicycle repair", limit: 10 })
history_expand({ id: "ENTRY_ID", before: 1, after: 1 })
history_grep({ pattern: "bicycle|repair", limit: 10 })
```

当 `hasMore` 为 true 时，将返回的 `nextOffset` 作为下一次 `offset`，保持查询词、pattern 或 ID 及邻居设置不变。
不要自行计算 `offset + limit`：输出预算可能使一页不足 limit 条。分支、编辑或压缩边界改变后，从 offset 0 重新查询。

| 工具 | 检索与输出约定 |
| --- | --- |
| `history_recall` | 返回按相关性排序并去重的 ID、条目日期、角色与片段；默认及上限均为 50 条。`total` 是去重后的命中数。每页目标预算为 16,000 码点；单条元数据过长时单独返回并标记 `budgetExceeded: true`，不丢失 ID。 |
| `history_expand` | 请求条目优先；前后邻居默认各 2 条，各可设为 0–20。每次回复最多 16,000 码点。`offset`、`total`、`returned`、`nextOffset`、`hasMore` 描述请求条目的正文，不是邻居数量。只有目标本页完整后，才尝试放入完整邻居。 |
| `history_grep` | 不区分大小写的 JavaScript `gi` 正则，非法正则回退为字面量。按分支顺序对匹配 entry 分页，默认 30、最大 50 条。每次最多 30 行片段、每 entry 最多 3 行，完整输出最多 16,000 码点；匹配内容可能被裁切。 |

工具可见正文与结构化 `details` 都提供分页信息。预算单位是 Unicode 码点，**不是 token**。
grep 的 `total` 是原始正则匹配数，`totalEntries` 是匹配 entry 数，`returned` 是实际消费的 entry 数，包含明确跳过的超长元数据条目。
`covered` 是本次片段中完整可见的其他原始匹配数；`omitted` 是本次回复未展示的全部原始匹配数，包含其他页，而不是跨调用追踪的“尚未读过”数量。
grep 不是 SQL LIKE，也没有正则执行超时；请避免高回溯表达式。

## 范围与限制

- **只查当前分支已压缩的历史。** 以最新 compaction 的原始 `firstKeptEntryId` 为界；尚未压缩则无历史可查。边界 ID 缺失时，使用最新 compaction 之前的消息。
- 不跨 session、`parentSession` 或被放弃的分支，不搜索当前保留上下文或 compaction 摘要。
- 自动定位、recall 和 grep 搜索用户／助手文字及助手 tool-call 名称与输入参数，**不搜索 `toolResult` 正文**、thinking、图片或自定义消息。
- Expand 可按 ID 阅读尚可用的 `toolResult` 文字，仍排除 thinking 和图片；无法恢复 Pi 已删除或省略的内容。
- 所有路径都遵守归一化后的分支内 `context_edit`：同一目标最后一次编辑生效，`replacement: null` 隐藏条目，替换内容遮蔽原文。支持字符串及合法文本块；助手／工具结果字符串按 Pi 1.0 归一化为文本块。展开及邻居使用同一视图，“原文”不表示绕过编辑读取旧内容。
- 这是**词面检索，不是语义检索**。查询最多取前 4,000 码点和 24 个不同关键词，支持英文标识符拆词及中文重叠双字词组。同义词、代词、单字中文、拼写变体及纯图片证据可能漏检；无命中不证明历史中没有信息。
- 不增加数据库、embedding、持久索引、生产缓存、后台 worker、compaction hook 或额外模型调用。每次请求在本地扫描分支编辑及已压缩文字；大会话会增加本地处理成本。

## 验证

以下是**已观察到的离线检查**，不是在线推理，也不能证明回答准确率提高：

| 验证面 | 已观察结果 | 边界 |
| --- | --- | --- |
| TypeScript + Node | `npm run check`：类型检查及 **99 项 Node 测试通过** | 含 5 项 SDK 检查：descriptor、网络防护下的 native RPC、只读认证；隔离加载 package 及两个 `src/` 入口。 |
| Python runner | **15 项 Python 测试通过** | 两套显式合成配置覆盖 CLI → run → answer → RPC、三组、零调用续跑、配置变更拒绝，并在网络防护下真实启动三组 SDK `get_state`；没有真实模型调用。 |
| 清洁副本复验 | 锁定依赖 `npm ci --ignore-scripts` 后，**99 项 Node + 15 项 Python 测试通过** | 临时目录只复制拟提交源码；不复制原 `node_modules`、Git 历史、外部 helper、profile 或数据。 |
| npm 产物 | Dry-run 及实际 tarball 均为 **11 个白名单文件**，无捆绑依赖；现有 SDK 加载用例通过 | 隔离解析 package manifest 及两个 `src/` 入口，实际执行 context hook 和三个工具；排除原始 benchmark 证据、测试及个人配置。这是本地打包验证，不是已发布声明。 |

从 checkout 重复开发检查（还需要 Python 3 和 Git）：

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

安装依赖需要网络或 npm 缓存。测试使用隔离的合成 fixture，不依赖个人 profile 或凭据。
真实评测需要另行授权并显式提供外部配置；下方历史模型标识只是证据，不是运行默认值。

## 历史基准观测

以下是已归档的单轮 **LongMemEval_M** 结果，**不是 0.1.0 的新跑分**。
DEV8／HARD8 各有 8 条历史；每格均为 8 题中的正确数，顺序固定为 **native / grep / production**。
“Production”是历史实验组名称，不表示该 commit 就是本次发布版本。
Native 基线不加载工具／扩展；grep 使用固定版本的 grep/expand wrapper 并关闭 context hook；production 加载公开入口，包含自动定位及 recall/grep/expand。

| 集合／轮次 | 答题模型／effort | 候选 commit | Native / grep / production |
| --- | --- | --- | --- |
| DEV8 capacity-base | `clp/gpt-6-luna` / high | A | 0 / 5 / 7 |
| DEV8 capacity-paging | `clp/gpt-6-luna` / high | B | 0 / 6 / 8 |
| DEV8 coverage | `clp/gpt-6-luna` / high | C | 0 / 4 / 7 |
| DEV8 grep-pages | `clp/gpt-6-luna` / high | D | 0 / 3 / 8 |
| HARD8 base | `clp/gpt-6-luna` / high | A | 1 / 1 / 3 |
| HARD8 paging | `clp/gpt-6-luna` / high | B | 0 / 1 / 2 |
| HARD8 grep-pages | `clp/gpt-6-luna` / high | D | 0 / 1 / 3 |
| HARD8 sol-high-d4259198 | `clp/gpt-6.1-sol` / high | D | 1 / 6 / 6 |

历史 base A：`f5715d1901b6bedf19811030f18f3733eefb7bc4`；paging B：`7d1980b8b7512ec8568c3ddaaecdccb8e0ad4014`；coverage C：`5acf40efa9cb33146d3e9526fc411a769511cee8`；grep-pages D：`8149e1f6caece71de148c92a88790e5d35212d9e`。
八组均使用 SDK 1.0.0，以 `clp/gpt-6-luna` / high 压缩。这些小样本、单轮观测不能建立因果关系或证明通用准确率；不同候选是不同答题轮次，HARD8 paging 还低于 base。

冻结 manifest 记录 judge 为 `clp/gpt-6-luna`、**请求 xhigh**。历史评分调用外部 helper，而不是 Pi SDK；保留证据不能确定 provider 实际生效的 judge effort，因此不声称 SDK 将其降为 high。
另一次未计分的 SDK 1.0.0 准备检查请求 Sol **xhigh**，但本地回环 mock 捕获到序列化后的 **high**，真实调用为零。这次降档不是 xhigh 跑分；表中正式 Sol 轮次明确使用 high。下方聚合说明记录了该证据的 hash。

完整组别身份、runner commit、judge 配置、失败和排除的 pilot 见随包提供的[基准结果与来源](doc/BENCHMARK_RESULTS.md)。
[源码评测索引](https://github.com/shttty/pi-context-recall/blob/main/doc/BENCHMARK.md)及原始证据位于 **私有** GitHub 仓库，需要访问权限，并非公开可访问的证据链接。

## 许可与来源

**MIT — Copyright (c) 2026 shttty.** 见 [LICENSE](LICENSE)。
独立提取自 `pi-lossless-context` 的 recall 实验；第三方设计来源与许可文本保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
仅源码仓库提供的详细[插件说明](https://github.com/shttty/pi-context-recall/blob/main/doc/PLUGIN.md)和[评测协议](https://github.com/shttty/pi-context-recall/blob/main/doc/EVALUATION.md)需要仓库访问权限。
