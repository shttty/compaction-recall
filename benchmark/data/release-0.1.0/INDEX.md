# 0.1 benchmark：来源、处理与复现边界

公开索引是 [manifest.json](manifest.json)。保留七轮、96个完成case的非正文指标与原输入/输出hash；不公开英文原题、参考/gold正文、模型答案、裁判理由、检索摘录或全文会话。唯一题面例外是用户授权的 [LME16中文冻结译文](lme16/zh)，16题逐字UTF-8 hash及原question ID在manifest中。所有benchmark材料排除在npm之外。

## 来源

- 原始 [LongMemEval_M](https://huggingface.co/datasets/xiaowu0162/longmemeval/tree/2ec2a557f339b6c0369619b1ed5793734cc87533)：`longmemeval_m`，SHA-256 `fb5413e3b077c62927daab794836991a2fcfa61ceacab57dc679fb02daaff2d9`。不是cleaned版本。固定DEV8加`hard8-turn-label-v2`共16个ID；原英文题及原始历史可按ID从外部数据提取。
- [上游软件/判题prompt](https://github.com/xiaowu0162/LongMemEval/tree/9e0b455f4ef0e2ab8f2e582289761153549043fc)与原始数据分别声明MIT；保留[软件notice](source/LongMemEval-prompt-notice.md)及[来源许可证据](source/license/primary-evidence.json)。
- [SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat)：观察card revision为`202b071f18e03c79df5a7287565ce2ebc5ee7756`，下载revision未知。SWE-chat8是用户授权、从六份本地Pi session派生的八道回忆题，**不是上游现成QA题集**。六源池去重为四个使用家族，每家族两题；manifest保留文件/hash、native compaction、firstKeptEntryId和证据坐标，不保留正文。ODC-By数据库归属与软件MIT不混用；数据按上游适用许可另取。

## 处理与固定输入

LME按会话时间排序，保持原question date；四段历史、三次native Pi compaction，复用真实snapshot。中文由deepseek-flash翻译并有冻结复核，2026-10-03冻结；本树只分发最终中文题面，不含翻译历史语料。公开题面不替代runner需要的`corpus.json`、`corpus-zh.json`、`question-zh.json`完整外部输入。

`778164c6`参考修订的版本/hash与旧中文grading input分开；没有重判。SWE派生题面、标准答案和坐标在运行前冻结，构造题集前provider调用为0，没有新压缩调用。七轮candidate、SDK、tool/prompt配置、model/effort/concurrency、snapshot和判分输入hash分开记录，不能合称同一版本实验。

原始strict/1–10机器指标保留；judge-error不是答错，也不补造得分。SWE最新strict仍为两裁判各7/8；sw08人工接受独立列入`humanReview`，不改称机器8/8。旧性能JSON仅作历史，白名单投影去正文/个人路径，原数字未重标为当前SQLite性能。

## 现有命令及外部前提

当前runner/支持代码唯一归属本树，见[benchmark运行指南](../../../doc/benchmark.zh-CN.md)；旧实验归archive，不依赖来源工作树。`sourceVersions`保留每轮原代码hash，当前闭包不冒称覆盖所有旧源码。目录归属、SDK bridge、离线smoke与structured/legacy计分标记按现有维护版本收口，CLI在启动前检查外部输入。历史hash与96份原输出不改写；逐字旧轮回放仍需匹配hash的外部源码、candidate和snapshot。

先提供显式外部DATA_ROOT、CONFIG、LUNA_CONFIG/SOL_CONFIG、CANDIDATE、PINS、PREFLIGHT、SNAPSHOT_SOURCE、TASK_ID、COMMIT及ARCHIVE_SHA256。配置用本树的SDK/helper或匹配hash的外部candidate资产，不以旧工作树路径为前提；凭据不入git。原flow要求共享14-GiB/no-swap cgroup。下面是复现命令，不是本次模型运行授权；当前完整入口见[benchmark运行指南](../../../doc/benchmark.zh-CN.md)。

```sh
RUNNER=benchmark
PYTHONDONTWRITEBYTECODE=1 python3 "$RUNNER/coding-recall/e2e/lme-zh-run.py" --help
PYTHONDONTWRITEBYTECODE=1 python3 "$RUNNER/coding-recall/e2e/run-swechat.py" --help

# 原英文LME原题按固定ID准备：现有prepare读取显式外部配置。
# CONFIG中data_path指向外部原始M数据、helper_path指向匹配helper、output_dir指向新外部目录。
PYTHONDONTWRITEBYTECODE=1 python3 benchmark/evaluate.py prepare --set both --config "$CONFIG"

# 实际LME运行入口；完整外部历史/题集及native snapshot需提前提供。
PYTHONDONTWRITEBYTECODE=1 python3 "$RUNNER/coding-recall/e2e/lme-zh-run.py" \
  --data-root "$DATA_ROOT" --config "$CONFIG" \
  --luna-config "$LUNA_CONFIG" --sol-config "$SOL_CONFIG" \
  --candidate "$CANDIDATE" --pins "$PINS" --preflight "$PREFLIGHT" \
  --commit "$COMMIT" --archive-sha256 "$ARCHIVE_SHA256" --task "$TASK_ID" \
  --snapshot-source "$SNAPSHOT_SOURCE" --output "$OUT/lme16" \
  --language en --arm pi-restored-grep --han-phrase-trial jieba --workers 8 --stage flow

# SWE本地派生冻结题集及选定snapshot必须由使用者提供，不能只下载上游还原。
PYTHONDONTWRITEBYTECODE=1 python3 "$RUNNER/coding-recall/e2e/run-swechat.py" \
  --data-root "$SWE_DATA_ROOT" --candidate-root "$CANDIDATE_ROOT" \
  --config "$SWE_CONFIG" --luna-config "$LUNA_CONFIG" --sol-config "$SOL_CONFIG" \
  --tool-definition-manifest "$TOOL_DEFINITION_MANIFEST" \
  --commit "$COMMIT" --task "$TASK_ID" --output "$OUT/swe-chat8"
```

逐字复现缺口：翻译历史/复核过程、修订参考、SWE自制题集、旧轮源码、candidate包、native snapshot及原始输出均需匹配`externalArtifacts`/`sourceVersions`的外部资产。模型重跑即使输入一致也不保证逐字答案一致。公开中文题面可校验16题译文；公开元数据可核对机器分数/错误、人工复核分离及来源绑定，不能重建被外置的正文。
