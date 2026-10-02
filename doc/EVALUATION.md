# 显式外部配置与评测协议

当前入口是 `benchmark/evaluate.py`。没有内置 provider、model、effort、个人 profile 或兄弟仓库路径。历史 CLP 方法见 [HISTORICAL_EVALUATION.md](HISTORICAL_EVALUATION.md)，冻结结果见 [BENCHMARK.md](BENCHMARK.md)；下面的命令不是已执行的新跑分。

## 外部配置

每次 `prepare`、`pin`、`run` 都必须传 `--config FILE`。JSON 必须恰好包含以下字段。示例中的大写标记必须由调用者替换；不提供凭据值或可用默认模型：

```json
{
  "sdk_path": "SDK_PACKAGE_DIRECTORY",
  "helper_path": "OFFICIAL_HELPER_FILE",
  "data_path": "ORIGINAL_LONGMEMEVAL_M_JSON",
  "output_dir": "NEW_EXTERNAL_OUTPUT_DIRECTORY",
  "candidate_repo": "CANDIDATE_GIT_REPOSITORY",
  "system_prompt": "EXPLICIT_SYSTEM_PROMPT",
  "protocol": {
    "segments": 4,
    "reserve_tokens": 8192,
    "overhead_tokens": 4096
  },
  "compression": {
    "provider": "COMPRESSION_PROVIDER",
    "model": "COMPRESSION_MODEL",
    "effort": "SUPPORTED_EFFORT",
    "profile": "EXTERNAL_COMPRESSION_PROFILE"
  },
  "answer": {
    "provider": "ANSWER_PROVIDER",
    "model": "ANSWER_MODEL",
    "effort": "SUPPORTED_EFFORT",
    "profile": "EXTERNAL_ANSWER_PROFILE"
  },
  "judge": {
    "provider": "JUDGE_PROVIDER",
    "model": "JUDGE_MODEL",
    "effort": "SUPPORTED_EFFORT",
    "profile": "EXTERNAL_JUDGE_PROFILE"
  }
}
```

相对路径按配置文件所在目录解析。`sdk_path` 是已安装的 `@earendil-works/pi-coding-agent` 包目录；当前桥接接口明确支持 SDK **1.0.0**。每个外部 profile 必须包含 SDK 原生 `models.json` 与 `auth.json`，并在 `models.json` 显式声明所选 provider/model。runner 不创建或复制认证配置，不执行配置初始化 shell 命令，不读取个人 settings 或 `.env`。profile 由用户在仓外预先管理；可以给多个阶段指定同一个 profile。

协议数字是示例，不是隐式默认值：`segments >= 2`，reserve/overhead 是非负整数；压缩可用上下文来自明确选定模型的 SDK descriptor。未知字段、缺文件、未声明模型、无效协议或 SDK 不支持的 effort 都拒绝，不回退模型，不把 effort 自动降档。输出必须在本 checkout 外，且不能与配置、helper、数据、SDK、候选仓库或 profile 重叠。

SDK bridge 使用 `ReadOnlyAuthStorage`、内存 settings/model store，关闭资源自动发现和模型目录网络刷新。只装载本次显式 pin 的扩展：native 无扩展，grep 仅 wrapper，production 仅候选包入口。compression/judge 不加载检索扩展。OAuth 刷新若需要写回只读认证会失败；请在运行前由用户于仓外更新认证，不能依靠 benchmark 修改 profile。

## 官方 helper 与数据

提供已有官方 LongMemEval Python helper 源文件。支持历史 `bench.py` 的如下定义：

- 函数：`parse_date`、`iso`、`build_session`、`chunk_cuts`、`jsonl_lines`、`append_entries`。
- 常量：`DEV8`、`ASK`、`_BASE`、`_STEPS`、`_TAIL`、`JUDGE`、`ABSTAIN`、`CHARS_PER_TOKEN`。

加载器从显式文件选取这些 AST 定义，保留 session/chunk/prompt 函数体；**不导入其顶层 `.env`、provider/bootstrap 或 chat 实现**。不支持的定义形式明确报错。helper 是调用者信任的代码，不是沙箱；不要提供不可信文件。`RUNS` 指向外部输出，`MODEL` 仅作为旧 session 构造所需的压缩模型元数据注入。

需要原始 LongMemEval_M JSON，不是 oracle-only 历史。准备阶段的流式 JSON 读取需要调用环境另行安装 `ijson`；仓库不捆绑数据，也不自动安装或下载它。输入 hash 按块读取，不把完整 M 数据读入内存。DEV8 使用 helper 定义；HARD8 使用保留的结构/标签筛选规则，见历史方法。金答案单独放入 judge 数据，不送入答题历史。

## 命令

从仓库根目录运行。模型评测、压缩与判分必须另行获得授权：

```sh
python3 benchmark/evaluate.py --help
python3 benchmark/evaluate.py pin --help
python3 benchmark/evaluate.py run --help

# 以下需真实外部配置/数据；不是离线测试命令。
python3 benchmark/evaluate.py prepare --config "$CONFIG" --set dev8
python3 benchmark/evaluate.py pin --config "$CONFIG" --plugin-ref "$FULL_40_HEX_COMMIT"
python3 benchmark/evaluate.py run --config "$CONFIG" --set dev8 --run "$NEW_RUN" --plugin-ref "$FULL_40_HEX_COMMIT"
```

`--config` 也可放在子命令前。`run --set` 支持 `dev8` / `hard8`；`prepare --set` 另支持 `both`。只有 run 接受 `--only QUESTION_ID`，用于限定已准备样本。候选必须是显式完整 commit，不接受 `HEAD` 或缩写。归档依据该 commit 的 `package.json` 中唯一 `pi.extensions` 入口收集运行闭包，兼容历史根布局与当前 `src/` 布局；不依赖硬编码历史 commit 白名单。

`run` 顺序执行 native / grep / production。三组复用同一保护的压缩快照，分别复制答题 session。compression、answer、judge 都调用正常 SDK session/RPC；不自建 provider 传输。judge 使用 helper 的原始判分 prompt；只有独立 yes/no 才能作为判分，模糊响应保留为 judge-error。

## 恢复与证据边界

新 manifest 使用 `pi-evaluation-v3` 配置身份：配置路径/内容、所有阶段模型和 effort、协议、helper/数据/profile 文件 hash、SDK package 元数据、runner/锁文件，以及候选和 wrapper 指纹都参与验证。认证内容不进入 manifest，只记录文件 hash。会话、金答案和标准化配置在外部输出，不应提交回仓库。

相同配置的已完成 arm 读取持久结果，不新增压缩/答题/判分调用。影响运行的配置或输入改变则拒绝恢复；不确定的 inflight 状态也拒绝自动重放。新源码/目录/配置指纹与旧 runner 不同，**不能恢复、迁移标签或冒充旧 run/cache**。外部旧产物和冻结报告原样保留。

## 离线证据

```sh
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

Python suite 从 CLI main 经真实 run/answer 到 RPC 边界，使用两份明确不同的合成模型/effort 配置，覆盖三组、零新增调用恢复、配置变化拒绝、快照保护与 Unicode。另有真实 SDK 三组启动/get_state 检查，只发 get_state，不发送模型 prompt；网络 guard 拒绝意外请求。Node suite 实际加载 SDK descriptor、当前 package/src 入口，并检查 profile 不被修改。合成 helper/profile/session 只存在临时 fixture；不是官方数据，也不构成真实评测分数。
