# Historical benchmark results

This is a clean aggregate of the frozen **2026-10-02** LongMemEval experiments, not a new evaluation of `pi-context-recall@0.1.0`. Counts below reproduce the original audits; no answers were regraded and no model, compression or benchmark runs were performed to prepare this document. Model identifiers describe historical evidence, not recommended or default configuration.

**Evidence access:** `shttty/pi-context-recall` is a **private GitHub repository**. All evidence links below require repository access; they do not imply public availability. Raw audits, reports, run records and provenance are **not included in the npm package**. This aggregate intentionally excludes question text, answers, sessions, personal configuration and raw provenance JSON. Links use the repository's `main` branch; the SHA-256 digests below identify the frozen bytes independently of a moving branch.

## Dataset and protocol

The source was the **original LongMemEval_M**, not S, a cleaned subset, or oracle-only history. The archived DEV8 final report records source SHA-256 `fb5413e3b077c62927daab794836991a2fcfa61ceacab57dc679fb02daaff2d9`. Each set contains eight independent original histories; the two sets are disjoint. The exact audit order is:

- **DEV8:** `778164c6`, `51b23612`, `ceb54acb`, `577d4d32`, `3d86fd0a`, `15745da0`, `gpt4_65aabe59`, `982b5123`.
- **HARD8:** `gpt4_7fce9456`, `gpt4_a1b77f9c`, `28dc39ac`, `gpt4_15e38248`, `6d550036`, `2ce6a0f2`, `9d25d4e0`, `gpt4_731e37d7`.

DEV8 is the original `bench.DEV8` selection. HARD8 used `hard8-turn-label-v2`: exclude DEV8; score metadata from explicit `has_answer` turns as `20 × min(labeled sessions, 5) + 3 × min(labeled turns, 8) + question-type bonus + cue bonus`. Type bonuses were knowledge-update 16, temporal-reasoning 12, multi-session 10 and preference 8; an update/distractor cue added 6. Discard scores below 34, retain the top 160 with deterministic ID/type tie-breaks, then inspect chronological session-builder order and actual four-segment boundaries. Require explicit answer turns in at least two of the first three segments and none in segment four; choose eight by score with an 8-point bonus for a not-yet-selected type and ID tie-break. The selected HARD8 contained seven multi-session questions and one temporal question. This is a difficulty hypothesis, not a representative random sample. Selection used labels and structure, not candidate answers or success; answer-session and turn labels were stripped from solver input, and gold remained judge-only. The historical report documents source-projection checks, not a rerun of the global ranking.

