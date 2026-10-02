# pi-context-recall

[English](README.md) | [简体中文](README.zh-CN.md)

Pi 压缩长对话时，摘要留下大意，细节就丢了：一个名字、一个数字、你三小时前说过的原话。
**pi-context-recall** 让模型回到被压缩移出上下文的原始消息里，把这些细节重新找回来。

它建立在 Pi 原生压缩之上，不替换压缩，也不增加数据库、磁盘文件或额外的模型调用。

## 安装

需要 **Node.js 24+** 和 Pi（已验证 Pi SDK **1.0.0**）。

```sh
pi install git:github.com/shttty/pi-context-recall
```

从源码 checkout 临时试用一次，不改 settings：

```sh
pi -e ./src/index.ts
```

扩展只加载一份。

## 模式

| | `full`（默认） | `lite` |
| --- | --- | --- |
| 工具 | `history_recall`、`history_grep`、`history_expand` | `history_grep`、`history_expand` |
| 自动提示 | 有 | 无 |
| 后台索引 | 每个 session 一个 worker 线程 | 无 |

`lite` 只给模型检索工具，什么时候去查由模型自己决定。它不发送隐藏提示，但工具返回的内容仍会和其他工具输出一样发给模型服务。不声称它更快；在归档评测里，等效配置在多数对照中低于 `full`（见[评测](#评测)）。

### 配置

配置可选。文件位置是 `~/.pi/agent/extensions/pi-recall.json`（设置了 `PI_CODING_AGENT_DIR` 时在该目录下）：

```json
{
  "mode": "full",
  "preindex": {
    "userCycles": 10,
    "toolRounds": 10
  }
}
```

环境变量优先于文件，所以也可以完全不写文件：

| 变量 | 覆盖 | 取值 |
| --- | --- | --- |
| `PI_RECALL_MODE` | `mode` | `full` 或 `lite` |
| `PI_RECALL_PREINDEX_TURNS` | `preindex.userCycles` | 1–100 的整数，默认 10 |
| `PI_RECALL_PREINDEX_TOOL_ROUNDS` | `preindex.toolRounds` | 1–100 的整数，默认 10 |

`preindex` 只在 `full` 下有用：每完成 N 轮用户对话或 N 轮工具调用（先到先算），提前把还没压缩的消息分好词，压缩时直接可用。
配置在扩展加载时读一次，改完要重启 Pi。不读取项目里的 `.pi/` 目录。完整说明（包括 SDK 嵌入场景）见 [doc/PLUGIN.md](https://github.com/shttty/pi-context-recall/blob/main/doc/PLUGIN.md)。

## 工作方式

`full` 模式下，压缩之后每次请求最多经过三步：

1. **自动提示。** 模型回答前，扩展用你最新一条消息去匹配已压缩的历史，附上最多五个可能相关的条目 ID（不超过 1,500 字）。提示只对本次请求有效，不写入 session。
2. **`history_recall`。** 模型用自己的关键词再查一次，拿到排好序的条目 ID 和短片段。
3. **`history_expand`。** 模型按 ID 读完整正文和前后相邻的消息，确认具体细节。

还不够时，**`history_grep`** 可以在同一段历史上做正则搜索。`lite` 模式下，模型从 `history_grep` 开始查，再用 `history_expand` 核实。

扩展不强制调用工具，也不替模型判断证据够不够。片段只是线索，不是答案。

```js
history_recall({ query: "bicycle repair", limit: 10 })
history_expand({ id: "ENTRY_ID", before: 1, after: 1 })
history_grep({ pattern: "bicycle|repair", limit: 10 })
```

| 工具 | 返回 |
| --- | --- |
| `history_recall` | 按相关性排序并去重的条目 ID，附日期、角色和片段。每页默认及上限 50 条。仅 `full`。 |
| `history_expand` | 先给请求的条目，再给前后各 2 条邻居（可设 0–20）。每次最多 16,000 字。 |
| `history_grep` | 不区分大小写的 JavaScript 正则，非法正则按字面量处理。每页默认 30、最多 50 个匹配条目。 |

结果太长会分页。`hasMore` 为 true 时，带上返回的 `nextOffset` 和同样的查询再调一次，不要自己算 offset。预算按 Unicode 字符计，不是 token。完整工具约定见 [doc/PLUGIN.md](https://github.com/shttty/pi-context-recall/blob/main/doc/PLUGIN.md)。

## 限制

- **只查当前分支被压缩掉的部分。** 也就是最近一次压缩移出上下文的内容；不查当前上下文、其他 session、被放弃的分支或压缩摘要本身。还没压缩过就没有可查的东西。
- **关键词匹配，不是语义检索。** 同义词、代词、拼写变体和单个汉字可能查不到。查不到不代表没说过。
- **搜索用户和助手的文字，以及工具调用参数。** 不搜工具结果、thinking 和图片；不过 `history_expand` 可以按 ID 读出工具结果的文字。
- **遵守上下文编辑。** 改过的消息按改后内容读，隐藏的仍然隐藏；Pi 已删除的内容找不回来。
- **隐私。** `full` 的提示在界面上隐藏，但会随正常请求发给你的模型服务。旧消息会标记为不可信并转义，能降低提示注入风险，但不能消除。
- **开销。** `full` 在当前 session 的 worker 线程里维护一份内存索引，不写磁盘，也不跨 session 保留。分词和检索不占主线程，但主线程仍要提取文字再交给 worker，索引会额外占用内存，随分支变长而增长。启动或压缩后的第一次查询可能要等索引就绪。worker 出错时退回主线程扫描，结果相同。`lite` 不建索引，`history_grep` 和 `history_expand` 在调用时扫描已压缩的历史。

## 评测

题目来自 **[LongMemEval](https://github.com/xiaowu0162/LongMemEval)**（Di Wu 等，2024；MIT），用的是原始 **LongMemEval_M** 历史。选 M 是因为每条历史都超过一百万 token，约为这些评测所用 372k 上下文窗口的三倍，每道题都必须先经过真实的 Pi 压缩，正是这个扩展要处理的场景。

每条历史分四段喂给 Pi，触发三次原生压缩，然后再提问。用了两组各 8 题：

- **DEV8：** 证据只在被压缩的段里（单会话和时间推理题）。
- **HARD8：** 证据分散在至少两个被压缩的段里，8 题中 7 道是跨会话题。按难度挑选，不是随机抽样。

每道题从同一份压缩快照作答三次：只有 Pi、不给工具，加 `lite` 的工具组合，加 `full`。每格是 8 题里答对的数量。

| 集合 | 答题模型 | 只有 Pi | + `lite` | + `full` |
| --- | --- | --- | --- | --- |
| DEV8 | gpt-6-luna / high | 0 | 3 | 8 |
| HARD8 | gpt-6-luna / high | 0 | 1 | 3 |
| HARD8 | gpt-6.1-sol / high | 1 | 6 | 6 |

所有行用的是同一个插件版本（`8149e1f`），那时还没有 `lite`/`full` 开关，索引也还没搬进 worker。`lite` 列来自一个评测包装器：只注册 `history_grep` 和 `history_expand`，关闭自动提示（两个工具的描述仍是 `full` 版文字）；`full` 列用的是当时的同步扫描实现。离线测试会检查现在的 worker 返回的提示和 recall 分页与扫描版逐字节一致，但这些分数没有用当前代码重新测过。

HARD8 上 Luna 和 Sol 用同一份压缩快照作答，只换了答题模型；DEV8 没有跑 Sol。压缩用 gpt-6-luna / high；评分用 gpt-6-luna 和 LongMemEval 官方评分提示词。

**分数很大程度取决于答题模型。** 插件和快照都相同，HARD8 上 Sol 答对 6 题，Luna 答对 3 题。扩展只负责把压缩掉的历史重新够得着；找对条目、拼起证据、答对问题，仍要靠模型自己。Sol 只用 `lite` 的工具组合也答对 6 题，而且它的输出上限更小（8,192 对 128,000 token），模型、配置和服务商的影响没有拆开。不要把这个差距当成扩展本身的效果。

这些是开发期间归档的单轮结果，题目少且经过挑选，不是针对当前版本的评测。`full` 在每一轮都不低于只有 Pi 的情况，但每组只有 8 题，不能证明通用准确率或因果效果。

题目 ID、选题规则、评分设置、其他插件版本的早期轮次、被排除的轮次和审计 hash 见 [doc/BENCHMARK_RESULTS.md](doc/BENCHMARK_RESULTS.md)。仓库不包含 LongMemEval 数据本身。

## 开发

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

测试离线运行，使用合成 fixture。真实跑评测需要显式的外部配置，见[评测说明](https://github.com/shttty/pi-context-recall/blob/main/doc/EVALUATION.md)。

## 许可

MIT，Copyright (c) 2026 shttty。见 [LICENSE](LICENSE)。

LongMemEval 的来源说明和 MIT 声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md#longmemeval-evaluation-material)。
