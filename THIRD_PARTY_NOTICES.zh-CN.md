# 第三方声明

[English](THIRD_PARTY_NOTICES.md) | [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

## 项目来源

`compaction-recall` 从 `pi-lossless-context/prototype/recall-spike` 提取，基于
`62012df340d0774698ece6705062777b82d2f0e3` 及当时尚未提交的 recall 修改；
最初的独立提取提交为 `3f73d6a`。这些来源记录并不意味着原项目的 DAG、SQLite
存储或压缩实现属于本独立插件，也不表示不存在历史设计影响。

项目自身的 [MIT 许可证](LICENSE)，Copyright (c) 2026 shttty，与下述评测材料
声明彼此独立。

## LongMemEval 评测材料

- 数据集：[xiaowu0162/longmemeval](https://huggingface.co/datasets/xiaowu0162/longmemeval)。
- 上游项目：[LongMemEval](https://github.com/xiaowu0162/LongMemEval)。
- 上游许可证：[MIT, Copyright (c) 2024 Di Wu](https://github.com/xiaowu0162/LongMemEval/blob/main/LICENSE)。

归档的模型评测使用 **原始 LongMemEval_M**，不是清理后的发行版、LongMemEval_S，
也不是仅含 oracle 历史的版本。上游现在推荐清理后的发行版，但这不会改变这些
已冻结历史评测的来源。数据集发布者将原始数据集标为 MIT。

本仓库公开来源、处理和运行元数据，以及用户授权的 16 道冻结中文 LME16 题面译文；
不公开英文原题、参考答案、模型输出或检索摘录。完整数据集和固定评测产物需另行获取。
合成离线测试属于不同类别。运行时不依赖 LongMemEval，也不自动下载数据集；
benchmark 材料不进入 npm 包。

保留的上游评测材料适用以下版权和许可证声明。**下方逐字保留原始英文许可证引用；
本中文说明不替代任何许可证的法律正文。**

```text
MIT License

Copyright (c) 2024 Di Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 0.1 运行时依赖

`@node-rs/jieba` 2.0.3 使用 MIT 许可证，Copyright (c) 2020-present LongYinan。
其安装包包含自身的 MIT LICENSE；生产实现只在原生 worker 中加载它。
SQLite 由 Node 内置的 `node:sqlite` 提供，不是单独打包的 npm 数据库二进制。
项目的 MIT 许可证不替代随 Node 或已安装原生包分发的依赖声明。

## 冻结的 0.1 研究归档（仅 Git）

来源、处理、固定输入 hash、runner/judge 代码和非正文指标的索引位于
`benchmark/data/release-0.1.0/INDEX.md`。作为题目正文保留的只有 16 道冻结中文
LME 题面译文；不分发原始英文/SWE 题目、参考答案、答卷或摘录。软件 MIT 许可证
与原始 LongMemEval 数据集的独立 MIT 声明仍分别标明。

包含来自 [SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat) 的信息，
该数据集按 [Open Data Commons Attribution License (ODC-By) v1.0](https://opendatacommons.org/licenses/by/1-0/)
提供。引用：Baumann, Padmakumar, Li, Yang, Yang and Koyejo,
*SWE-chat: Real-World AI Coding Sessions in the Wild*, COLM 2026,
<https://arxiv.org/abs/2604.20779v2>。

ODC-By 标识 SWE-chat 的数据库权利，不应据此推断每份会话正文都适用同一许可证；
来源下载版本记录为未知。我们不分发 SWE 题目、答卷或会话摘录。请依照上游适用的
许可证获取所需数据，并提供匹配的外部派生/冻结输入以精确重放。软件 MIT 许可证与
数据集归属说明彼此独立。benchmark manifest 记录 hash 和来源，不包含凭据、profile、
私有绝对路径、完整历史或服务商 wire。
