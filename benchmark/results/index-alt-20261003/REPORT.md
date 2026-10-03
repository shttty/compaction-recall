# Index alternatives：离线 worker 原型比较

## 结论

- **不替换生产索引。** 本轮只新增 `prototype/index-alt/` 与本结果目录；生产代码、现有 benchmark、文档、README、package 元数据均未改动。
- **A 保持语义，但未证明 RSS 或端到端收益。** 1M worker heap 从 69.97 降至 54.53 MiB；进程 RSS 从 335.32 升至 340.79 MiB，recall p50 从 38.85 变为 39.58 ms。三个进程的 RSS 范围有重叠，不能把这点差异解释成稳定回归或收益。
- **B1 不是合适的直接替换。** 字节一致，SQLite 页仅 0.51 MiB，但重建候选位置需重跑 `lex`；recall p50 为 221.56 ms，约为 base 的 5.70 倍。
- **B2 改变召回与排序。** 1M recall p50 为 66.45 ms；短词走原文子串扫描。不能把它称为等价压缩存储。
- **B3 的低内存值得记录，低查询延迟不能作等价加速结论。** 1M RSS 257.68 MiB、worker heap 15.94 MiB；原始自然语言问句按权威 AND 路由命中 **0**，base 命中 1078。没有模型答题或准确率评测。

## 输入、运行方式与并发

- CPU：`AMD Ryzen 7 5800H with Radeon Graphics`；性能主跑 Node `v24.18.0`，兼容冒烟 Node `v26.7.0`，Pi SDK `1.0.0`。
- 本地 LongMemEval_M，问题 `577d4d32`。显式路径来自各 lane metadata，选定 record 的 SHA-256 为 `d7c0d95d45c6b6a688b4ebdeaba8818391b52533e44ad208ed93f7af08b38df3`；不改输入、不把 session/profile 写到磁盘。
- 使用与现有 scaling 相同的 SDK `estimateTokens`、整 session 前缀和 `findCutPoint(..., 20000)`。SDK `SessionManager.inMemory` + 真实 `loadExtensions(src/index.ts)` + `ExtensionRunner`；只在新 runner 的 worker 构造处替换 worker URL。base 使用真实生产 worker。
- 所有版本保留相同主线程分支选择、文本提取、IPC、就绪等待、工具包装。断言每一次 context/recall 都收到 worker query reply，不容许同步回退把数据伪装成索引成绩。
- 实际最大并发 **5**。12 波 × 每波 base/A/B1/B2/B3；同波长度档与重复序号相同。驱动和子进程均绑 `(2,3)、(4,5)、(6,7)、(8,9)、(10,11)`，CPU 0/1 不分配，三轮轮换变体的核对。SMT 配对采用用户给定拓扑。
- 先串行跑五变体 semantic + 50k 冒烟。50k 单作业峰值 RSS 为 203.67–220.98 MiB。开跑前 `/proc/meminfo` 的实际 MemAvailable 为 **19.89 GiB**；保留用户先前约 6 GiB 的描述在 metadata 中，不把二者混写为同一次快照。保守外推五作业 + 驱动 + 512 MiB 余量共 **9.82 GiB**，预计剩余 **10.07 GiB**，高于 1.5 GiB，因此没有降至四并发。见 [memory-plan.json](memory-plan.json)。未操作 llama-server/vllm 等服务。
- lane 间输入就绪及整波完成有 barrier。实际子进程起止、建库开始和热 recall 开始时间均保存；同波调度不意味着快版本退出后仍有五个计算负载，也不是五路独立无噪声延迟测量。

| 目标 tokens | 实际 tokens | 原消息数 | 初始可检索消息数 | 增量后可检索消息数 |
| --- | --- | --- | --- | --- |
| 50000 | 49993 | 218 | 135 | 151 |
| 200000 | 198673 | 822 | 741 | 769 |
| 500000 | 499581 | 2022 | 1939 | 1957 |
| 1000000 | 995303 | 3975 | 3888 | 3919 |

每格三个全新进程；每进程 20 次 index-hot context、20 次原始问句的 recall 首页，先分别预热。p50/p95 用 nearest-rank，再对三个进程的值取中位数。建库 wall 从生命周期调度到 worker commit，不含 SDK 加载。主线程延迟为 5 ms heartbeat 的最大超期，不是 p99。增量加入后续 20 条真实消息，再压缩启用新可检索前缀；所有运行都断言 `begin.append === true`，未偷偷全量重建。

## 变体及语义

