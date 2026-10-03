# Offline scaling / 离线性能扩展测试

2026-10-03。仅测原始 LongMemEval_M 的 **577d4d32**；没有模型调用、网络、UI 或真实摘要生成。正式结果为每格 **3 个全新进程**，4 个长度 × baseline/lite/full，共 **36 个进程**。Node **v24.18.0**，Pi SDK **1.0.0**；Linux x64，**AMD Ryzen 7 5800H with Radeon Graphics，16 个逻辑 CPU**。README 模板未修改。

One original LongMemEval_M question, **577d4d32**, measured offline: **36 fresh processes**, three per size/arm. No model, network, UI, or generated summaries. Runtime and machine above; these are not general Pi latency or accuracy claims.

## Method / 方法

- 本地 2,745,274,681-byte JSON 用 64 KiB 流逐个解析记录，找到第 95 条即停止，不把整个数据集载入内存。四档取**不超过目标的最大完整 session 前缀**。消息正文不改；assistant 文本转为 SDK text block，时间戳规范化，usage 为零的离线历史元数据。token 使用 SDK `estimateTokens`：纯文本每条 `ceil(UTF-16 length / 4)` 后求和，不是真实模型 tokenizer。
- 保留点使用 SDK `findCutPoint(..., 20000)`，可落在 user/assistant 消息边界；不是要求保留尾部也按整 session 切。用 `SessionManager.appendCompaction` 写入固定占位摘要，无 LLM；计数表只含源历史，不含占位摘要及随后加入的查询消息。
- 三个 arm 都用真实 `SessionManager.inMemory`、SDK `ExtensionRunner`。baseline 不加载扩展；lite/full 经 SDK `loadExtensions` 加载公开 `src/index.ts`，原样调用生命周期、context 和工具。未创建模型/provider/UI runtime，因此 baseline 是**离线 SDK session**，不是完整交互式 Pi 的绝对 RSS。每个子进程使用临时 HOME、`PI_CODING_AGENT_DIR`，无个人 profile。
- 生产计时关闭，全部外部用 `performance.now()`。harness 仅给原生 `Worker` 子类加观察器，实际执行未修改的 `src/index-worker.mjs`；按 commit 回复及生产 Promise 完成确认就绪，强制检查真实查询、无失败、live 批次不扩大候选数和正常 shutdown。
- 后台建索引是**已写入 compaction 的会话在启动/压缩 hook 派发后，到冷 worker 完成索引**的 wall time；包括选择、传输、分词和索引，也预分词约 20k live 尾部。SDK 写 compaction、加载扩展、读数据不计入。主线程延迟为 5ms 心跳的 `实际间隔 - 5ms`，不是精确的单段阻塞或 UI 帧时长；结束后保留 10ms 捕获末次延迟，该尾窗不计入 wall time。
- 热态每进程每操作 20 次，context 前有一次查询，工具各有一次不计时预热；p50/p95 用 nearest rank，再取三个进程对应统计值的中位数。context 增量是 full 与同长度 baseline 的统计值之差，包含同一路 SDK clone/dispatch 的扣除；p95 差不是配对逐请求差的 p95。主表“搜索返回”是 `history_recall` 默认第一页，不是 grep。
- context/recall 使用原题问题；grep 使用题目中首个长度至少 5 的 ASCII 单词 **`checking`**；expand 使用被压缩区域中部消息，默认参数。只测这组固定输入，结果量会随前缀增长。

The local dataset is streamed one record at a time. History tiers end at session boundaries; the retained suffix uses the SDK's native 20k cut rule. Tokens are the SDK's per-message **ceil(UTF-16 characters / 4)** heuristic. Actual messages, compaction entries, extension loading, dispatch and worker execution use production/SDK code; there is no provider runtime. External timings include production work but exclude fixture loading and SDK compaction-entry creation. A 5ms heartbeat measures scheduling excess, not exact UI blocking. Hot p50/p95 are nearest-rank statistics of 20 samples, then medians across three processes. Request overhead subtracts the matching baseline statistic; “Search reply” means default-page `history_recall`. Query selection and the literal grep pattern are fixed as above.

### Actual sizes / 实际长度

字符列依次为 UTF-16 单元 / Unicode 码点；消息列为总条数 / 被压缩条数。
Characters: UTF-16 units / Unicode code points. Entries: total / compacted messages.

| Tier / 档位 | Tokens total / compacted / retained | Sessions | Message entries | Characters |
|---|---:|---:|---:|---:|
| 50k | 49,993 / 29,648 / 20,345 | 21 | 218 / 135 | 199,651 / 199,642 |
| 200k | 198,673 / 178,208 / 20,465 | 80 | 822 / 741 | 793,456 / 793,447 |
| 500k | 499,581 / 479,152 / 20,429 | 210 | 2,022 / 1,939 | 1,995,304 / 1,995,240 |
| 1M | 995,303 / 974,964 / 20,339 | 414 | 3,975 / 3,888 | 3,975,270 / 3,975,154 |

## README cells / README 对应格子

