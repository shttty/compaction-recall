# pi-recall 项目交接

更新时间：2026-09-30 UTC。本文描述本地实际状态，区分生产功能、实验适配器、已运行实验和未验证事项。本轮已获授权将最新代码与本文一并提交，并准备发布到用户指定的私有仓库 `pi-context-recall`；发布状态以 Git remote / log 为准，不在文档里假定推送成功。

## 1. 当前状态与优先入口

项目位于 `/workspace/scratch/aedd6b49ce83/pi-recall`，分支 `cloud-dev`，交接前基线为 `44774d2af066d1927feed3a32096dc208c5359c9`（Add Pi benchmark and configurable background recall indexing）。最新逐阶段计时重跑、真实 TUI 演示及本文纳入本轮发布提交；用 `git log -1` 获取该提交的实际哈希。

最重要的事实：

- **生产入口仍使用同步词面扫描**。后台线程和增量索引目前只在 `prototype/pi-benchmark-adapter.mjs` 实验入口启用，尚未替换生产实现。
- 已完成原始 DEV8 八题、三组真实 Pi 全量重跑。参考答案核对为 native 0/8、grep 6/8、后台索引组 8/8；这是小样本、单次运行、运行后助手对参考答案的核对，不是独立评审或通用准确率。
- 已完成一个真实 Herdr 三分屏暖会话演示：每组 hello → 三秒输入 → 原问题。所有请求已结束，没有待继续的模型任务。
- Herdr 测试 session `pi-recall-warm-hooks` 已停止并删除，官方列表已验证不存在；外部Pi记录保留。不要自动重启或重跑模型。
- 正式继续开发前先读 [AGENTS.md](AGENTS.md)、[README.md](README.md)，检查工作树；不要覆盖本地未提交内容。

已获用户授权公开发布的计时网页：https://pi-recall-timing-report.e69c85c4-eb32-497e-9204-1cae5476a655.chatgpt.site/ （2026-09-30 15:55 UTC 验证公开可访问）。网页对应最新DEV8重跑，不包含随后TUI演示。

关键报告：

| 内容 | 文件 |
|---|---|
| 最新真实 Pi DEV8 逐阶段重跑 | [prototype/PI_DEV8_TIMED.md](prototype/PI_DEV8_TIMED.md) |
| 最新网页用归一化数据 | [prototype/pi-dev8-timed-results.json](prototype/pi-dev8-timed-results.json) |
| 答案哈希绑定的参考核对 | [prototype/pi-dev8-timed-evaluation.json](prototype/pi-dev8-timed-evaluation.json) |
| 真实 TUI 暖会话 | [prototype/PI_TUI_WARM.md](prototype/PI_TUI_WARM.md)、[数据](prototype/pi-tui-warm-results.json) |
| 后台索引架构与离线测量 | [prototype/BACKGROUND_INDEX.md](prototype/BACKGROUND_INDEX.md) |
| 计时定义 | [prototype/TIMING.md](prototype/TIMING.md) |
| 早期 Pi 运行 | [prototype/PI_DEV8.md](prototype/PI_DEV8.md) |
| 本地神经重排比较 | [prototype/RERANK.md](prototype/RERANK.md) |
| 十份真实历史拼接实验 | [prototype/STACKED.md](prototype/STACKED.md) |

## 2. Git 与文件范围

此前本地提交：

- `22c2d93138b6a93fe817839274c2af3287c3bc16`：自动定位、工具、实验和验证 skill
- `0dfefccdc18ebaa52c9181f64ad51aca0d7ad904`：手动 recall 分页、搜索工具输入
- `70d8f022b6d4dcfd65d7bcdc1a58a648c51e8ef4`：先去重再排序、本地 reranker 实验
- `44774d2af066d1927feed3a32096dc208c5359c9`：Pi benchmark、后台 worker、配置与初始计时

本轮更新的已有文件：

- `prototype/pi-benchmark-adapter.mjs`
- `prototype/pi-context-estimate.mjs`
- `prototype/pi-dev8.py`
- `prototype/pi-stage-events.mjs`
- `prototype/stage-timing.mjs`
- `prototype/test_pi_dev8.py`

本轮新增文件包括本文，以及：

