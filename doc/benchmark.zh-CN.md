# 如何运行 benchmark

[English](benchmark.md) | [简体中文](benchmark.zh-CN.md)

[项目说明](../README.zh-CN.md) | [配置与行为参考](PLUGIN.zh-CN.md)

当前维护入口是 `benchmark/run.py`：固定英文 LME16 的 Pi 原生 / lite / full 对比，以及 SWE-chat 派生回忆题。当前 LME 数据集为 `LME16-English`。`runner/` 管准备、调度与持久化，`judging/` 管判分契约与执行，`sdk/` 管实际Pi SDK及证据观察。benchmark 随源码提供，不进入 npm 包。

离线测试只验证产品与接线；真实答题和判分需要另行授权，会产生模型费用。下面的运行示例不是模型调用授权。

## 1. 环境与离线检查

需要 Node.js >=24.18.0、Python 3 和项目锁定依赖。真实运行要求 Linux cgroup v2、systemd 用户服务，以及一个共享的 14 GiB、零 swap 运行范围。

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
python3 benchmark/run.py --help
python3 benchmark/report.py --help
```

真实 SDK / worker 检查使用隔离合成 profile 和阻断网络，不调用真实模型；输出必须是不存在的外部目录：

```sh
node benchmark/smoke.mjs \
  --three-arms "$CANDIDATE_ROOT" "$NEW_SMOKE_OUT"
```

`CANDIDATE_ROOT` 是包含 `src/index.ts`、package 元数据及已安装锁定依赖的源码目录。检查会加载实际入口、执行真实工具并验证 0/2/3 工具集及仅 full 自动提示，不是静态源码断言。

## 2. 提供输入，不再手工拼配套清单

LME16 使用 [LongMemEval_M](https://huggingface.co/datasets/xiaowu0162/longmemeval) 的固定 DEV8 和 HARD8，各8题；不是完整 LongMemEval 或新随机抽样。来源和冻结题号见 [输入资料](../benchmark/data/release-0.1.0/INDEX.md)。公开元数据和中文题面不能重建被外置的原文、reference 或 native snapshot。

| 调用者输入 | 用途 |
|---|---|
| `--config` | 一份非凭据模型配置；含答题、两位裁判、profile 路径和可选预算。 |
| `--data-root` | 外部题集、参考答案及其源材料。 |
| `--snapshot-source` | LME16 完整英文原生轮次的目录，含 `manifest.json` 和逐题原生快照引用。SWE 可直接使用题集中的快照绑定。 |
| `--output` | 新的外部结果目录，或身份完全一致的已有结果目录供恢复。 |
| `--source-root` | 被测源码和锁定依赖所在目录；省略时使用当前仓库。 |

LME题集保留 `data/dev8/<id>/`、`data/hard8/<id>/` 下的 `question.json`、`corpus.json`、`answer.json`、`judge.json`；快照复用已有原生压缩，不新增压缩。SWE使用外部 `freeze.json`、`questions.json`、`gold.json`，题目带实际 snapshot 路径和hash；这些题来自本地 SWE-chat 会话派生，不是上游现成QA。

runner 的准备阶段是唯一清单 owner：由实际源码/锁定依赖、题面/reference、模型配置和已有快照生成并冻结候选与输入绑定。**不再提供 `CANDIDATE`、`PINS`、`PREFLIGHT`、两份裁判配置或手工 archive/commit hash，不再依赖历史中文 preflight。** 原冻结材料和历史指标仍保持原值，不用新代码重写旧fingerprint。

显式源码目录提供的是实际被测字节；Git提交只作来源信息，不能把未提交运行时代码冒称为提交中的字节。准备阶段冻结副本和hash，后续阶段核对同一身份。三模式共享一次候选冻结和相同题面/reference/snapshot；gold只给裁判，不混入答题请求。

## 3. 一份模型配置

例如外部 `models.json`：

```json
{
  "answer": { "provider": "your-provider", "model": "your-answer-model", "effort": "high" },
  "judges": {
    "luna": { "provider": "your-provider", "model": "your-first-judge", "effort": "xhigh" },
    "sol": { "provider": "your-provider", "model": "your-second-judge", "effort": "medium" }
  },
  "profiles": {
    "answer": "/absolute/benchmark-profile",
    "luna": "/absolute/benchmark-profile",
    "sol": "/absolute/benchmark-profile"
  },
  "protocol": { "reserve_tokens": 16384, "overhead_tokens": 4096 },
  "system_prompt": "You are a helpful assistant."
}
```

所有模型、服务商和effort显式给出；`luna` / `sol` 是两位独立裁判的角色名，不是固定模型默认值。profile 可以引用同一专用评测目录，事先准备 SDK 可读的模型/凭据文件；配置仅保存路径，不复制凭据内容。SDK 校验真实 model/effort，不选隐式个人默认，也不钳制不支持的effort。

## 4. 准备及运行

准备只确定性生成并核对源码/依赖、题面/reference、模型配置和snapshot清单，不打开profile、不启动SDK或provider：

```sh
python3 benchmark/run.py \
  --config "$CONFIG" --data-root "$DATA_ROOT" \
  --snapshot-source "$SNAPSHOT_SOURCE" --output "$OUT" \
  --arm all --stage prepare
