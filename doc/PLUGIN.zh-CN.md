# 配置与行为参考

[English](PLUGIN.md) | [简体中文](PLUGIN.zh-CN.md)

compaction-recall 目前支持 Pi，不替换宿主的压缩机制，不持久化索引，也不额外调用模型。安装与快速介绍见 [README](../README.zh-CN.md)。

公开入口为 `src/index.ts`，`src/recall-extension.ts` 是替代兼容入口。每次只加载一个。两者只负责导出或装配组件。`tools/` 定义 recall/grep/expand 的描述、schema 和执行逻辑。`extension/` 处理单次配置读取、索引生命周期与预热、自动上下文，以及共享的分支和计时操作。

`history/` 处理分支投影与定位，`search/` 处理查询与 SQLite 检索。`worker/` 处理后台调度，直接运行纯 mjs worker，无需 TS worker loader。`observability/` 处理 timing/trace。每次扩展加载时，配置、trace、index 和 cadence 各最多初始化一次。评测源码职责和命令见 [运行指南](benchmark.zh-CN.md)。

## 选择模式

| 行为 | `full`（默认） | `lite` |
|---|---|---|
| 工具 | `history_recall`、`history_grep`、`history_expand` | `history_grep`、`history_expand` |
| 自动提示 | 回答前提供相关历史的短片段和条目 ID，用 `<compacted-history-hints>` 包裹，便于模型与用户原话区分 | 不添加自动提示 |
| 检索索引 | Node worker 中的 SQLite FTS5 内存库 | 不创建索引或 worker |
| 预热 | 在会话切换、压缩和配置的交互节奏下维护索引 | 无预热 |
| 可选计时 | 索引、查询和工具调用 | grep / expand 工具调用 |

两种模式都由模型决定是否继续查找和展开。`lite` 不等于隐私隔离：主动调用工具返回的历史仍会进入模型上下文，也可能发送给模型服务商。

## Pi 配置文件

配置文件路径为 `$PI_CODING_AGENT_DIR/extensions/compaction-recall.json`，默认是 `~/.pi/agent/extensions/compaction-recall.json`。需要时手动创建，插件不会自动生成。没有文件时使用默认值或环境变量。所有配置项都可省略。

```json
{
  "mode": "full",
  "jieba": true,
  "autoGate": 280,
  "snippetBudget": 240,
  "recallTimeoutMs": 5000,
  "trace": false,
  "preindex": {
    "userCycles": 10,
    "toolRounds": 10
  }
}
```

配置在扩展加载时读取一次，修改后需要重载。环境变量优先于文件；插件不读取项目目录下的配置文件。`PI_CODING_AGENT_DIR` 是 Pi 的宿主设置，不是插件配置项。通过 Pi SDK 嵌入扩展时，也应在加载前设置它；仅传入 SDK 的 `agentDir` 选项不会改变插件的配置查找位置。

| 配置项 | 默认值 | 作用与取值 | 环境变量覆盖 |
|---|---|---|---|
| `mode` | `"full"` | 选择 `full` 或 `lite`。 | `COMPACTION_RECALL_MODE` |
| `jieba` | `true` | 用中文长词命中重排已有检索候选，不增加候选；文件用布尔值，环境用 `on` / `off`。 | `COMPACTION_RECALL_JIEBA` |
| `autoGate` | `280` | 用户消息超过此加权长度时跳过自动提示，主动调用工具不受影响；正安全整数。 | `COMPACTION_RECALL_AUTO_GATE` |
| `snippetBudget` | `240` | 自动提示和主动 recall 中，每条原文片段的加权长度预算；正安全整数。 | `COMPACTION_RECALL_SNIPPET_BUDGET` |
| `recallTimeoutMs` | `5000` | 主动 recall 的协作式超时门槛，单位毫秒；正安全整数。 | `COMPACTION_RECALL_QUERY_TIMEOUT_MS` |
| `preindex.userCycles` | `10` | 完成多少轮用户交互后预热，范围 `1` 至 `100`。 | `COMPACTION_RECALL_PREINDEX_TURNS` |
| `preindex.toolRounds` | `10` | 完成多少批工具调用后预热，范围 `1` 至 `100`；同批并行调用只计一次。 | `COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS` |
| `trace` | `false` | 记录带内容的检索诊断，须同时指定计时文件；仅接受布尔值。 | 无，仅文件配置 |

加权长度按汉字计 2、其余 Unicode 码点计 1。两个预热门槛满足任一即触发。检索、预热和 trace 配置只对 `full` 生效；两种模式都可使用计时日志。

### 配置错误如何处理

- 文件不存在时静默使用环境变量或默认值。文件不可读、JSON 格式错误或超过 65,536 字节时，忽略文件并警告；未知字段忽略并警告。
- 数值环境变量必须是十进制整数字符串。`autoGate`、`snippetBudget`、`recallTimeoutMs` 的非法值回退默认值；非法环境覆盖不会重新采用文件值。
- 预热环境变量无效时，保留有效的文件值，否则使用默认值。
- `mode` 的非法环境覆盖回退 `full`；`jieba` 的非法环境覆盖回退开启；非法 `trace` 值回退关闭。诊断不会打印非法配置值的内容。

## 自动历史提示

`full` 根据最近一条真实用户消息搜索当前分支的已压缩历史，提供最多 5 条定位提示，总显示预算为 1,500 Unicode 码点。没有文字、可搜索词项、已压缩历史或命中结果时，不添加提示。