- `prototype/PI_DEV8_TIMED.md`、`PI_TUI_WARM.md`
- `prototype/pi-dev8-timed-results.json`、`pi-dev8-timed-evaluation.json`、`pi-tui-warm-results.json`
- `prototype/pi-rpc-observer.py`、`check-rpc-timing.py`、`retry-timed-answers.py`、`summarize-timed-dev8.py`
- `prototype/pi-tui-milestones.mjs`、`prepare-tui-demo.py`、`run-tui-demo.py`、`summarize-tui-demo.py`

工作树是否干净以 `git status --short` 为准。`run-tui-demo.py` 是准备过但未实际使用的 tmux 驱动；真实演示使用第 8 节 Herdr helper，不能把 tmux 路径写成已验证运行。

相邻 `/workspace/scratch/aedd6b49ce83/lme-bench` 也在 `cloud-dev`，HEAD `09e1be6ba9e27d79827386a1957a59950e404e96`，该提交只添加 `.pi-profile/` 忽略规则。其 `AGENTS.md`、`README.md`、`bench.py` 和未跟踪 `tests/` 是已有本地修改，不要整体暂存或当作本项目新增改动提交。

本地 Git author 使用 `shttty <32388550+shttty@users.noreply.github.com>`，未修改全局身份。截至此文更新，尚未推送；目标名称已确定为私有 `pi-context-recall`，本地目录/package仍叫pi-recall。

## 3. 生产检索行为

入口为 `index.ts`，`recall-extension.ts` 是兼容入口，两者不可同时注册。`history.ts` 负责历史边界/文本提取/grep/expand，`locator.ts` 负责词面查询、候选、排序、去重、分页和短提示。

- 自动提示使用 `context` hook，查实际消息中最后一条用户输入；图片-only 不回退旧问题。每次先移除自身旧提示，再插入临时 custom message，不持久化提示，不累计污染历史。
- 搜索仅限当前分支已经压缩的消息，以最新 compaction 的 `firstKeptEntryId` 为界。无压缩则不搜；分支外/尚未压缩消息不可作为命中。
- 搜索用户/助手正文及助手 toolCall 工具名、输入参数。自动提示、recall、grep 全部排除 toolResult 正文、thinking、图片、摘要和 custom 内容。
- expand 可读取已压缩 toolResult 的可读文字及工具输入。原始文件没有的内容无法恢复。
- 分词是确定性词面规则：英文/代码标识符及组成部分、中文重叠双字、停用词；不是 embedding、语义同义词或语言模型分词。
- 查询上限 4000 Unicode 码点、24 个不同词项；按不同词项覆盖和信息量加权，稳定地以新近程度等打破平局。
- 先按 ID/规范化片段去重，再排序、截取。重复代表选择是确定性的，不使用参考答案。
- 自动提示最多 5 个候选，再应用 1500 字符预算；不因为前五预算不足而从第六名补位。
- 每条展示片段最多约 120 Unicode 码点，围绕匹配中信息量最高的词项，控制字符/分隔符转义。原文完整核实用 expand。
- `history_recall` 默认/最大 50 条，支持 offset，页预算 16000 码点；返回 total、returned、nextOffset、hasMore。预算提前结束不能跳过未返回记录。极端单条长元数据允许单条超预算并标记，保证翻页前进。
- `history_grep` 是补充后备：大小写不敏感正则，非法正则转字面量；沿原顺序返回最多 30 个片段、每条最多 3 个，统计全部命中。不强迫模型调用 grep，不把无命中解释为历史不存在。
- 建议工具顺序是自动提示 → recall（必要时改写查询）→ expand 核实 → 证据不足时 grep。不是强制每一步都调用。

手动分页与自动提示共享候选和排名规则，但输出数量/预算不同。新测试不应继续断言自动和手动渲染文本完全相同。

## 4. 实验后台 worker 与配置

核心文件：`prototype/background-index.mjs`、`index-worker.mjs`、`inverted-index.mjs`、`preindex-cadence.mjs`、`preindex-config.mjs`、`pi-benchmark-adapter.mjs`。

每个实验 Pi 会话维护一个持久 Node Worker。主线程保留 SessionManager 引用，分批提取并传输检索文本，worker 分词、建 postings、搜索、去重、排序、渲染。没有复制完整 JSONL、toolResult 或 reasoning 数据到索引。传输分批并让出主循环；超大单条工具参数序列化仍可能造成主线程长任务，尚未彻底消除。

生命周期：