Protocol details are retained in the [historical evaluation document](https://github.com/shttty/pi-context-recall/blob/main/doc/HISTORICAL_EVALUATION.md) and [benchmark index](https://github.com/shttty/pi-context-recall/blob/main/doc/BENCHMARK.md). Four ordered segments produced three explicit Pi compactions and a common final question snapshot. Within each question, all three arms used the same actual snapshot bytes, SDK, answer-model configuration and prompt:

| Arm | Historical behavior |
| --- | --- |
| native | Pi with no extensions and no tools |
| grep | Pinned production `history_grep` and `history_expand` definitions through the immutable grep-only wrapper; automatic context hook suppressed |
| production | Pinned public package entry, automatic context locator, `history_recall`, `history_grep` and `history_expand` |

These are historical pinned arms, not a claim that the current package or every historical prototype had identical behavior.

## Eight formal groups

Every row has **8 graded answers per arm**, one answer run per question/arm: 24 records per row, 192 across the eight groups. Rows reuse selected questions and are separate answer rounds, not additional independent datasets. Counts are **correct / 8**, in native / grep / production order.

| Set / formal group | Answer model / requested effort | Plugin | Native | Grep | Production | Audit |
| --- | --- | --- | ---: | ---: | ---: | --- |
| DEV8 capacity-base | `clp/gpt-6-luna` / high | A | 0/8 | 5/8 | 7/8 | [audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-dev8-capacity-base-audit.json) |
| DEV8 capacity-paging | `clp/gpt-6-luna` / high | B | 0/8 | 6/8 | 8/8 | [audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-dev8-capacity-paging-audit.json) |
| DEV8 coverage | `clp/gpt-6-luna` / high | C | 0/8 | 4/8 | 7/8 | [audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-dev8-coverage-audit.json) |
| DEV8 grep-pages | `clp/gpt-6-luna` / high | D | 0/8 | 3/8 | 8/8 | [audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-dev8-grep-pages-audit.json) |
| HARD8 base | `clp/gpt-6-luna` / high | A | 1/8 | 1/8 | 3/8 | [audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-hard8-base-audit.json) |
| HARD8 paging | `clp/gpt-6-luna` / high | B | 0/8 | 1/8 | 2/8 | [audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-hard8-paging-audit.json) |
| HARD8 grep-pages | `clp/gpt-6-luna` / high | D | 0/8 | 1/8 | 3/8 | [audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-hard8-grep-pages-audit.json) |
| HARD8 Sol/high (`d4259198`) | `clp/gpt-6.1-sol` / high | D | 1/8 | 6/8 | 6/8 | [audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-hard8-sol-high-audit.json) |

All eight used **Pi SDK 1.0.0**, compression **`clp/gpt-6-luna` / high**, and judge **`clp/gpt-6-luna` / requested xhigh** with official LongMemEval question-type prompts and explicit yes/no grades.

### Effort: requested is not necessarily effective

The formal answer runs requested **high**, not xhigh. The Sol audit additionally verifies actual session reasoning level **high**. An earlier, separately retained **preparation proof** records a real SDK clamp: Pi SDK 1.0.0 was requested to use `gpt-6.1-sol` / **xhigh**, but a local loopback mock captured serialized `reasoning.effort=high`, output limit 8,192 and route `/v1/responses`. Its status was `blocked-sdk-effort-clamp`; it recorded **zero external provider/live model requests**. This is evidence of SDK request serialization, not a scored xhigh model experiment or evidence of provider-effective reasoning.

That external proof is identified by basename `sol-xhigh-prep-proof.json`, SHA-256 `2aad0d2bc140c8f3b14ce7bb80aa139c91efdee83db74b5fc76f4bdaa431730d`. The subsequent explicit-high preparation capture is `sol-high-acceptance-proof.json`, SHA-256 `32c52c3d8ac67048631b0a4bbb4fd4e3f58f957818b8d7e508063c39e767d45d`; the formal high preflight is `parent-hard8-sol-high-preflight.json`, SHA-256 `2f89074798a6d557925afaf9ea13b505e36c1a1aaeccad533efae6b43e4445c7`. These three proof files were inspected read-only and hashed for this summary; they remain outside the repository archive and npm package, so no GitHub download link is claimed for them. The later formal Sol/high run must not be relabeled as xhigh.

The [historical runner's `grade()` implementation](https://github.com/shttty/pi-context-recall/blob/954fd18af0f3554288a2d5683c6bf66e86aae754/prototype/clp-eval.py) calls the benchmark's `chat` helper directly, outside Pi SDK, and stores the helper's judge model/effort metadata. Accordingly, the judge label here means **requested xhigh**; the provider's effective reasoning effort is **unknown from the retained evidence**. It would be incorrect to relabel that judge “SDK-clamped high.” The Sol comparison is explicitly **Sol high**, not a Sol xhigh experiment.

### Full plugin and runner identities

| Plugin | Full commit | Historical candidate |
| --- | --- | --- |
| A | `f5715d1901b6bedf19811030f18f3733eefb7bc4` | Baseline |
| B | `7d1980b8b7512ec8568c3ddaaecdccb8e0ad4014` | Expand paging |
| C | `5acf40efa9cb33146d3e9526fc411a769511cee8` | Coverage/output-budget changes |
| D | `8149e1f6caece71de148c92a88790e5d35212d9e` | Grep pages, including earlier expand/coverage ancestry |

Audits record runner base commit `858ae2fe5729edf7067dc34d8f7bf902ab4423f4`. Later runs also record hash-frozen uncommitted runner changes; the base commit alone is not the complete runner identity:

| Groups | Historical runner file SHA-256 |
| --- | --- |
| DEV8 capacity-base / capacity-paging | `1047402ee8402de8a501d1d1be4c53ba9a72d6d443e14709a17dfc6c82ebddee` |
| DEV8 coverage; HARD8 base / paging | `96abdfebae58f8a612509f0ef6502e180c35b7b8712f9d06f179d9bc1a2f2777` |
| DEV8 / HARD8 grep-pages | `836f417cd465fb8300b9a84ae5ae372b0ceca3275e13ddfb9988dc7180a4e4e4` |
| HARD8 Sol/high | `d4259198e3290ffca46a3aa9245a74213aa076e8867b7079e8d70f96b6af3b55` |

## Exclusions and negative results

- **Failed capacity run:** `dev8-base-ed09d12`, SDK 1.0.0, Luna/high, plugin A, completed six of eight questions. Two questions stopped at preflight compression errors. Correct counts on the original eight-question denominator were **0/8 native, 4/8 grep, 6/8 production**, with 18 graded arm records and two compression-error records. This is **not** a clean completed DEV8 group and is not included among the eight formal rows. Compression failures must not be rewritten as judged incorrect model answers. The [original negative audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/dev8-base-ed09d12-audit.json) remains preserved.
- **Wrong-model pilot:** `hard8-sol-high-2ea9b1c9` actually used Luna and is excluded from Sol scores. The formal run is `hard8-sol-high-d4259198`. The Sol report separately excludes three wrong-model pilot records and 11 diagnostic answer calls. Independent pilot files were not imported into this repository archive; the original external evidence was retained, not replaced by a formal run.
- The archive contains 72 per-question runs and 210 final judge files: eight formal groups plus the incomplete capacity group. Audit, ledger and judge copies of the same answer are not separate observations. Earlier Pi 0.99.1 experiments, lexical indexing, reranking, timing smoke and TUI demonstrations are not pooled into these SDK 1.0.0 scores.

## What the results do and do not show

- This is a small, single-round, selected-history comparison. It does not establish general accuracy, a stable improvement, statistical significance or a clean causal effect. Native controls also vary across rounds.
- Paging production changed DEV8 from 7/8 to 8/8, but HARD8 from 3/8 to 2/8. Coverage did not improve DEV8 accuracy. Grep-pages matched earlier DEV8 8/8 and HARD8 baseline 3/8; its ancestry prevents an isolated grep-pagination ablation.
- DEV8 grep-pages observed no continuation-page requests, and production did not call `history_grep`. HARD8 grep-pages observed one genuine unchanged-pattern continuation; carrying an offset while changing the pattern was not continuation evidence. Scores do not establish broad pagination benefits.
- With the same plugin D and snapshots, Sol/high production scored 6/8 versus Luna/high 3/8. Sol grep also scored 6/8, but on a different set of questions. This neither establishes a stable model gain nor proves the automatic locator useless. Sol's configured maximum output was 8,192 tokens versus Luna's 128,000; model, configuration and provider effects are not independently isolated.
- Historical timing is answer wall time including tool rounds, not provider time-to-first-token. Answer usage includes SDK-normalized input/output/cache counters, excludes compression and judge usage, and is not a billing estimate. Provider TTFT, compression provider consumption and money cost remain unknown.
- Shared-snapshot checks, actual-session checks and zero-call guarded resumes are **historical audit findings**, not newly executed checks or fresh inference in this release preparation. Offline tests of the current evaluator do not validate model accuracy.

## Frozen evidence links and SHA-256

Digests below were computed from the retained frozen files for this aggregate. They identify bytes, not an independent revalidation of the original model calls. Historical reports include then-current pending-work statements; those statements are not current release status.

| Original evidence | SHA-256 |
| --- | --- |
| [Provenance import manifest](https://github.com/shttty/pi-context-recall/blob/main/benchmark/PROVENANCE.json) | `d27722392befac4d5f2430a49bd186029f333cf60e64e03864ee9aa8d06fb8de` |
| [DEV8 capacity-base audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-dev8-capacity-base-audit.json) | `490adf20df104f27547d1c2e7d5cf25a513446e37cd38a4a9c54ab9989284234` |
| [DEV8 capacity-paging audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-dev8-capacity-paging-audit.json) | `4ba85e055ef161ce70be4ac7a151b88cbfbd6a052c4ec5b9383494faf35b248a` |
| [DEV8 coverage audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-dev8-coverage-audit.json) | `cf0ef1d1e349d1b5e2d37cf037f701de6fa87deb3903629818dd1b76cda21645` |
| [DEV8 grep-pages audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-dev8-grep-pages-audit.json) | `ef18fad1e66aa9acc50151a7147e328f9162dbb97977feeb9561c26bd2d6597a` |
| [HARD8 base audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-hard8-base-audit.json) | `5dcc648c647cb5559590b9ee0e8e684f77dd2d60da00fb956dadd3c6c4d48d3f` |
| [HARD8 paging audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-hard8-paging-audit.json) | `7735bf5def53b7883ca9789dae028518282044ce4ff917f391ee92c662ab5f2e` |
| [HARD8 grep-pages audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-hard8-grep-pages-audit.json) | `153b90b1a2be8f255397ddd2097a43192abf749763ca6869c650ca438e814a4f` |
| [HARD8 Sol/high audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-hard8-sol-high-audit.json) | `052d61e3a2571783f0ed4dde55213039efae51ff2e6981d4b75f9fb9a6d10145` |
| [Incomplete capacity audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/dev8-base-ed09d12-audit.json) | `13cb7bb927268a310489065ece1074365f088e6f32dcc0d70ed78f34673cfad1` |
| [DEV8 actual-session audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-dev8-grep-pages-session-audit.json) | `2b39ce05df6bb2f3026ebe6206b4bb48b79cc8cc977802f52eef3a02041fd33e` |
| [HARD8 baseline session provenance](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-hard8-base-session-provenance.json) | `d91eb0004b4e7842b2d769c42c4b769e9e435d6609a730c995ea9d4814e65219` |
| [HARD8 actual-session audit](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/audits/parent-hard8-grep-pages-session-audit.json) | `bc22ee373a64c42dd25994f64e2f91895badac543e12bf048f371c2ecefbf4f0` |
| [DEV8 capacity comparison](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/reports/dev8-capacity-comparison.md) | `48569da88833ac4356fdf6b4baa5d9e12779862e5dbf77e8a0eb649807d44a2b` |
| [DEV8 final comparison](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/reports/dev8-final-comparison.md) | `87ac201dd3b635f8aeadbbf55219f7e9d6aa6c50b27309b30f340b4ecca650a3` |
| [DEV8 grep-pages comparison](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/reports/dev8-grep-pages-comparison.md) | `ddda120d24873a4f41849cf090ded5c2008316dc3e761256cef723bdda73d682` |
| [DEV8 historical acceptance](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/reports/dev8-grep-pages-full-accepted.md) | `cdcc79112cc4cf0f4e381827c65558ce15ba69c4a9bac3d61df62750f6df18f5` |
| [HARD8 final comparison](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/reports/hard8-final-comparison.md) | `b58b34502c20d713fe8caec2dd1787b89d00e6a052a1c94ec5a6742d87687014` |
| [HARD8 grep-pages comparison](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/reports/hard8-grep-pages-comparison.md) | `6605026088aff9d930d9bd0ad68ca64840e08078320bdd2572c9c7476922e373` |
| [HARD8 grep-pages comparison JSON](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/reports/hard8-grep-pages-comparison.json) | `7a7c144a1759439ffd331267c071b4cffba89bce4c7952ebf34efee464adc8aa` |
| [HARD8 Sol/high comparison](https://github.com/shttty/pi-context-recall/blob/main/benchmark/results/recall-20261002/reports/hard8-sol-high-comparison.md) | `292df87205596877cfa55d52b29914ee3dc451f8d3c529a23e6795ddc96ed4bd` |
