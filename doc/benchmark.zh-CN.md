# 如何运行 benchmark

[English](benchmark.md) | [简体中文](benchmark.zh-CN.md)

[项目说明](../README.zh-CN.md) | [配置与行为参考](PLUGIN.zh-CN.md)

使用 `benchmark/run.py` 比较固定 `LME16-English` / `LME16-Chinese` 题集上的 Pi 原生 / lite / full，以及显式提供的第三方 Pi package，并运行 SWE-chat 派生回忆题。`runner/` 准备、调度并保存运行，`judging/` 定义并执行判分，`sdk/` 运行实际 Pi SDK 并观察证据。benchmark 随源码提供，不进入 npm 包。

离线检查和 `--stage prepare` / `--stage preflight` 不授权付费运行。真实答题和判分须另行授权，会产生模型费用；runner 的 package 压缩始终为零模型调用。下面的示例仅说明用法，不授权模型或网络请求；维护代码的授权也不等于开跑评测的授权。

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
| `--snapshot-source` | 原生压缩来源，含 `manifest.json` 和逐题快照引用。英文使用其原生来源；中文可使用历史 `lme16-zh-rawfts` 中真实的 Pi 原生压缩快照，但该轮答卷来自扩展，不是无插件基线。SWE 可直接使用题集中的快照绑定。 |
| `--output` | 新的外部结果目录，或身份完全一致的已有结果目录供恢复。 |
| `--source-root` | 被测源码和锁定依赖所在目录；省略时使用当前仓库。 |
| `--package-root` | 已安装的第三方 Pi package 完整目录，包括其 `node_modules`；`--arm package` 必填。 |
| `--compression native\|package` | 仅 package arm：复用原生快照，或按冻结原生切点在源历史上调用 package 压缩钩子。 |
| `--baseline-source` | 用于精确绑定题面 / 参考答案 / 提示词的历史答题目录；`LME16-Chinese` 必填，英文可选。不代表历史 arm 是原生。 |

LME 题集保留 `data/dev8/<id>/`、`data/hard8/<id>/` 下的 `question.json`、`corpus.json`、`answer.json`、`judge.json`。旧三 arm 和 `--compression native` 复用已有原生压缩；`--compression package` 使用原始时间顺序历史和三个已验证的原生切点，不新增切点。`LME16-Chinese` 通过 `--baseline-source` 绑定历史 2026-10-06 中文提示词及参考答案，原生快照来源单独绑定。SWE 使用外部 `freeze.json`、`questions.json`、`gold.json`，将实际快照路径和哈希绑定到题目。这些题由本地 SWE-chat 会话派生，不是上游现成的问答题。

runner 的准备阶段根据实际源码及锁定依赖、题面及参考答案、模型配置和已有快照，生成并冻结候选与输入绑定。不要提供 `CANDIDATE`、`PINS`、`PREFLIGHT`、两份裁判配置或手工 archive / commit hash。历史中文 preflight 不能复用为原生快照证据。原冻结材料和历史指标保持原值，不得用新代码重写旧指纹或写入旧轮次。

历史中文 rawfts 来源保留真实原生压缩条目及切点，历史 simulated 预检不具备该证据。这里不暗示或提供中文无插件答卷基线。`--baseline-source` 单独绑定历史 2026-10-06 `zh-full` 的提示词 / 参考答案，不得将该轮重新标记为原生答卷。

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

通用 package 沿用相同的 `answer` / `judges` 配置，不新增独立压缩模型键；压缩使用答题模型描述符。生成的 SDK 配置保留冻结候选的 `sdk_path`，不改用第三方 package 依赖中的 SDK。即使模型描述符已存在，离线 preflight 仍阻断网络。

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
| `--arm all` | 在同一共享范围顺序运行旧三模式，全局最多 8 个在途会话；不包含 `package`。 |
| `--arm package` | 加载 `--package-root` 提供的已安装 package 冻结副本；不假定包名、工具数量或存储实现。 |
| `--stage prepare` | 冻结输入 / 候选 / package 及模型身份；不打开 profile 或调用 SDK / 服务商。 |
| `--stage preflight` | 离线执行准备、所选 package 压缩及真实 SDK 序列化；停在答题发送和裁判运行前。 |
| `--question-id ID` | 可重复，仅供明确授权的 `prepare` / `preflight` 离线子集；不能缩小付费固定题集。 |
| `--stage pilot` | 运行每种模式的首题和两位 strict 裁判；首题计入题集，不另跑答卷。 |
| `--stage all` | 复用首题，完成答题和 strict 判分。 |
| `--stage flow` | 再对相同答案做独立的 1至10 评分并生成报告；不替代 strict 判分。 |