- session_start/resume 初始预热
- **10 个完成的用户对话周期 OR 10 个完成的模型→工具批次**，任一达阈值即调度一批增量预索引
- 并行多工具调用算一个工具批次；不是每个工具各算一轮，也不是每个模型响应算用户轮次
- 真正调度时两个计数器同时清零；排队/运行期间新增活动保留给下一批
- 压缩时刷新新增数据并激活 eligible 边界；fork/reset 更换 generation，拒绝旧结果；shutdown 释放线程
- live 内容可预分词，但未压缩前不参与搜索候选、DF/N 或评分，不能改变已压缩检索语义
- 仅 live 更新时旧的有效 eligible 索引仍可使用；查询需要新 eligible 边界时等待正确 generation，不能漏新记录
- worker 失败转为可协作让出的精确扫描 fallback；不无限重启

配置是扩展自己的 `<Pi session cwd>/.pi/pi-recall.json`，不是 Pi 核心 settings 字段：

```json
{"preindex":{"userCycles":10,"toolRounds":10}}
```

有效环境变量 `PI_RECALL_PREINDEX_TURNS` / `PI_RECALL_PREINDEX_TOOL_ROUNDS` 优先于文件，文件优先于默认 10/10。每个值必须是 1–100 整数。每次 session_start 读取一次；缺失静默，非法字段/文件有不泄露内容的警告并回退。示例：`prototype/pi-recall.config.example.json`。

实验 run 的 cwd 不一定是仓库根目录；配置路径随实际 Pi cwd 走，不能把配置写到仓库根目录就假定所有测试已启用。

## 5. 实验结果与边界

### 最新真实 Pi DEV8

八份原始独立 LongMemEval_M 历史；每份六段、五次原生压缩。40 次全新 compaction RPC，三个方案共享逐题同一快照。24 个最终有效答案，26 次尝试；两个 WebSocket closed1000 各一次新会话重试后成功，失败记录保留。所有尝试共观测 61 个答题 provider-prepared 回调，不等于精确 HTTP 次数。

| 指标 | native | grep + expand | worker recall + grep + expand |
|---|---:|---:|---:|
| 参考核对 | 0/8 | 6/8 | 8/8 |
| 最终答题墙钟中位数 | 15.18s | 25.73s | 33.17s |
| p95 最近秩，n=8 时即最大值 | 21.16s | 33.01s | 39.27s |
| 工具调用 | 0 | 15 | 20 |

最多四题并行，每题固定 native→grep→indexed，缓存和并发存在混杂；没有多次抽样或独立 judge。不能把本次 8/8 或速度差完全归因于 worker 架构，摘要和模型输出都有随机性。

原始忽略目录：`lme-bench/runs/pi-dev8-timed-pilot-20260930`（577d4d32，计入最终八题）及 `pi-dev8-timed-main-20260930`（其余七题）。重试位于对应 `retry1-*` 子目录。每次运行 manifest 保留实际源码哈希。

### 历史实验不可混合

- 早期真实 Pi 六段运行：部分请求曾用 272k/240k 配置，后来恢复到用户指定 372k/340k；报告 `PI_DEV8.md`，native 0 个明确正确加 1 个不确定包含目标的回答、grep 6/8、索引 7/8。那个索引适配器是同步版。
- 更早四段运行被中断，不应并入完成率或删除其成本记录。
- 本地 reranker：十份历史拼接的英文题，固定候选池；pure grep 1/10、机械排名 4/10、mMiniLM 8/10、Qwen0.6B 8/10。是检索证据指标，不是 agent 答题准确率；候选池本身上限 8/10。未用于本次 Pi 对比。
- 十份历史拼接约 48.69M 字符，按 4.84 字符/token 粗估约 10.06M tokens；是人为合并真实历史，含重复会话，不是自然 10M 对话，也不是模型 tokenizer 实测。
- 后台 worker 离线对比确实测到主线程事件循环延迟下降，但更高总墙钟/内存；不能拿其孤立数字代替整段 Pi 的用户体验。

## 6. 计时口径

`timing.ts` / `prototype/stage-timing.mjs` 使用单调时钟和有 parentId 的包含式 span。测量包含：预检文件读/解析/上下文估算、RPC启动就绪、compaction命令墙钟、主线程提取/传输、worker build/update/查询/排名/渲染、自动提示、手动工具、provider请求准备、首次文本/思考/工具delta、assistant响应结束。

严格区分：

