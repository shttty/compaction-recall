# 代码场景评测：当前数据源

本记录覆盖旧 coding-dev8-warning-jieba-20261006/TASK.md 与 FULL-SNAPSHOTS-AUTHORIZATION.md 中的数据源、选题和补压安排。

## 用户已定

使用 SWE-chat 的 6 个 Pi 原始 session。用户原话：“先这6个，其他等插件适配codex Claudecode后再做”。当前授权为小批代码回忆端到端评测；候选 0ecff723655300550d58ae6c6cc5a3d8da22ee07，沿用现有答题/判分模型，最多8路。

资产根目录：`/home/rinne/.hermes/task-runs/recall-soft-match-20261003/public-sessions/swe-chat/`
候选清单：`pi-selected-cap5.json`；分叉家族信息：`selected-families.json`。

## 已核实的会话

2026-10-06 直接读取本地原始 JSONL：下列每份均有至少4条非空 summary 且 tokensBefore >= 250000 的原生 compaction 记录。数字来自源记录，不是本轮重新压缩或provider实测。

| 相对路径 | 仓库 | 全部压缩 / 合格大上下文压缩 |
|---|---|---|
| transcripts1/019ff006-9273-7e80-9303-0b30d84e3102.jsonl | codyborders/yinshi | 13 / 10 |
| transcripts1/019ffa52-e03f-7134-befa-04021cfdfc2c.jsonl | codyborders/yinshi | 12 / 7 |
| transcripts1/019f4e6f-89f2-7f82-9bf9-a4790d571aa6.jsonl | codyborders/yinshi | 5 / 5 |
| transcripts1/019ff614-16b1-7bfc-bdb4-3ee5e2bca1c5.jsonl | codyborders/yinshi | 9 / 6 |
| transcripts1/019ff614-1925-7910-9d9f-ba84c0ff8172.jsonl | codyborders/yinshi | 9 / 6 |
| transcripts/019eca64-8c2c-7b00-90c6-3aa49738c497.jsonl | entireio/cli | 4 / 4 |

这些会话可能共享分叉前历史；6份文件不等于6个独立样本。沿既有家族记录核对来源和去重，复用真实原生压缩。`transcripts_compact` 简化格式不等于上下文压缩快照。

## 已撤销的误接路线

Hermes误选了旧200题codingbench中的本地OMP/拼接会话，把“有题集”当成这次指定的数据源。旧q030等8题及3case补压安排已撤销；“至少12次新压缩是必需”的判断不适用于SWE-chat路线。旧题不能直接套在新session上。

保留原会话、旧题集、旧快照和结果。当前先查这6份SWE-chat对应的既有选题/答案/证据资产；若缺题集，报告最小缺口，不擅自重建200题、改用旧数据源或新增压缩。OMP的 `e2e/coding-dev8-warning-jieba-20261006/source-correction.json` 已回报旧路线撤销、未启动后台、无新增压缩/答题/判分或在途调用。其已检查资产中未找到绑定这6份session的现成questions/gold和逐题快照。下一步缺口是小批题目、原文证据坐标及原生切点绑定，不是补压。两个019ff614-*分叉与019ff006-*共享历史；既有selected-families.json还多列一份不在这6份中的会话，不直接替换来源或把共享历史重复计为独立样本。