冻结的 `benchmark/grep-only-adapter.mjs` 是历史证据，不属于当前 lite，当前 CLI 不加载它。

最多 8 个会话并发，`--workers` 可选 1至8。runner 会检查资源边界。服务商实际拒绝容量请求时，runner 停止新调度，不重试该请求。字符估算仅用于诊断。有限的普通服务商重试会保留每次尝试的证据；未知在途状态禁止重放。

### 通用已安装 Pi package

冻结前由调用者安装运行时依赖：package 有 lockfile 时使用 `npm ci --omit=dev`，否则在解包后使用 `npm install --omit=dev`。安装可能访问网络，不属于离线 prepare / preflight；需要独立授权，或已有缓存依赖。

准备阶段将完整已安装目录（含 `node_modules`）冻结到 `OUT/package`，文件字节只读。SDK 只加载 package 声明的 `pi.extensions` 和 `pi.skills`，不猜入口，也不加载个人 profile 中的环境扩展。工具动态发现，全部已注册工具描述符保留到序列化请求；答题恢复必须与冻结 preflight 证据相同。裁判不加载扩展。

可重复传入 `--package-root FIRST --package-root SECOND`，按命令行顺序加载：每个目录分别冻结、哈希到 `OUT/packages/<序号>` 并记录有序身份，压缩与答题加载同一组完整工具和钩子，不做筛选。

压缩和答题共享 `OUT/homes/<question-id>`，package 状态可跨恢复保留。序列化预检在 `OUT/serialization/<question-id>` 下使用私有 HOME 克隆，不改变题目的持久 HOME。压缩证据独立保存在 `OUT/compression/<question-id>/snapshot.json`，因此离线子集可以已有压缩记录但没有答卷。SDK 证据包括 `tools.json`、`sdk-registration.json`、压缩钩子 / 事件、工具执行及上下文 / 实际传输 payload 观察。

`--compression native` 复用冻结原生快照；`--compression package` 在相同三个原生切点上调用 package 处理源历史，并始终要求零模型压缩，付费答题阶段也不例外。压缩器尝试访问服务商时明确失败，不回退到原生快照或伪造摘要；压缩需要模型的包应选用 `native`。

英文一条命令离线预检，复用原生压缩。变量均指向显式外部输入；`QID_1` / `QID_2` 为已授权的冻结题号：

```sh
systemd-run --user --scope -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py --dataset LME16-English \
    --config "$CONFIG" --data-root "$EN_DATA_ROOT" \
    --snapshot-source "$EN_NATIVE_SOURCE" --package-root "$PACKAGE_ROOT" \
    --arm package --compression native --output "$NEW_EN_OUT" \
    --stage preflight --question-id "$QID_1" --question-id "$QID_2"
```

中文一条命令离线预检，实际执行 package 压缩并绑定历史提示词 / 参考答案：

```sh
systemd-run --user --scope -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py --dataset LME16-Chinese \
    --config "$CONFIG" --data-root "$ZH_DATA_ROOT" \
    --snapshot-source "$ZH_NATIVE_SOURCE" --baseline-source "$ZH_BASELINE_SOURCE" \
    --package-root "$PACKAGE_ROOT" --arm package --compression package \
    --output "$NEW_ZH_OUT" --stage preflight \
    --question-id "$QID_1" --question-id "$QID_2"
```

