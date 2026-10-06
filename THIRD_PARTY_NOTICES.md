# Third-party notices

## Project origin

`compaction-recall` was extracted from
`pi-lossless-context/prototype/recall-spike`, based on
`62012df340d0774698ece6705062777b82d2f0e3` and the then-uncommitted recall
changes; the initial standalone extraction is `3f73d6a`. This provenance does
not make the broader project's DAG, SQLite storage or compaction implementation
part of this standalone plugin, nor does it assert an absence of historical
design influence.

The project's own [MIT LICENSE](LICENSE), Copyright (c) 2026 shttty, is separate
from the evaluation-material notice below.

## LongMemEval evaluation material

- Dataset: [xiaowu0162/longmemeval](https://huggingface.co/datasets/xiaowu0162/longmemeval).
- Upstream project: [LongMemEval](https://github.com/xiaowu0162/LongMemEval).
- Upstream license: [MIT, Copyright (c) 2024 Di Wu](https://github.com/xiaowu0162/LongMemEval/blob/main/LICENSE).

The archived model evaluations use the **ORIGINAL LongMemEval_M**, not the
cleaned release, LongMemEval_S, or oracle-only histories. Upstream now recommends
a cleaned release; that does not change the source of these frozen historical
evaluations. The dataset publisher labels the original dataset MIT.

This repository publishes source/processing/run metadata and the 16 user-authorized
frozen Chinese LME16 question translations, not English original questions, reference
answers, model outputs or retrieved excerpts. Full datasets and fixed evaluation
artifacts are obtained separately. Synthetic offline tests are a distinct category.
The runtime has no LongMemEval dependency or automatic dataset download; benchmark
materials are excluded from npm, whose aggregate contains only historical metrics.

For retained upstream evaluation material, the copyright and license notice is:

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

## 0.1 runtime dependency

`@node-rs/jieba` 2.0.3 is MIT licensed, Copyright (c) 2020-present LongYinan.
Its installed package includes its MIT LICENSE; production loads it only in the
native worker. SQLite is supplied by Node's built-in `node:sqlite`, not by a
separately bundled npm database binary. Project MIT does not replace dependency
notices distributed with Node or the installed native packages.

## Frozen 0.1 research archive (git only)

Sources, processing, fixed-input hashes, runner/judge code and non-text metrics
are indexed at `benchmark/archive/release-0.1.0/INDEX.md`. Only the 16 frozen Chinese
LME question translations are retained as question text. Original English/SWE
questions, references, answers and excerpts are not distributed. Software MIT and
the original LongMemEval dataset's independent MIT declaration remain identified.

Contains information from [SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat),
which is made available under the [Open Data Commons Attribution License (ODC-By)
v1.0](https://opendatacommons.org/licenses/by/1-0/). Citation: Baumann, Padmakumar,
Li, Yang, Yang and Koyejo, *SWE-chat: Real-World AI Coding Sessions in the Wild*,
COLM 2026, <https://arxiv.org/abs/2604.20779v2>.

ODC-By identifies SWE-chat database rights, not an inferred license over every
transcript's contents; the source download revision is recorded as unknown.
We do not distribute SWE questions, answers or transcript excerpts. Obtain required
data upstream under its applicable license and provide matching external
derived/frozen inputs for exact replay. Software MIT and dataset attribution remain
separate. The benchmark manifest records hashes/provenance without credentials,
profiles, private absolute paths, full histories or provider wire.
