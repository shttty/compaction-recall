# 如何运行 benchmark

[English](benchmark.md) | [简体中文](benchmark.zh-CN.md)

[项目说明](../README.zh-CN.md) | [配置与行为参考](PLUGIN.zh-CN.md)

使用 `benchmark/run.py` 比较固定英文 LME16 题集上的 Pi 原生 / lite / full 三种模式，并运行 SWE-chat 派生回忆题。当前 LME 数据集为 `LME16-English`。`runner/` 准备、调度并保存运行，`judging/` 定义并执行判分，`sdk/` 运行实际 Pi SDK 并观察证据。benchmark 随源码提供，不进入 npm 包。

离线测试只验证产品及其接入；真实答题和判分需要另行授权，会产生模型费用。下面的运行示例不授权模型调用。

## 1. 环境与离线检查

需要 Node.js >=24.18.0、Python 3 和项目锁定依赖。真实运行要求 Linux cgroup v2、systemd 用户服务，以及一个共享运行范围，内存上限为 14 GiB，swap 为零。

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
python3 benchmark/run.py --help
python3 benchmark/report.py --help
```

真实 SDK / worker 检查使用隔离的合成 profile，并阻断网络，不调用真实模型。输出必须是尚不存在的外部目录：

```sh
node benchmark/smoke.mjs \
  --three-arms "$CANDIDATE_ROOT" "$NEW_SMOKE_OUT"
```

`CANDIDATE_ROOT` 是包含 `src/index.ts`、package 元数据及已安装锁定依赖的源码目录。检查会加载实际入口、执行真实工具，验证 0/2/3 工具集以及仅 full 模式提供的自动提示。

## 2. 提供输入

LME16 使用 [LongMemEval_M](https://huggingface.co/datasets/xiaowu0162/longmemeval) 的固定 DEV8 和 HARD8 子集，各 8 题；不使用完整 LongMemEval 数据集，也不重新随机抽样。来源和冻结题号见 [输入资料](../benchmark/data/release-0.1.0/INDEX.md)。公开元数据和中文题面无法重建存于仓库外的原文、参考答案或原生快照。

| 调用者输入 | 用途 |
|---|---|
| `--config` | 一份不含凭据的模型配置，包含答题模型、两位裁判、profile 路径和可选预算。 |
| `--data-root` | 外部题集、参考答案及其源材料。 |
| `--snapshot-source` | LME16 完整英文原生轮次的目录，含 `manifest.json` 和逐题原生快照引用。SWE 可直接使用题集中的快照绑定。 |
| `--output` | 新的外部结果目录，或身份完全一致的已有结果目录供恢复。 |
| `--source-root` | 被测源码和锁定依赖所在目录；省略时使用当前仓库。 |

LME 题集保留 `data/dev8/<id>/`、`data/hard8/<id>/` 下的 `question.json`、`corpus.json`、`answer.json`、`judge.json`。快照复用已有原生压缩，不新增压缩。SWE 使用外部 `freeze.json`、`questions.json`、`gold.json`，将实际快照路径和哈希绑定到题目。这些题由本地 SWE-chat 会话派生，不是上游现成的问答题。

runner 的准备阶段根据实际源码及锁定依赖、题面及参考答案、模型配置和已有快照，生成并冻结候选与输入绑定。不要提供 `CANDIDATE`、`PINS`、`PREFLIGHT`、两份裁判配置或手工 archive / commit hash。runner 独立于历史中文 preflight 运行。原冻结材料和历史指标保持原值，不得用新代码重写旧指纹。

显式源码目录提供实际被测字节。Git 提交只作来源信息，不能把未提交的运行时代码冒称为提交中的字节。准备阶段冻结副本和哈希，后续阶段核对同一身份。三种模式共享一次候选冻结和相同题面 / 参考答案 / 快照；标准答案只给裁判，不混入答题请求。

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

所有模型、服务商和 effort 都必须显式给出。`luna` / `sol` 是两位独立裁判的角色名，不是固定模型默认值。profile 可以引用同一专用评测目录；需事先准备 SDK 可读的模型 / 凭据文件。配置仅保存路径，不复制凭据内容。SDK 校验实际模型和 effort，不选取隐式个人默认值，也不将不支持的 effort 调整为受支持的值。

## 4. 准备及运行

准备阶段确定性地生成并核对源码及依赖、题面及参考答案、模型配置和快照清单，不打开 profile，也不启动 SDK 或服务商：

```sh
python3 benchmark/run.py \
  --config "$CONFIG" --data-root "$DATA_ROOT" \
  --snapshot-source "$SNAPSHOT_SOURCE" --output "$OUT" \
  --arm all --stage prepare