默认 `autoGate=280`：加权长度等于 280 时仍允许自动查询，超过时跳过。较长消息被视为长任务指示，避免无关历史挤进上下文；模型仍可主动使用检索工具。

提示只用于当前模型请求，不写入会话历史，也不会逐轮累积。提示提供查找线索，可能遗漏相关事实；重要结论应展开原文核对。

## 工具行为

### `history_recall`：词面检索

只在 `full` 中提供。通过概念组指定要查找的内容、可替换措辞和排除词。检索按词面匹配，不做语义搜索。

- `concepts` 接受 1 至 5 组，每组 1 至 4 个替代词面。组内满足任一即可；`match="all"` 要求每组在同一记录中命中，默认 `"any"` 只要求命中一组。多词命中不保证原文中的顺序或相邻关系。
- `exclude` 最多 5 个词面，匹配的记录会被排除，不参与片段选择或 jieba 排名。词面不是 SQL、FTS MATCH 语法或正则表达式。
- 每个词面去除首尾空白后须非空，最多 256 Unicode 码点，总计最多 2,048。
- 分词损失部分有效字符时，会继续搜索剩余词项并返回警告；完全没有可搜索词项时会报错。recall 不会暗中切换到 grep，必要时由模型换词或主动调用 grep。
- `limit` 默认及上限均为 50，`offset` 默认 0。结果包含条目 ID、原文片段、总数和 `nextOffset`；相同查询、分支未变化时可继续翻页。

索引使用英文词干和汉字双字。FTS 决定候选，规范化全文相同的记录会去重。启用 jieba 后，先按命中的不同中文长词数量排序，再按 BM25 及新旧顺序排序，最后分页。jieba 仅重排已经命中的记录，不做同义词扩展，也不会找回未命中的记录。

如果 worker 加载不了 jieba 原生绑定（例如 OMP 编译版扩展宿主解析不到平台绑定包），插件会向 stderr 写一条警告，改用运行时内置的 `Intl.Segmenter` 切长词排名。它的词边界比 jieba 粗，得到的长词更少，但候选与分页行为不变。

自动查询通常使用汉字双字词项，未必含有可参与 jieba 排名的长词，因此开关 jieba 不保证每次自动提示都会改变。

### `history_grep`：正则搜索

两种模式都提供。`pattern` 是不区分大小写的 JavaScript 正则表达式；语法无效时按字面文本搜索，不是 SQL LIKE。

按匹配记录的分支顺序分页，`limit` 默认 30、最多 50，`offset` 默认 0。每页最多展示 30 个代表片段，每条记录最多 3 个；正文输出上限为 16,000 Unicode 码点。匹配次数与匹配记录数不同，片段没有展示的内容可通过 `history_expand` 查看。

grep 没有正则执行超时，避免可能产生灾难性回溯的复杂表达式。

### `history_expand`：展开原文

两种模式都提供。按 `id` 读取目标条目，可用 `before` / `after` 附带相邻条目，默认各 2 条，范围 `0` 至 `20`。

目标正文优先显示，每页上限为 16,000 Unicode 码点；只有目标完整显示后，才加入能完整容纳的邻居。长条目用返回的 `nextOffset` 继续读取，偏移单位为 Unicode 码点。它可展开可读的工具结果，但不展示思考内容或图片。

翻页时保持查询、目标 ID 及相关参数不变。发生编辑、压缩或分支切换后，应从第一页重新查询。

## 范围、索引与超时

- 只读取当前分支最近一次压缩边界之前的历史，不跨会话、父会话或被放弃的分支。
- recall 和 grep 搜索用户/助手正文及助手工具调用名和参数，不搜索工具结果正文、思考内容、图片或压缩摘要；可读工具结果仍可按 ID 展开。
- 所有工具和自动提示遵循分支内的上下文编辑：省略的条目不可见，替换内容遮住原文，不能绕过编辑恢复旧内容。
- SQLite 索引只驻留内存。会话切换和压缩会触发维护；已压缩内容未变化时可复用索引，内容变化时重建。退出时等待 worker 关闭，不保留跨会话索引。
- worker 或传输失败会报错，插件不会静默换成另一套检索算法。

`recallTimeoutMs` 覆盖主动请求的准备、排队、检索和渲染。超时采用协作方式：SQLite 的同步 MATCH 不能被抢占，插件会在检查点丢弃过期结果。因此实际返回可能晚于设定时间。超时不会终止健康 worker 或取消其他请求；遇到超时可缩小查询范围或改用 grep。

## 计时与诊断日志

默认不写日志。设置 `COMPACTION_RECALL_TIMING_FILE` 指定 JSONL 文件后启用计时，例如：

```sh
COMPACTION_RECALL_TIMING_FILE="$HOME/compaction-recall-timing.jsonl" pi
```

日志文件权限为 `0600`。`lite` 仅记录 grep / expand 调用链；`full` 还可记录索引和查询阶段。内存指标中的进程 RSS、主线程堆和 worker 堆不是互斥项，不能直接相加。

在配置文件中设置 `"trace": true`，可记录带内容的诊断，包括查询参数、返回条目 ID、分页和错误。trace 还需指定计时文件；没有计时文件时，只警告、不记录。它不保存思考内容、凭据或服务商原始请求，但日志仍可能包含对话信息，应私密保存，并在分享前检查内容。