只冻结时改用 `--stage prepare`。离线子集身份不是完整付费轮次：取得明确授权后，应使用新输出目录、省略 `--question-id`，并继续显式提供完整输入绑定。下列英文、中文命令会进行 package 压缩、答题、strict 判分及独立 1至10 判分；未经对应授权均不得执行。英文示例也提供可选的精确历史基线绑定：

```sh
systemd-run --user --scope -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py --dataset LME16-English \
    --config "$CONFIG" --data-root "$EN_DATA_ROOT" \
    --snapshot-source "$EN_NATIVE_SOURCE" --baseline-source "$EN_BASELINE_SOURCE" \
    --package-root "$PACKAGE_ROOT" --arm package --compression package \
    --output "$NEW_AUTHORIZED_EN_OUT" --workers 8 --stage flow
```

```sh
systemd-run --user --scope -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py --dataset LME16-Chinese \
    --config "$CONFIG" --data-root "$ZH_DATA_ROOT" \
    --snapshot-source "$ZH_NATIVE_SOURCE" --baseline-source "$ZH_BASELINE_SOURCE" \
    --package-root "$PACKAGE_ROOT" --arm package --compression package \
    --output "$NEW_AUTHORIZED_ZH_OUT" --workers 8 --stage flow
```


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

Package 沿用相同单 arm 布局。`aggregate.json` / `REPORT.md` 从逐题 `compression/<question-id>/snapshot.json` 读取压缩秒数及 `contextBefore.estimatedTokens` / `contextAfter.estimatedTokens`，从答题尝试的 `tool-execution.jsonl` 读取工具毫秒耗时，从 `process-memory.json` 读取观察到的峰值 RSS。汇总显示中位数 / 最大值 / 记录数，并逐压缩阶段、逐工具汇总；缺失项标为 `未记录`，不当作零。token 估算不是服务商实际 usage。全部已记录答题尝试参与计时；只有 preflight 的轮次也能报告压缩，答题及裁判保持 pending。报告不依赖某个 package 的数据库字段，也不编造缺失基线指标。

恢复时使用同一入口、相同配置、题面、源码、快照和输出目录。已完成阶段会复用，不重复调用模型。身份改变、未知在途标记、完成证据缺失或遭篡改时，会拒绝恢复。不要删除账本或修改旧清单以强制重放；输入或代码更改后，应建立新轮次。

复用任何答题 / 裁判结果，必须有身份匹配、`state=complete` 且结果哈希匹配的完成凭证，会话哈希也必须保持不变。凭证丢失、在途状态、身份或哈希漂移都会明确阻止恢复。结果文件的存在不会隐式触发服务商请求重放。

容量拒绝会保留 `capacity-blocked` 及已完成 / 失败 / 未开始阶段的证据；缺少判分的未完成结果不会计入 completed。在同目录重新进入该终态时，只校验证据并重写报告，不重发已完成或容量被拒的请求，也不启动新的服务商请求。新调用需要另建轮次；不要删除凭证或覆盖旧产物。

已验收的当前版本三种模式的非正文指标见 `benchmark/data/lme16-current-three-arms-20261006.json`。

原题 / 参考答案 / 答案 / 裁判理由 / 摘录 / 会话 / 实际传输数据保留在外部私有目录；公开内容仅包含必要指标与来源哈希。历史资料的代码路径、CLI 命令和指标仍绑定记录时的提交，不是当前可执行入口。文件或配置迁移不会重新标记历史结果，也不会重放历史运行。

## 6. 性能与计时

开启计时见 [配置与行为参考](PLUGIN.zh-CN.md)。使用相同语料、分支、查询和环境，比较无插件、冷索引和热索引；模型答题正确率不是性能指标。保留实际索引等待、worker 构建 / 查询、上下文与工具调用阶段。旧 JS 索引 / 原型策略的平行模拟评测框架已停止维护。

阶段耗时可能嵌套，不能加总父子阶段。RSS 包含进程和原生内存，不能当作插件净开销，也不能把主进程和 worker 的 RSS 相加。答题总耗时不等于服务商 TTFT。token 统计区分输入、输出和缓存；未知指标保持未知。