| 变体 | 存储/分词 | 位置与排序 |
| --- | --- | --- |
| base | 生产 `Map(term -> Map(recency -> {offset, order}))` | 缓存首次词法位置，现有去重/机械排名/预算 |
| A | 每词 growable `Uint32Array` 三元组 `(recency, offset, order)` | 同一词法顺序；无逐 posting JS 对象；32 位字段，非通用超大语料格式 |
| B1 | `:memory:` contentless FTS5，唯一 lex token 流；`ascii tokenchars '_$'`，`detail=none,columnsize=0` | 查到候选后重新 lex 一次恢复首次 offset/order；共享 base 排名和渲染 |
| B2 | 同一预分词流上的 contentless trigram，`case_sensitive=1,detail=full,columnsize=0` | ≥3 码点按 trigram 子串；更短的已生成 query token 扫原文；原文位置、查询顺序处理同 offset；保留 base 渲染/排名函数 |
| B3 | JS CJK bigram/unigram + 默认 `unicode61`，再加原文 `trigram`，两表 contentless、full detail、保留 column lengths | 权威 AND 路由；两表同时查并取并集；词面 tier 优先，每 tier native BM25、rowid 破平局 |

A 不能只留 offset：`lex('fooBar')` 先产生 `foobar@(0, order 0)`，再产生 `foo@(0, order 1)`；查询 `foo foobar` 的遍历顺序相反。只按 offset 稳定排序会保留错误的 matches 插入顺序，影响 snippet 平局处理。因此保留 order，未做未经证明的压缩。

B1 的 ASCII tokenizer 对当前 lex 字母表保留 `_`、`$` 和非 ASCII 字符，不使用会再次拆词或折叠的默认 unicode61。B2 **不是原文 trigram 表**：按要求比较预分词输入，且不做 B1 式精确词法过滤；若原文找不到该 term，保留命中并使用 offset 0，统计 offsetFallbacks。B2 仍沿用 base queryTerms：中文单字根本不生成 token，不能被其短词 fallback 挽救。

B3 的 `b3-tokenize.mjs` 是只去掉 TypeScript 类型的逻辑移植，权威来源为只读的 `/home/rinne/workspace/pi-lossless-context/src/tokenize.ts`，SHA-256 `e0e37663df3855be6bb7b28ce67035e7feb9e141b1af8e000465de060cf34d7b`；路由依据 `PLAN.md` 的“分词与查询路由”。中文单字走 uni、双字走 bi、1–2 字符英文整词；长词同时查两表，混合查询的短词约束仍经 bi/uni 过滤。健康索引零命中不回退 LIKE。没有原生扩展或 loadExtension。

B3 在 worker 内预生成 bi/uni，启用后删除缓存，不额外跑 base lex。SQLite 自身的 unicode61/trigram 分词发生在 INSERT/启用阶段，不能把 3.33 ms 的 JS 预处理当成 B3 全部分词成本。两张表不存正文；候选原文来自已有 worker entry 引用。B3 只对跨表 rowid 去重，不套用 base 的 snippet 去重/机械重排；手动页沿用相同 JSON schema、码点预算及全候选 snippet 物化工作，但保持 BM25 tier 顺序。

`fts_tri.calls` 列存在但本轮为空：当前生产 IPC 把可搜索工具输入折入 text，LongMemEval_M 本身没有独立工具调用列。**没有验证 text/calls 分离检索。** 对 normalized phrase 等找不到原文 literal 的位置，B3 选其他可定位 term 或正文开头，并在 stats 中披露。

## 内存：1M 档

| 变体 | 进程 RSS MiB | 主线程 heap MiB | worker heap MiB | worker external MiB | 索引分配量 MiB | 全程峰值 RSS MiB |
| --- | --- | --- | --- | --- | --- | --- |
| base | 335.32 | 49.97 | 69.97 | 3.44 | - | 416.58 |
| A | 340.79 | 49.97 | 54.53 | 7.50 | 4.06 | 435.62 |
| B1 | 324.14 | 49.98 | 49.46 | 3.44 | 0.51 | 421.89 |
| B2 | 327.58 | 49.99 | 59.60 | 3.44 | 6.21 | 432.47 |
| B3 | 257.68 | 49.97 | 15.94 | 3.44 | 13.05 | 280.91 |

RSS 在一次 context 预热后、主线程显式 GC 后采样；worker 单独用 `getHeapStatistics()`，**没有强制 worker GC**。峰值 RSS 是整个进程截至所有查询与增量完成的 `resourceUsage.maxRSS`，不是同一个静态采样点。表中均为三进程中位数。