1. **主线程同步工作**：可能阻塞事件循环；如 branch复制、提取、传输提交、grep/expand同步工作
2. **前台等待**：用户等待模型/工具/索引就绪，事件循环不一定被阻塞
3. **worker后台工作**：独立线程耗时仍占CPU/内存，可能和前台等待重叠；后台不等于免费

不要把父子 span、等待和重叠 worker 墙钟相加。最新 DEV8 初始索引就绪中位 1.78s，前台等待并集中位 1.74s，重叠 1.74s，说明冷启动立即提问时后台工作仍落在关键路径上。

5ms heartbeat、每500ms汇总的 event-loop lag 是调度延迟观察，不是索引独占CPU或总阻塞时长。探针初始化前不可见，探针本身也有开销。

独立预检的解析计时不是 Pi 内部加载的精细分解。compaction内部多个模型流没有完整钩子；真正provider TTFT/精确HTTP请求数保持空值。首可见文本可能是工具前说明。订阅账单不能由 SDK 的理论 catalog cost 推导；网页应只展示观测token用量。

旧 worker 子span误标main_thread已在导出数据归一为 worker_thread，保留rawExecution；当前计时器源文件也已修正。

## 7. 真实 TUI 暖会话

实际使用 Herdr0.9.3 的三列 Pi TUI，不是日志渲染模拟。三份独立快照，三次 hello，再一起用八字符分块输入原问题，公共输入时段实测 3000.10ms；三份持久化问题与源问题完全一致。

| 项目 | native | grep | indexed |
|---|---:|---:|---:|
| hello | 4.514s | 5.151s | 10.495s |
| 原题回答 | 14.474s | 19.790s | 15.136s |
| 回答 | 错误推断9:30pm | 正确7pm | 正确7pm |
| 工具 | 无 | grep+expand | recall+expand |

共三个Pi会话、六个用户轮次、10个provider-prepared回调，无新压缩/重试/judge。索引初始构建1954.73ms，在原题提交前191.45秒已就绪；因为布置终端耗时，不能称为“只等三秒的冷启动验证”。hello还预热provider缓存。原题期间索引readiness等待合计3.81ms；每组第一/最后按键时刻没有单独捕获。

原始数据在 `lme-bench/runs/pi-tui-warm-20260930`。临时桌面helpers在 `/workspace/shared/`，不属于已提交项目发布包。`h.py` 控制真实pane、`f.py`修改布局/尝试默认shell、`i.py`尝试reload、`n.py`新session启动，`s.py`停止、`d.py`删除。不要重新运行 h.py exercise 或已有实验入口而造成重复模型调用。

## 8. Herdr、状态钩子、停止/删除与未决事项

官方二进制：`/workspace/scratch/aedd6b49ce83/tools/bin/herdr`，版本0.9.3，SHA256 `18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7`。来源为官方 `herdrdev/herdr` v0.9.3 release。

- 旧session `pi-recall-warm` 已停止，随后创建过 `pi-recall-warm-hooks`。
- 新session `pi-recall-warm-hooks` 已停止，并在用户明确确认后于2026-09-30 16:42 UTC永久删除其布局/恢复状态。桌面执行官方delete后，用官方session list验证该名字不存在。外部Pi JSONL和报告保留；验证元数据为 `lme-bench/runs/pi-tui-warm-20260930/herdr-delete-verification.json`。
- 官方 session delete 只删除该命名session目录，并拒绝删除正在运行的session；不是可恢复Trash操作。不要扩大删除到其他session、全局config、profile或benchmark目录。

官方Pi状态钩子已安装在三个测试profile：

`lme-bench/runs/pi-tui-warm-20260930/{native,grep,indexed}/agent/extensions/herdr-agent-state.ts`

版本9，三个文件SHA256均为 `2c5272d732b475bbf91a027203b1f98d25fe43d2c1402530a442b288aeaca1e4`。由官方 `herdr integration install pi` 配合各自 `PI_CODING_AGENT_DIR` 安装。只报告本地session/state，未注册检索工具、未调用模型。

原来 `--no-extensions` 导致单纯安装不会被发现。通过已有observer桥接再`/reload`的尝试没有观测到新marker，桌面文件可见性检查正常；未确认缓存根因。随后已移除桥接，改为每组启动显式`-e`官方钩子，并重建Herdrsession。三组Pi都达到ready，但停止前未完成Herdr权威状态来源核验，不能声称钩子状态已经端到端验证。安装发生在暖会话实验之后，没有影响其结果。