**Memory / 内存：** 同长度 arm 的 RSS 中位数减 baseline RSS 中位数，MiB = 2²⁰ bytes。索引就绪且完成一次 context 查询后，主线程 `global.gc()` 再采样。不是三个堆的和。

RSS above the same-size baseline, after readiness, one context query and main-thread GC. Difference of medians, not a sum of heaps.

| History / 历史 | `full` extra RSS MiB | `lite` extra RSS MiB |
|---|---:|---:|
| 50k | 23.45 | 1.76 |
| 200k | 44.26 | 1.66 |
| 500k | 66.43 | 1.60 |
| 1M | 124.88 | 3.40 |

**Time / 时间（full，ms）：** 后台列是三个 wall time 的中位数；最长延迟列是各进程最大值的中位数；前台两列是热态 p50。

Background columns: median wall time and median of per-process maximum delays. Foreground columns: hot p50.

| History / 历史 | Index build / 后台建索引 | Max main-thread delay / 最大主线程延迟 | Added per request / 请求增量 | Search reply / 搜索返回 |
|---|---:|---:|---:|---:|
| 50k | 100.67 | 0.59 | 0.95 | 1.41 |
| 200k | 196.65 | 0.71 | 3.63 | 7.83 |
| 500k | 374.73 | 0.96 | 9.60 | 18.22 |
| 1M | 665.11 | 0.96 | 19.07 | 36.05 |

模板其它数字：保留约 **20k**（实际 **20,339–20,465**）；每格 **3** 个新进程。full 额外 RSS 按两端实际被压缩 token 算，平均约 **10.73 MiB / 100k token**；不是保证线性，三个区间斜率分别约 **14.00、7.37、11.79**。1M 的 lite grep p50 **7.69 ms**、p95 **8.99 ms**。

Other template values: retain about **20k** tokens, **3** processes per cell; endpoint RSS slope **10.73 MiB per 100k compacted tokens**, not a linear guarantee. Intermediate slopes are **14.00, 7.37, 11.79**. Lite grep at 1M: **7.69 ms p50 / 8.99 ms p95**.

## Additional measurements / 补充指标

热态单元格均为 **p50 / p95 ms**。full context 总耗时（未减 baseline）依次为 **1.12/1.55、3.80/5.82、9.77/15.52、19.25/29.82**。
All cells below are **p50 / p95 ms**. Unsubtracted full context totals are listed above.

| History | Context added / context 增量 | full recall | full grep | full expand | lite grep | lite expand |
|---|---:|---:|---:|---:|---:|---:|
| 50k | 0.95 / 1.31 | 1.41 / 1.60 | 0.27 / 0.47 | 0.07 / 0.18 | 0.24 / 0.41 | 0.07 / 0.15 |
| 200k | 3.63 / 5.60 | 7.83 / 8.11 | 1.41 / 1.59 | 0.14 / 0.21 | 1.40 / 1.93 | 0.15 / 0.20 |
| 500k | 9.60 / 15.31 | 18.22 / 18.92 | 3.59 / 4.23 | 0.25 / 0.31 | 3.71 / 3.93 | 0.25 / 0.31 |
| 1M | 19.07 / 29.60 | 36.05 / 36.95 | 7.84 / 8.93 | 0.34 / 0.41 | 7.69 / 8.99 | 0.34 / 0.54 |

Live 批次：前缀之后原始数据里的 10 对 user/assistant（20 条），按真实 user-cycle hooks 触发默认十轮节奏。wall 包含消息追加和 hook 调度；它们保持未压缩。冷请求为随后 `session_tree` 使索引失效后立即调用 context 的等待，包含重建和查询；**不能与后台时间相加**。它不等同于已缓存 token 的增量压缩激活。

Live batch: ten subsequent original user/assistant pairs, exercising the default cadence. Cold request: context immediately after index invalidation; its rebuild overlaps the request, so **do not add it to background time**. This is not a cached incremental-compaction activation benchmark.

| History | Live batch tokens | Live wall ms | Live max delay ms | Cold first request ms |
|---|---:|---:|---:|---:|
| 50k | 4,851 | 3.94 | 0.22 | 62.29 |
| 200k | 6,728 | 5.49 | 0.09 | 158.64 |
| 500k | 6,489 | 6.06 | 0.41 | 325.46 |
| 1M | 7,931 | 7.49 | 0.21 | 605.80 |

### Heap sampling / 堆采样

Node 24 的 `Worker.getHeapStatistics()` 可用。主线程 GC 后先采 RSS/主线程 heapUsed，再于空闲 worker 采 `used_heap_size`；返回比主线程采样晚 **0.36–0.40ms**。worker **未显式 GC**，不是同一时刻、同一 GC 口径，以下分开报告，**不相加**。worker 值也不是纯倒排索引大小。

`Worker.getHeapStatistics()` is available. Worker samples arrive **0.36–0.40ms after** the main sample, while idle, without explicit worker GC. The columns have different sampling/GC semantics: **do not add them**, or interpret worker heap as index-only storage.

