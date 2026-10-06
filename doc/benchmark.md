# 如何运行 benchmark

本文介绍当前 Pi 原生、`lite`、`full` 的 LME16 答题对比，以及离线检查、结果读取和性能诊断。所有命令从仓库根目录执行；benchmark 工具只随源码提供，不包含在 npm 包中。

**先区分两件事：**离线测试检查插件与评测接线是否工作，不产生模型准确率；真实答题与判分会调用模型服务，产生费用。

## 1. 环境与离线检查

需要 Node.js >=24.18.0、Python 3 和已安装的项目依赖。真实 LME16 runner 还要求 Linux cgroup v2、可用的 systemd 用户服务，以及一个 14 GiB 内存、禁用 swap 的共享运行范围。

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

检查实际命令行选项，不发起答题请求：

```sh
python3 benchmark/coding-recall/e2e/lme-zh-run.py --help
python3 benchmark/coding-recall/e2e/lme-zh-report.py --help
```

脚本名保留 `lme-zh`，但当前正式三模式对比使用 `--language en`。

## 2. 准备题集和压缩快照

LME16 使用 [LongMemEval_M](https://huggingface.co/datasets/xiaowu0162/longmemeval) 的固定 DEV8 和 HARD8，各 8 题。它不是完整 LongMemEval，也不是每次重新随机抽题。固定题号、数据来源和处理说明见 [输入资料说明](../benchmark/data/release-0.1.0/INDEX.md)。

当前三模式 runner 是**已有冻结输入的重跑入口**，不是通用的数据下载、翻译或首次压缩工具。公开仓库提供来源、题号、hash 和中文题面译文，不提供完整历史、参考答案或已生成的压缩快照。仅有公开元数据不能从零复现这轮测试。

一次重跑需要以下配套材料，放在仓库之外：

| 输入 | 内容 |
|---|---|
| `DATA_ROOT` | 题集根目录，含 `data/index.json`，以及 `data/dev8/<id>/`、`data/hard8/<id>/` 下的 `question.json`、`corpus.json`、`answer.json`、`judge.json`。 |
| `SNAPSHOT_SOURCE` | 完整英文原生轮次的目录，含 `manifest.json` 及其引用的会话文件；每题有三次真实 Pi 压缩。 |
| `CONFIG` | 答题及压缩身份等外部配置。即使复用快照，压缩配置仍参与身份校验。 |
| `LUNA_CONFIG`、`SOL_CONFIG` | 两位裁判的外部配置文件，模型、服务商和推理强度须与输入清单一致。标签是 runner 的固定名称，不是凭据。 |
| `CANDIDATE` | 冻结候选清单：完整 Git commit、归档路径及 SHA-256、解包目录、文件 hash；当前正式模式的 `configuration` 为 `{}`。 |
| `PINS` | 对应候选的运行时清单；`sqlite.entry` 必须为 `src/index.ts`，绑定源码、依赖、Node 版本和 SDK。 |
| `PREFLIGHT` | 配套的输入审计 JSON，包含 `identity.selected`、`inputs`、`models`、`referenceRevision`。 |

这些清单必须描述磁盘上的真实材料；不要把旧绝对路径替换成新路径后就当作同一次运行，也不要编造 hash 来绕过检查。现有 `lme-zh-preflight.py` 面向历史中文资产，`evaluate.py pin` 也不是这组三模式所需全部清单的通用生成器。缺少配套材料时，需要先准备新的输入批次；本教程不以空清单或合成快照替代真实输入。

三组必须复用相同题面、参考答案和快照。参考答案只交给裁判，不能出现在答题输入中。更换题集、参考、模型、候选代码或快照，应建立新轮次，不能覆盖旧结果。

## 3. 配置模型

以下展示外部配置文件的结构；路径和模型必须替换成与本次输入批次匹配的值。文件不是插件的 `compaction-recall.json`。

```json
{
  "sdk_path": "/absolute/candidate/node_modules/@earendil-works/pi-coding-agent",
  "helper_path": "/absolute/repository/benchmark/lme-helper.py",
  "data_path": "/absolute/lme16/data/index.json",
  "output_dir": "/absolute/new-results",
  "candidate_repo": "/absolute/candidate",
  "system_prompt": "You are a helpful assistant.",
  "protocol": { "segments": 4, "reserve_tokens": 16384, "overhead_tokens": 4096 },
  "compression": { "provider": "your-provider", "model": "your-compression-model", "effort": "high", "profile": "/absolute/benchmark-profile" },
  "answer": { "provider": "your-provider", "model": "your-answer-model", "effort": "high", "profile": "/absolute/benchmark-profile" },
  "judge": { "provider": "your-provider", "model": "your-judge-model", "effort": "xhigh", "profile": "/absolute/benchmark-profile" }
}
```

使用专门的评测 profile，事先配置好 Pi SDK 可读取的 `models.json` 和 `auth.json`。配置只保存 profile 路径，不把凭据复制到仓库或日志里。裁判配置采用同样结构，分别设置 `judge`；不要在已开始的轮次中改模型。

输出目录不得覆盖或包含源码、配置、profile、数据和快照目录。候选代码应来自指定 commit 的完整归档，安装锁定依赖后记录运行时 hash；不要直接用仍在编辑的工作区作为真实答题候选。

## 4. 检查三模式接线

准备好候选及依赖后，可以先跑阻断网络的 SDK 检查。`CANDIDATE_ROOT` 是候选解包目录，`SMOKE_OUT` 必须是不存在的新目录：

```sh
node benchmark/coding-recall/e2e/lme-zh-smoke.mjs \
  --three-arms "$CANDIDATE_ROOT" "$SMOKE_OUT"
```

此检查使用合成会话和隔离 profile，验证工具注册、实际工具执行及自动提示，不是模型跑分。

| 模式 | `--arm` | 工具 | 自动提示 |
|---|---|---|---|
| Pi 原生 | `pi-native` | 无 | 无 |
| lite | `pi-lite` | grep / expand | 无 |
| full | `pi-full` | recall / grep / expand | 有 |

lite / full 均加载候选的正式 `src/index.ts`，runner 在隔离配置中选择模式。不要用旧 grep-only 包装器代替本轮 lite，也不要用历史原型代替本轮 full。

## 5. 运行 LME16

在 Bash 中设置下面的变量。所有路径都指向上面已经准备好的材料；`OUT` 是新结果根目录，`COMMIT` 是完整 40 位提交 ID，`ARCHIVE_SHA256` 是对应归档的 64 位 SHA-256。

```sh
export DATA_ROOT="/absolute/lme16"
export SNAPSHOT_SOURCE="/absolute/native-snapshot-run"
export CONFIG="/absolute/config/answer.json"
export LUNA_CONFIG="/absolute/config/judge-luna.json"
export SOL_CONFIG="/absolute/config/judge-sol.json"
export CANDIDATE="/absolute/frozen/candidate.json"
export PINS="/absolute/frozen/pins.json"
export PREFLIGHT="/absolute/frozen/input-preflight.json"
export COMMIT="<full-40-character-commit>"
export ARCHIVE_SHA256="<64-character-archive-sha256>"
export TASK_ID="lme16-comparison"
export OUT="/absolute/new-results/lme16-comparison"
export STAGE=preflight
```

用下面同一条命令执行不同阶段。三组顺序运行，共用一个资源范围，不要启动三套各 8 路的并行池：

```sh
systemd-run --user --scope \
  -p MemoryMax=14G -p MemorySwapMax=0 \
  bash -c '
set -euo pipefail
for arm in pi-native pi-lite pi-full; do
  PYTHONDONTWRITEBYTECODE=1 python3 benchmark/coding-recall/e2e/lme-zh-run.py \
    --config "$CONFIG" --luna-config "$LUNA_CONFIG" --sol-config "$SOL_CONFIG" \
    --data-root "$DATA_ROOT" --snapshot-source "$SNAPSHOT_SOURCE" \
    --candidate "$CANDIDATE" --pins "$PINS" --preflight "$PREFLIGHT" \
    --commit "$COMMIT" --archive-sha256 "$ARCHIVE_SHA256" --task "$TASK_ID" \
    --output "$OUT/$arm" --language en --arm "$arm" --workers 8 \
    --english-answer-soft-estimate --stage "$STAGE"
done'
```

| `STAGE` | 会做什么 | 模型调用 |
|---|---|---|
| `preflight` | 核对输入、候选、快照、SDK 模型描述和序列化工具。 | 不发送答题或判分请求。 |
| `pilot` | 每组先答首题，并由两位裁判判分。 | 有费用；首题计入该组 16 题，不另做一份答卷。 |
| `all` | 复用已完成首题，继续其余题目及正确/错误判分。 | 有费用；不额外做 1–10 分评分。 |
| `flow` | 完整答题和正确/错误判分，再做独立的 1–10 分评分。 | 有费用；比 `all` 多一套评分请求。 |

建议先 `preflight`，通过后改成 `pilot`；确认首题链路正常，再改成 `all`。每次只修改 `STAGE`，重用相同的其他参数和输出目录。当前正式模式要求 `--workers 8`，资源上限由 runner 实际检查，不是仅供参考的建议。

示例中的 `--english-answer-soft-estimate` 将字符数估算仅用于诊断，不提高实际上下文或输出预算；服务商拒绝容量时停止调度新题，不靠重试绕过。每组的答题过程可能包含多次模型和工具调用，不能把 16 道题理解为只有 16 次 API 请求。

## 6. 查看结果与续跑

只做 `all` 时，运行离线报告器生成汇总。下面命令读取本轮已有结果并写入报告，不调用模型：

```sh
for arm in pi-native pi-lite pi-full; do
  python3 benchmark/coding-recall/e2e/lme-zh-report.py --run "$OUT/$arm"
done
```

| 产物 | 用途 |
|---|---|
| `manifest.json` | 输入身份、选题、候选、模型、完成状态与失败记录。 |
| `progress.json`、`resource.json` | 当前进度、实际并发及共享 cgroup 内存观测。 |
| `answer-ledger.json` | 已保存的答卷索引。 |
| `results/<arm>/<id>/result.json` | 单题答案、调用及会话绑定。 |
| `judge-v2/<judge>/<arm>/<id>/result.json` | 单题正确/错误判分及原始裁判结果。 |
| `REPORT.md`、`aggregate.json` | 本组 DEV8、HARD8、合计及失败统计。 |
| `grade-1to10/` | 仅在额外运行细分评分时生成，不替代正确/错误判分。 |

比较时固定一个判题口径，分别展示 DEV8、HARD8 和合计。缺失、服务商错误、判分失败不等于答错；人工复核应单独保存，不覆盖原始裁判。跨轮次取峰值时须说明，不能把拼接值称作同一轮实测。

中断后先检查进度和失败记录，再以相同参数、相同输出目录续跑。runner 会核对输入和代码身份，复用已完成记录；身份变化、未知的在途状态或缺失的完成证据会拒绝恢复。不要删除账本来强制重放，也不要改旧 manifest 来迁就新配置。

会话、答案、裁判理由、工具摘录和实际请求可能含完整语料，留在私有结果目录；公开时只输出必要指标、来源与 hash。

## 7. SWE-chat 与检索指标

SWE-chat 回忆题使用单独的 `benchmark/coding-recall/e2e/run-swechat.py`。这些题是从 [SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat) 会话派生的本地 QA，不是上游自带题集；需要完整的外部题集、原生快照和工具定义清单，仅下载上游数据不能还原。

```sh
python3 benchmark/coding-recall/e2e/run-swechat.py --help
```

如果要测的是检索排序、证据覆盖或查询行为，而非最终答题正确率，使用 `retrieval-group1.mjs` / `retrieval-group2.py`；输入接口和指标见 [检索评测接口](../benchmark/methods/RETRIEVAL_CONTRACT.md)。不要把合成检索夹具当作真实压缩会话答题成绩。

## 8. 性能与计时口径

计时日志的开启方法见 [配置与行为参考](PLUGIN.md)。性能对照使用相同语料、分支、查询及运行环境，分别测无插件基线、冷索引和热索引；答题正确率不是性能指标。

| 指标 | 如何理解 |
|---|---|
| 索引构建/重建时间 | 后台工作耗时，不是每次请求都支付的开销。 |
| `critical_path_index_wait` | 请求实际等待索引就绪的时间；冷启动等待不能从用户可见延迟里扣掉。 |
| `auto_context_total` | 自动提示处理的完整等待时间。 |
| `tool_history_recall_total` 等 | 工具调用从开始到返回的总耗时。 |
| `worker_roundtrip_*` / `worker_*` | 前者包含队列、传输和执行，后者是 worker 内部执行；不能重复相加。 |
| `index_memory` | 进程 RSS、主线程堆、worker 堆等不同观测，不是互斥项，也不是纯索引大小。 |

阶段耗时可能嵌套或重叠，父阶段不能再加子阶段。RSS 包含整个进程与原生分配，SQLite 内存不一定反映在 JavaScript 堆中；额外内存需要和等条件基线比较，不能把总 RSS 当作插件净开销。

答题墙钟包含模型请求和工具往返，不是服务商 TTFT。使用 token 统计时区分输入、输出和缓存字段；未记录的延迟、费用或内存留作未知，不用估计补齐。