```

随后使用相同输入和输出目录，改阶段即可。三模式由同一个runner顺序执行，不再用 shell 循环拼三套参数、配置和gate：

`pilot` / `all` / `flow` 在共享资源范围中首先执行可恢复的实际SDK序列化预检，停在网络发送前；通过后才发答题请求。此前也可用第1节的隔离三arm smoke检查生产接线。

```sh
systemd-run --user --scope \
  -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py \
    --config "$CONFIG" --data-root "$DATA_ROOT" \
    --snapshot-source "$SNAPSHOT_SOURCE" --output "$OUT" \
    --arm all --workers 8 --stage flow
```

| 选项 | 含义 |
|---|---|
| `--arm pi-native` | 无扩展、历史工具或自动locator。 |
| `--arm pi-lite` | 正式生产入口，正式mode=lite，grep/expand，无自动提示。 |
| `--arm pi-full` | 正式生产入口，正式mode=full及产品默认。默认只运行full。 |
| `--arm all` | 在同一共享范围顺序运行三模式，全局最多8个在途会话。 |
| `--stage prepare` | 冻结输入/候选及模型身份；不打开profile或调用SDK/provider。 |
| `--stage pilot` | 每arm首题和两位strict裁判；首题计入题集，不另跑答卷。 |
| `--stage all` | 复用首题，完成答题和strict判分。 |
| `--stage flow` | 再对相同答案做独立1–10评分和报告；不替代strict。 |

冻结的 `benchmark/grep-only-adapter.mjs` 是历史证据，不属于当前 lite，当前 CLI 不加载它。

最多8个并发会话，`--workers` 可选1–8；资源边界实际检查，不是口头约定。字符估算仅诊断；实际provider容量拒绝停止新调度，不靠重试绕过。有限普通provider重试保留各次证据；未知在途状态拒绝重放。

SWE使用同一个真实入口和编排，不保留空壳转发CLI：

```sh
systemd-run --user --scope \
  -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py \
    --dataset SWE-chat --config "$CONFIG" --data-root "$SWE_DATA_ROOT" \
    --output "$SWE_OUT" --arm pi-full --stage flow
```

## 5. 报告、失败与恢复

完成的答卷和两套原始判分持久化，strict与1–10独立。错误、缺答案、判分失败不等于答错或0分。人工复核另列，不覆盖机器判分；历史峰值不能冒称当前轮次。

`completed` 只包含答题成功且两份strict判分成功的题；独立1–10阶段同样要求两位裁判结果成功。全部所选题完成才是 `complete`；部分成功为 `partial`，没有成功完成的题为 `failed`，这些失败终态令CLI非零退出。`flow` 遇到答题/strict失败只保存报告，不继续1–10请求；1–10失败时总报告显示该阶段的失败终态，并单列 `answerStrictState`。

每位裁判及子集报告都明确 `selected / scored / failed / pending`。accuracy和均分只用scored记录；例如 `selected=16, scored=1, failed=15` 的 `1/1` 不是16题满分。

`--arm all` 的各arm结果位于输出目录下的对应arm目录；单arm使用指定输出。`manifest.json` 保存冻结身份与终态；结果、attempt和会话按内容hash绑定，报告只读取已有产物。需要单独生成离线报告时：

```sh
python3 benchmark/report.py --run "$ARM_OUT"
```

恢复使用同一条入口、同一配置/题面/源码/快照和输出目录；已完成阶段复用，不重复模型调用。身份改变、未知在途标记、完成证据缺失或篡改会拒绝恢复。不要删除账本或改旧manifest强制重放；更换输入或代码建立新轮次。

复用任何answer/judge结果都必须同时有匹配identity、`state=complete`和result hash的完成凭证，且session hash不变。丢失凭证、inflight、identity/hash漂移会明确拒绝恢复，不因结果文件存在而隐式重放provider。

容量拒绝保留 `capacity-blocked` 及已完成/失败/未开始的阶段证据，不将缺判分的半成品加入completed。该终态在同目录重入时只校验证据并重写报告，不重发已完成或容量拒绝请求，也不启动新的provider请求；需要新的调用应另建轮次，不删除凭证或覆盖旧产物。

已验收的当前版本三模式非正文指标见 `benchmark/data/lme16-current-three-arms-20261006.json`。

原题/reference/答案/裁判理由/摘录/会话/实际wire留在外部私有目录；公开仅投影必要指标与来源hash。历史资料的代码路径、CLI和指标仍绑定记录时的提交，不是当前可执行入口；文件迁移或配置迁移不会重新标记历史结果，也不会重放历史运行。

## 6. 性能与计时

开启计时见 [配置与行为参考](PLUGIN.zh-CN.md)。用相同语料、分支、查询和环境比较无插件、冷索引、热索引；模型答题正确率不是性能指标。保留实际索引等待、worker构建/查询、context与工具调用阶段；不再维护旧JS索引/原型策略的平行模拟评测框架。

阶段耗时可能嵌套，不能加总父子阶段；RSS包含进程和原生内存，不能当作插件净开销或把主/worker RSS相加。答题wall不等于服务商TTFT；token统计区分输入、输出和cache，未知指标保持未知。