**Bash默认仍需验证**：helper写入并reload过`[terminal] default_shell = "/bin/bash"`，但未完成桌面Herdr实际config路径和新shell `/proc/<parent>/exe` 验证。`$`提示符不证明是sh，也不证明是bash。Pi启动wrapper明确使用`/bin/bash`，这与Herdr新pane默认shell是两件事。停止指令后没有继续修复或重启。

**个人Herdr skill未确认持久安装**：官方release匹配skill已读取，副本在 `/workspace/shared/herdr-SKILL.md`；个人skill持久安装失败，不能描述为安装成功。来源：`https://github.com/herdrdev/herdr/blob/v0.9.3/skills/herdr/SKILL.md`。该skill要求从真实Herdr-managed pane操作，依赖其注入的环境和CLI，不依赖模型服务。

执行shell与可见桌面的 `/tmp` 并非相同实例；通用shell里的tmux/Herdr socket检查曾返回OS Operation not permitted。实际演示通过可见桌面启动Herdr，在其真实pane内运行helper；共享文件用 `/workspace/shared`。不要凭socket检查失败推断没有可见桌面，也不要伪造Herdr环境。

## 9. 数据、运行时与认证位置

- 独立官方Pi0.99.1安装：`/workspace/scratch/aedd6b49ce83/pi-sdk`
- 仓库开发SDK锁定0.85.1；不要为benchmark直接改动生产dev依赖
- 已授权的订阅profile：`/workspace/scratch/aedd6b49ce83/lme-bench/.pi-profile`，忽略于Git。使用nativePi认证机制；本文不含凭据
- profile内支持的模型override为 `openai-codex/gpt-6-luna` contextWindow372000；high，guard340000。不修改全局catalog
- 实验各agent目录链接到该profile的认证/模型配置，不复制或导出凭据
- 完整官方LongMemEval_M：`lme-bench/data/longmemeval_m.json`，2,745,274,681bytes，500记录；SHA256 `fb5413e3b077c62927daab794836991a2fcfa61ceacab57dc679fb02daaff2d9`
- 模型weights、本地Python环境、raw候选、下载语料、原始会话均被忽略；不要纳入提交/网页
- 曾尝试的CLP通道返回Cloudflare403/1010，未用于成功benchmark；不要自动重试或读取/展示key
- reasoning/加密签名保存在某些原生Pi回答记录中，检索与worker已排除。没有删除或解码过这些字段；它们可能参与原生续接，不能未经确认清理原会话

## 10. 验证、复现与下一步

最近通过：`npm run check`（typecheck +61个Node测试）、`python prototype/test_pi_dev8.py`（3个Python回归）、项目skill校验、`git diff --check`。新增TUI/helper脚本做过语法检查和真实UI执行；tmux驱动只准备未运行。

安全的离线检查：

```sh
npm run check
python prototype/test_pi_dev8.py
git diff --check
```

回归覆盖分页/预算/去重顺序、scope排除toolResult、索引与扫描输出一致、Unicode JSONL、worker生命周期/fork/reset/fallback、批次阈值/计数同时清零/排队不丢活动，以及计时事件机制。通过机制测试不等于实际检索质量提高。

下一步按用户具体请求选择，不自动执行：

1. 如继续Herdr设置，在新session前确认有效config路径，设默认bash后检查新pane实际可执行文件；再验证官方statehook的来源、idle状态和session引用，无需新模型调用
2. 如需把worker提升为生产，先评审生命周期/内存/超大参数主线程提取、配置与错误恢复，补生产入口集成；不要仅把实验适配器导入当作完成
3. 如需更可信暖启动速度比较，重做严格控制启动到输入间隔的多次配对实验，独立记录每pane输入边界、缓存/hello混杂、worker就绪及等待；需要新的模型调用范围授权
4. 提交前逐文件审查当前dirty内容；排除profile/auth/key/env/raw语料/会话/weights/runtime和相邻repo已有改动。用户已授权将本轮最新改动和handoff一起提交，并创建私有pi-context-recall仓库；不要扩大到其他仓库或强制推送

当前没有自动等待的benchmark，也没有需要恢复的未完成模型请求。用户已要求停止/删除测试Herdrsession、写交接文档并准备私有仓库发布；后续不应据本文自动开启新测试。