RSS 属于共享进程，不能给主线程/worker 各算一份相加。heap 不包含全部 native/TypedArray 内存；worker external 已包含 A buffer，不能再把“索引分配量”加一遍。A 的 4.06 MiB 是 buffer capacity，B1/B2/B3 的 0.51/6.21/13.05 MiB 是 `page_count * page_size`，不含 SQLite connection/cache/native 开销，也不含 JS 会话数据。

历史 `/home/rinne/workspace/pi-lossless-context/prototype/tokenizer-bench/FINDINGS.md` 的约 22 MB 双表结果来自真实中文 Pi/OMP 会话，是数据库索引体积，不是 worker V8 heap 或进程 RSS；语料、排除项、结构和口径均不同，**不可与本表直接相除比较**。本轮 LongMemEval 以英文为主；中文边界只由下面的合成用例证明，不声称得到中文真实负载的速度/排名结论。

## 四档端到端结果

| 目标 | 变体 | 建库 ms | 建库主线程最大延迟 ms | context p50 / p95 ms | recall p50 / p95 ms | 增量 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 50000 | base | 118.06 | 0.73 | 1.42 / 3.35 | 1.66 / 2.08 | 5.68 |
| 50000 | A | 120.82 | 1.38 | 1.37 / 3.56 | 1.65 / 2.03 | 7.10 |
| 50000 | B1 | 119.12 | 1.50 | 6.41 / 7.89 | 6.62 / 10.73 | 5.27 |
| 50000 | B2 | 124.29 | 1.25 | 2.06 / 3.01 | 3.45 / 5.49 | 5.53 |
| 50000 | B3 | 89.28 | 0.62 | 0.58 / 1.29 | 0.24 / 0.35 | 3.43 |
| 200000 | base | 263.12 | 8.00 | 4.76 / 7.18 | 8.70 / 10.07 | 7.29 |
| 200000 | A | 268.74 | 5.31 | 4.54 / 7.07 | 8.60 / 9.71 | 9.09 |
| 200000 | B1 | 261.80 | 9.03 | 37.54 / 50.53 | 40.49 / 41.38 | 7.07 |
| 200000 | B2 | 277.58 | 8.54 | 8.88 / 12.33 | 13.53 / 14.65 | 7.88 |
| 200000 | B3 | 167.75 | 0.80 | 0.92 / 1.64 | 0.53 / 1.38 | 5.42 |
| 500000 | base | 475.70 | 7.85 | 11.70 / 15.70 | 20.25 / 21.09 | 8.65 |
| 500000 | A | 489.13 | 11.28 | 10.70 / 18.84 | 19.81 / 22.41 | 9.21 |
| 500000 | B1 | 459.74 | 12.72 | 101.56 / 115.60 | 106.88 / 117.09 | 6.76 |
| 500000 | B2 | 513.61 | 6.73 | 22.14 / 30.48 | 33.19 / 35.61 | 8.80 |
| 500000 | B3 | 352.20 | 7.41 | 1.37 / 2.08 | 1.06 / 1.21 | 7.13 |
| 1000000 | base | 858.85 | 11.57 | 21.60 / 33.26 | 38.85 / 42.03 | 10.80 |
| 1000000 | A | 837.37 | 13.14 | 22.51 / 33.12 | 39.58 / 43.71 | 12.64 |
| 1000000 | B1 | 807.20 | 16.73 | 210.57 / 230.41 | 221.56 / 251.49 | 10.09 |
| 1000000 | B2 | 938.03 | 12.02 | 44.38 / 57.12 | 66.45 / 71.56 | 16.29 |
| 1000000 | B3 | 636.19 | 14.17 | 2.41 / 5.21 | 1.98 / 2.06 | 9.44 |

B3 的自然语言问句在四档均零命中；这些低延迟不能证明它比 base 更有效。所有版本的计时包含相同入口调用路径，但词法、候选数和 B3 排名语义不同。

## 输出一致性与逐查询结果

| 变体 | 完整字节一致 / 查询阶段组 | base 页哈希一致 / 页 | Top-5 覆盖 | Top-50 覆盖 |
| --- | --- | --- | --- | --- |
| A | 192 / 192 | 432 / 432 | 100.00% | 100.00% |
| B1 | 192 / 192 | 432 / 432 | 100.00% | 100.00% |
| B2 | 102 / 192 | 102 / 432 | 52.60% | 55.10% |
| B3 | 93 / 192 | 93 / 432 | 25.32% | 34.11% |