| History | Baseline RSS MiB | Main heap baseline / lite / full MiB | Worker heap full MiB |
|---|---:|---:|---:|
| 50k | 140.28 | 32.40 / 33.45 / 33.65 | 10.24 |
| 200k | 140.94 | 33.40 / 34.37 / 34.60 | 16.86 |
| 500k | 141.68 | 35.14 / 36.19 / 36.45 | 36.18 |
| 1M | 141.88 | 38.07 / 39.12 / 39.42 | 83.17 |

## Interpretation and limits / 现象与局限

- **后台不等于无需等待。** 正式测量 12 个 full 进程的后台心跳最大超时均不超过 **1.03ms**，但 1M 冷请求仍等待约 **606ms**，热态 context 增量 p95 约 **29.60ms**。README 的“不用等它”不应作为无条件结论。心跳没有测前台各阶段的最大阻塞。
- RSS 含 V8/native allocator 高水位、worker runtime、加载器、代码页及 token 缓存；主线程 GC 不会清空 worker 或归还所有 RSS。lite 增量约 **1.60–3.40 MiB**，不是严格零；小差值受进程启动和分配器噪声影响。full 1M RSS 三次为 **266.65–266.99 MiB**，建索引为 **656.54–671.25ms**。
- full recall 命中数随档位为 **25 / 190 / 511 / 1,078**，grep 原始匹配为 **1 / 6 / 15 / 45**；查询成本随候选集合增长，不能只归因于 token 总数。单个固定词的 grep 比排序后的 recall 更快，不证明 lite 整体更快，也不说明质量等价。
- 只测一题、纯 user/assistant 文本、一个固定查询、前三个 repeats。无工具调用历史、图片、context_edit、多分支争用、UI、模型、网络和真实摘要；未控制 CPU 频率/系统其它负载。20 个热态样本及 3 个进程不足以估计生产尾延迟或置信区间；“热态”指索引已就绪，不保证所有 JIT 路径完全稳定。

**Background work can still delay a request:** the measured background heartbeat excess stayed below **1.03ms**, while the 1M cold request waited about **606ms**. RSS includes allocator high-water marks and runtime overhead; lite is small, not zero. Increasing match counts confound token-only scaling. A single lexical grep being faster than ranked recall is not a mode-level speed or quality result. One question, text-only history, fixed inputs, three processes and 20 hot samples do not establish production tails; UI/model/network/real summarization and CPU/load control are outside this measurement.

## Raw data and reproduction / 原始数据与复现

- **Only the final matrix feeds these tables / 本文只引用正式矩阵：** [final/summary.json](../benchmark/results/perf-20261003/final/summary.json)、[final/metadata.json](../benchmark/results/perf-20261003/final/metadata.json)，以及同目录 **36** 个 `<target>-<arm>-<repeat>.json`。每次值、全部热态样本、GC/heap 采样时间、命令、Node/CPU、源文件 SHA-256 均保留；不保存会话正文。
- 正式脚本 SHA-256 / Final harness SHA-256：`a44c038b780af1cee20ceac3781d4a5c0ffb100df45cbc59d5249cf401bdd099`。所选原始记录 SHA-256：`d7c0d95d45c6b6a688b4ebdeaba8818391b52533e44ad208ed93f7af08b38df3`。
- [smoke-sdk-cut/](../benchmark/results/perf-20261003/smoke-sdk-cut/) 是修正保留点后的 50k 冒烟，**不并入正式中位数**。
- [smoke/](../benchmark/results/perf-20261003/smoke/) 和 [full/](../benchmark/results/perf-20261003/full/) 保留首轮诊断。首版把保留尾部也按整 session 切，500k 只能留下 **4,261 token**，使 context 基线异常变小；不是生产性能突变。修正为 SDK cut 后重新冒烟、重新跑完整矩阵，旧数未覆盖、未改标为新口径。

`final/` alone supplies the reported numbers. The initial whole-session-tail attempt in `full/` is excluded: its 500k retained tail was only 4,261 tokens. Both attempts retain their own source hashes; corrected smoke and final runs were fresh, not relabeled.

```sh
# Parent directory must exist; each --output directory must be new.
node benchmark/benchmark-scaling.mjs \
  --data /home/rinne/workspace/lme-bench/data/longmemeval_m.json \
  --question 577d4d32 --sizes 50000 --repeats 1 --keep 20000 \
  --output benchmark/results/perf-20261003/smoke-sdk-cut

node benchmark/benchmark-scaling.mjs \
  --data /home/rinne/workspace/lme-bench/data/longmemeval_m.json \
  --question 577d4d32 --sizes 50000,200000,500000,1000000 \
  --repeats 3 --keep 20000 --output benchmark/results/perf-20261003/final
```

驱动自动给每个子进程加 `--expose-gc`，依次运行并轮换 arm 顺序，临时目录退出时删除；不覆盖既有结果。测量期间没有并行执行测试。此前冻结的 benchmark、src/test 和两份 README 均未修改。
The driver adds `--expose-gc`, rotates arm order, runs sequentially, removes temporary profiles, and refuses to overwrite results. No tests ran concurrently with measurement; pre-existing evidence and production sources were untouched.
