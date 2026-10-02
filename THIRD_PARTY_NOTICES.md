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

This repository retains selected evaluation excerpts and outputs, not the full
external dataset. Synthetic offline Node/Python unit-test fixtures are a separate
test category: this attribution identifies the archived evaluation source, not
all unit tests. The package runtime has no LongMemEval dependency and does not
automatically download data. Raw evaluation material is excluded from the npm
package; its clean historical aggregate identifies the evaluation source.

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