每变体 4 档 × 3 轮 × 8 查询 × 初始/增量后 = 192 组。比较自动提示完整字符串，以及所有手动分页完整工具结果的 SHA-256（包括正文与 details）；A/B1 的 432 个 base 页全部相同。另有每变体 44 组 semantic/50k smoke 的初始/增量比较，A/B1 同样全等。

Top-N 为与 **base 返回结果**的集合覆盖，不是正确答案召回率；按 base top-N id 数微平均，87 个 base 空结果组另计、不进分母。Top-5 来自手动首页前五条，不等于预算裁剪后的自动提示。B2/B3 的逐组差异及前五 id 在 [summary.json](summary.json) 的 parity.differences，全部原始排序/分页在 matrix 文件。

| 查询（初始 1M） | base | A | B1 | B2 | B3 |
| --- | --- | --- | --- | --- | --- |
| What time do I stop checking work emails and messages? | 1078 | 1078 | 1078 | 1459 | 0 |
| checking | 42 | 42 | 42 | 42 | 43 |
| go | 249 | 249 | 249 | 1577 | 244 |
| id | 13 | 13 | 13 | 2190 | 10 |
| 北京 | 0 | 0 | 0 | 0 | 0 |
| HTTP HTTPServer | 9 | 9 | 9 | 28 | 0 |
| 中文 检索 | 0 | 0 | 0 | 0 | 0 |
| xyzzynotpresent | 0 | 0 | 0 | 0 | 0 |

原始问句为 `What time do I stop checking work emails and messages?`。B3 对空白/引号拆出的 terms 使用 AND，不采用 base 停用词/并集语义，因此长问句结果少不是单纯存储优化。B2 的 `go`、`id` 会包含原文其他词内部的子串。

### 中文与标识符合成检查

| 查询与对照 | base / A / B1 | B2 | B3 |
| --- | --- | --- | --- |
| 网；原文“网关”“网，关” | 都不命中（单字被 queryTerms 丢弃） | 都不命中 | 两条都命中 |
| 网关；同上 | 只中“网关” | 只中“网关” | 只中“网关”，不跨标点 |
| 索引；原文“搜索引擎” | 命中 | 命中 | 命中 |
| compaction；原文 compaction / CompactionResult | 两条命中 | 两条命中 | 两条命中，整词 tier 排前 |
| vm；原文 vm / kvm | 只中 vm | 两条都中 | 只中 vm |
| youer；原文“修改youer服务端” | 命中 | 命中 | 命中 |

保留 foo/foobar 同 offset、HTTP/HTTPServer、下划线/美元符、扩展区汉字等原有样例；总计 14 查询，B3 初始/增量 **28 组命中集合**及初始 **14 组 tier 顺序**通过。不是只检查结果非空。完整 id 集合、自动输出 id 和增量结果在 summary.semantics。

## 独立 1M 阶段计时

五个变体各一个额外进程，串行、同绑核 `(2,3)`，不混入三重复性能/内存矩阵。使用生产 timing，JSONL 均为 0600，均实际记录 worker-thread spans。下表是 20 次热 recall 的单 stage **均值 ms**；嵌套 span 包含子阶段，不能累加外层/内层。

| 变体 | postings_search | candidate_materialization | deduplicate | mechanical_rank | manual_snippets_pagination_render |
| --- | --- | --- | --- | --- | --- |
| base | 0.390 | 1.162 | 18.949 | 0.819 | 18.218 |
| A | 0.129 | 1.183 | 18.098 | 0.691 | 19.014 |
| B1 | 0.736 | 186.208 | 17.649 | 0.799 | 17.644 |
| B2 | 1.758 | 15.513 | 23.900 | 1.083 | 23.942 |
| B3 | 1.262 | 0.013 | 并入 SQL/并集阶段 | 并入 SQL/并集阶段 | 0.011 |

base/A 的热点是去重与全候选 snippet/分页渲染，而不是倒排查找。B1 的候选重新分词约 186 ms，解释了端到端退化。B3 的 SQL MATCH、BM25、跨表去重都在 postings_search 中；没有单独的 base deduplicate/mechanical_rank span，**不是这些成本为零**，且本次热问句没有候选。

| 变体 | JS 预处理/预分词总计 ms | 索引启用总计 ms | 批次往返总计 ms |
| --- | --- | --- | --- |
| base | 522.49 | 83.81 | 589.42 |
| A | 526.96 | 77.99 | 588.71 |
| B1 | 514.40 | 46.09 | 581.66 |
| B2 | 515.93 | 181.40 | 582.10 |
| B3 | 3.33 | 412.74 | 35.02 |