```

随后保持输入和输出目录不变，只更改阶段。runner 会顺序执行三种模式。

`pilot` / `all` / `flow` 首先在共享资源范围中，通过实际 SDK 执行可恢复的序列化预检，停在网络发送前。预检通过后才发送答题请求。运行前也可用第 1 节的隔离三模式 smoke 检查生产接入。

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
| `--arm pi-native` | 无扩展、历史检索工具或自动定位提示。 |
| `--arm pi-lite` | 生产入口，生产 mode=lite，提供 grep/expand，无自动提示。 |
| `--arm pi-full` | 生产入口，生产 mode=full，使用产品默认设置。默认只运行 full。 |
| `--arm all` | 在同一共享范围顺序运行三种模式，全局最多 8 个在途会话。 |
| `--stage prepare` | 冻结输入 / 候选及模型身份；不打开 profile 或调用 SDK / 服务商。 |
| `--stage pilot` | 运行每种模式的首题和两位 strict 裁判；首题计入题集，不另跑答卷。 |
| `--stage all` | 复用首题，完成答题和 strict 判分。 |
| `--stage flow` | 再对相同答案做独立的 1至10 评分并生成报告；不替代 strict 判分。 |

冻结的 `benchmark/grep-only-adapter.mjs` 是历史证据，不属于当前 lite，当前 CLI 不加载它。

最多 8 个会话并发，`--workers` 可选 1至8。runner 会检查资源边界。服务商实际拒绝容量请求时，runner 停止新调度，不重试该请求。字符估算仅用于诊断。有限的普通服务商重试会保留每次尝试的证据；未知在途状态禁止重放。

SWE 使用同一个入口和编排：

```sh
systemd-run --user --scope \
  -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py \
    --dataset SWE-chat --config "$CONFIG" --data-root "$SWE_DATA_ROOT" \
    --output "$SWE_OUT" --arm pi-full --stage flow
```

## 5. 报告、失败与恢复

完成的答卷和两套原始判分结果都会保存，strict 与 1至10 评分相互独立。错误、缺失答案和判分失败不等于答错或 0 分。人工复核单独列出，不覆盖机器判分；历史峰值不能冒称当前轮次结果。

`completed` 只包含答题成功且两份 strict 判分成功的题；独立的 1至10 阶段同样要求两位裁判的结果均成功。全部所选题完成才是 `complete`；部分成功为 `partial`，没有成功完成的题为 `failed`。这些失败终态令 CLI 非零退出。`flow` 遇到答题 / strict 判分失败时只保存报告，不继续发出 1至10 请求；1至10 评分失败时，总报告显示该阶段的失败终态，并单列 `answerStrictState`。

每位裁判及子集报告都明确列出 `selected / scored / failed / pending`。正确率和均分只使用已评分记录；例如，`selected=16, scored=1, failed=15` 的 `1/1` 不代表 16 题满分。

使用 `--arm all` 时，各模式结果位于输出目录下的对应模式目录；单模式使用指定输出目录。`manifest.json` 保存冻结身份与终态；结果、尝试和会话按内容哈希绑定，报告只读取已有产物。单独生成离线报告：

```sh
python3 benchmark/report.py --run "$ARM_OUT"
```

恢复时使用同一入口、相同配置、题面、源码、快照和输出目录。已完成阶段会复用，不重复调用模型。身份改变、未知在途标记、完成证据缺失或遭篡改时，会拒绝恢复。不要删除账本或修改旧清单以强制重放；输入或代码更改后，应建立新轮次。

复用任何答题 / 裁判结果，必须有身份匹配、`state=complete` 且结果哈希匹配的完成凭证，会话哈希也必须保持不变。凭证丢失、在途状态、身份或哈希漂移都会明确阻止恢复。结果文件的存在不会隐式触发服务商请求重放。

容量拒绝会保留 `capacity-blocked` 及已完成 / 失败 / 未开始阶段的证据；缺少判分的未完成结果不会计入 completed。在同目录重新进入该终态时，只校验证据并重写报告，不重发已完成或容量被拒的请求，也不启动新的服务商请求。新调用需要另建轮次；不要删除凭证或覆盖旧产物。

已验收的当前版本三种模式的非正文指标见 `benchmark/data/lme16-current-three-arms-20261006.json`。

原题 / 参考答案 / 答案 / 裁判理由 / 摘录 / 会话 / 实际传输数据保留在外部私有目录；公开内容仅包含必要指标与来源哈希。历史资料的代码路径、CLI 命令和指标仍绑定记录时的提交，不是当前可执行入口。文件或配置迁移不会重新标记历史结果，也不会重放历史运行。

## 6. 性能与计时

开启计时见 [配置与行为参考](PLUGIN.zh-CN.md)。使用相同语料、分支、查询和环境，比较无插件、冷索引和热索引；模型答题正确率不是性能指标。保留实际索引等待、worker 构建 / 查询、上下文与工具调用阶段。旧 JS 索引 / 原型策略的平行模拟评测框架已停止维护。

阶段耗时可能嵌套，不能加总父子阶段。RSS 包含进程和原生内存，不能当作插件净开销，也不能把主进程和 worker 的 RSS 相加。答题总耗时不等于服务商 TTFT。token 统计区分输入、输出和缓存；未知指标保持未知。