批次往返包含 worker 分词，不与 JS 分词总计相加。B3 native tokenizer 的成本归入索引启用。build、warmContext、warmRecall、incremental 的所有分阶段 count/total/mean/p50 保存在 summary.timing.phases；原始完整事件在 timing/。

## 验证、边界与产物

- 60 个矩阵进程全部正常 shutdown、stderr 为空、实际 affinity 与独立核对一致；最大生命周期重叠数 5。每个运行的初始/增量计数、worker reply 数量与分页前进性都通过断言。
- Node24 五变体 semantic + 50k 共 10 个冒烟；Node26 B1/B2/B3 semantic + 50k 共 6 个冒烟，自动输出与完整分页逐字节匹配 Node24，没有靠屏蔽 warning 通过。
- 不开 timing 的索引/查询阶段 `/proc/self/io.write_bytes` 增量全部为 0。所有 SQLite `database_list` filename 为空，`temp_store=MEMORY`、`journal_mode=MEMORY`。这是测量区间的证据；JSON 结果与显式 timing 本来就允许落盘，不宣称整个进程生命周期零 IO。
- npm 真实打包布局已离线验证 Node24/Node26 × full/lite 共 4 组；full 实际有 worker query spans，lite 没有 worker，grep/expand 和 shutdown 均通过。没有安装 peer、没有修改 Pi profile，scratch 已删除。原始命令、pack 文件清单、stderr 在 [npm-layout.json](npm-layout.json)。
- 许可目录以外的 **560 个既有文件** SHA-256 全部未变；新增仅限两个许可目录。保护快照采集时 A 原型已先行落盘，因此快照共 561 项，另含 `prototype/index-alt/typed-index.mjs`，不把它误计为任务前的既有文件。证据见 [boundary-verification.json](boundary-verification.json)，含全部快照哈希；历史结果、manifest/provenance 与历史文档未重标。没有改 engines、发布、提交或推送。
- 本轮未运行全库测试：没有生产改动；完成的是用户要求的真实 SDK、实际 worker、性能及兼容冒烟。不是模型评测，不外推准确率。

### 文件索引

- `prototype/index-alt/typed-index.mjs`：A packed postings。
- `prototype/index-alt/sqlite-index.mjs`：B1/B2。
- `prototype/index-alt/b3-tokenize.mjs`、`b3-index.mjs`：权威分词/查询路由及双表 BM25。
- `prototype/index-alt/worker.mjs`：仅原型的同协议 worker。
- `prototype/index-alt/data.mjs`、`run.mjs`：固定数据、真实 SDK 驱动、分页一致性与绑核 wave。
- `prototype/index-alt/npm-layout.mjs`：隔离打包布局验证。
- `prototype/index-alt/summarize.mjs`：聚合器，断言 A/B1 完整一致、实际 worker 查询次数、wave、CPU mask、B3 语义及 Node26 一致性。
- `matrix/`：60 份原始结果 + 5 lane metadata，均含源代码/数据哈希与实际命令。
- `smoke/`：本轮五变体 semantic/50k；`node26/`：六份跨版本冒烟；`timing/`：五份单独 1M 结果及 JSONL。
- `semantic/`：加入 B3 前的四变体探索结果，保留原样，不用于上述矩阵或覆盖率。
- `memory-plan.json`、`summary.json`、`npm-layout.json`、`boundary-verification.json`、本报告。

### 重现

原始执行参数在 metadata.command 和每条 launchCommand 中；结果写入使用 exclusive create，不覆盖冻结输出。重跑必须使用新的结果目录。五并发 matrix 分别启动 lane 0–4，且为驱动使用对应 taskset；同一父目录下共享 barrier。先用 `--sizes semantic,50000` 得到 memory gate，确认当前内存后再跑全矩阵。timing 使用 `--sizes 1000000 --timing`，跨版本使用 `--variants B1,B2,B3 --runtime /home/rinne/.hermes/tools/node-26.7.0-linux-x64/bin/node --sizes semantic,50000`。

本次完整聚合校验命令：

```sh
/home/rinne/.nvm/versions/node/v24.18.0/bin/node prototype/index-alt/summarize.mjs benchmark/results/index-alt-20261003
```

该命令已通过并生成 summary；不要对已有 summary 再运行并覆盖证据。
