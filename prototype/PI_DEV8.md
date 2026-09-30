# Actual Pi DEV8: native, grep, indexed recall

Completed 2026-09-30. Pi **0.99.1**, subscription provider **openai-codex/gpt-6-luna**, thinking **high**. Eight original independent LongMemEval_M DEV8 histories, not the ten-history stack. All **24 final answer sessions** exited successfully. No neural reranker and no judge model were used.

## Findings

Direct post-run comparison against reference answers finds **6/8 target answers in grep** and **7/8 in indexed recall**. This is a manual, single-run reference comparison, not an independent blind/model-judge accuracy measurement. Both retrieval arms missed the Airbnb temporal answer (five months ago). Indexed recall recovered the camera-collection duration (three months), whereas grep did not. Native has seven clear misses and one explicitly uncertain snapper guess containing the reference; do not present this as an unambiguous 0/8 or 1/8 formal score. Both retrieval answers on the snapper question also include caveats about which dish was specifically described as Jamaican.

| Question | Native | Grep + expand | Indexed recall + grep + expand |
|---|---|---|---|
| 778164c6, snapper | Correct candidate, explicitly unverified guess | Target present, caveat | Target present, caveat |
| 51b23612, Soviet cartoon | Missing | Target present | Target present |
| ceb54acb, four terms | Missing | All four | All four |
| 577d4d32, email cutoff | Wrong, 10pm | 7pm | 7pm |
| 3d86fd0a, Sophia | Missing | Coffee shop | Coffee shop |
| 15745da0, cameras | Missing | Missing | Three months |
| gpt4_65aabe59, devices | Missing | Thermostat first | Thermostat first |
| 982b5123, Airbnb | Missing | Lead time, not five months ago | Lead time, not five months ago |

Complete answers, reference strings, tool arguments, token usage, session paths and snapshot hashes are in [pi-dev8-results.json](pi-dev8-results.json). References were added only during post-run reporting, never supplied to answer processes.

## Observed answer speed

Wallclock starts before context preflight and Pi process launch, ends when the full answer exits. Includes startup and all model/tool rounds; excludes history compaction. Up to four histories were processed concurrently, arms within a history in fixed native → grep → indexed order. Cache warmth, concurrency, different model decisions and number of rounds confound isolated latency comparisons. Each cell is one run; no uncertainty interval or stable throughput claim.

| Arm | Median seconds | p95 nearest rank (= max for n=8) | Tool calls | Observed assistant responses |
|---|---:|---:|---:|---:|
| Native | 14.71 | 19.76 | 0 | 8 |
| Grep | 24.40 | 36.98 | 15 | 23 |
| Indexed | 26.46 | 39.08 | 19 | 26 |

| Question | Native s | Grep s | Indexed s |
|---|---:|---:|---:|
| 778164c6 | 14.04 | 36.98 | 35.23 |
| 51b23612 | 18.09 | 23.66 | 26.23 |
| ceb54acb | 15.38 | 19.28 | 19.40 |
| 577d4d32 | 19.76 | 25.14 | 19.76 |
| 3d86fd0a | 11.41 | 13.09 | 27.74 |
| 15745da0 | 16.40 | 26.85 | 39.08 |
| gpt4_65aabe59 | 12.46 | 18.26 | 26.69 |
| 982b5123 | 11.94 | 26.01 | 24.53 |

No reliable time-to-first-token, tokens/second, or pure per-tool execution timings were instrumented. Session entry timestamps are not substituted for those measurements. The indexed arm was slightly slower end-to-end here while retrieving one additional target answer; this does not contradict earlier isolated retrieval-speed tests.

## Protocol and isolation

Six size-balanced original-history segments per question, native compaction after each of the first five, append segment six, then answer. **40 shared compaction RPCs**. Original benchmark conversion, newline-only JSONL reader, chunking and official question prompt are imported from sibling lme-bench without changing its snapshot functions. Each arm gets a fresh copy of the same per-question snapshot; all eight sets of snapshot hashes are verified identical across arms. Fresh agent directories and in-memory indexes prevent cross-question lookup. Native provider authentication is referenced from the project profile without copying tokens. No raw corpus, auth or session logs are added to Git.

- Native: no recall extension and no tools; common safety-only hook remains
- Grep: actual history_grep + history_expand; no auto hints or history_recall; descriptions remove references to unavailable tools
- Indexed: auto top-five hints + history_recall + history_grep + history_expand; experimental in-memory inverted index, shared production lexical ranking, dedup, snippet and page formatting

The indexed adapter is prototype-only; production recall still scans. Automatic compaction disabled. Answer models have no filesystem/web/builtin tools. A common guard runs after context/system transforms on every answer/tool round; it exits before inference if over the conservative ceiling. A simple thrown hook error would be swallowed by Pi, so the guard deliberately terminates the isolated process.

## Context configuration and recoveries

Initial six-segment runs used the catalog's 272,000 context metadata and 240,000 conservative preflight ceiling including a 5,000-token prompt/tool reserve. Safety blocked two Sophia retrieval attempts and an intermediate device-history compaction. User then requested **372,000** metadata; supported project-profile `models.json` modelOverrides changed only openai-codex/gpt-6-luna, verified offline. Guard became **340,000**, same reserve. No model substitution or segmentation change.

Two histories hit a harness Unicode splitting bug: Python splitlines() incorrectly split U+2028 inside JSON strings. Fixed with existing benchmark newline-only parsing and an offline regression. Saved raw history prefixes/content were verified before resuming. Remaining work was **10 compactions + 11 answer sessions**, reusing completed summaries and successful answers rather than rebuilding them. Individual answer records identify the 272k/240k or 372k/340k configuration. This mixed metadata history is a limitation even though all final observed input counts were below272k.

Final maximum reported compaction input: **183,948 tokens**; maximum answer input including cache: **205,763**. Conservative character estimates exceed actual provider counts on these texts. Configuration alone does not establish server capacity or billing rules.

## Usage and extra work

Final shared compactions: 6,778,634 reported input, 58,997 output tokens; summed RPC wall time1,773.7s (parallel, not elapsed time), median36.8s, max122.9s. Final answer usage:

| Arm | Uncached input | Cache read | Output |
|---|---:|---:|---:|
| Native | 1,536,368 | 0 | 1,241 |
| Grep | 1,366,438 | 3,094,528 | 1,823 |
| Indexed | 1,580,162 | 3,478,528 | 2,225 |

Reported reasoning counts are available separately in JSON; do not add them again to output without checking provider accounting. These are usage counts, not subscription charges.

There are57 observed completed answer-model responses across the final24 sessions. Compaction RPCs can internally make more than one model request (history summary and split-turn summary), and HTTP retries were not instrumented: **40 RPCs +57 assistant responses is not an exact HTTP-request total**.

Extra work is preserved and excluded from final-comparison totals: READY smoke, one successful pilot compaction, interrupted four-segment run with11 recorded successful compactions and one native answer plus two interrupted stage statuses, two six-segment safety-blocked answer attempts, and pre-model CLI setup failures. No claim of zero cost for interrupted/failed requests. Their original run directories retain recorded usage/status; missing interrupted usage cannot be reconstructed exactly.

## Files and reproduction

- `pi-dev8.py`: new run with `--segments 6 --jobs 4 --run UNIQUE_NAME`, optional first-compaction `--pilot`
- `pi-dev8-resume.py`: exact recorded checkpoint recovery; verifies history prefix/content, never automatic bulk retry
- `pi-benchmark-adapter.mjs`, `pi-context-guard.mjs`, `pi-context-estimate.mjs`: arm isolation/indexed retrieval and context checks
- `summarize-pi-dev8.py`: post-run reference/usage/speed aggregation, no inference
- `test_pi_dev8.py`: offline Unicode regression

Requires separately installed Pi0.99.1 and an already authorized sibling lme-bench/.pi-profile; never reads credentials into report output. Profile and runs are ignored. Raw session/tool results remain under lme-bench/runs/pi-subscription-dev8-six-20260930 and pi-subscription-dev8-resume372-20260930. Current runner uses372k profile override/340k guard; historical manifests preserve earlier settings. Model responses/summaries are stochastic, so rerunning does not promise identical answers.

Verification: typecheck +41 Node tests, Python Unicode regression, context guard threshold checks, project skill validation, and git diff check passed. No commit or push for this work.

## Subsequent instrumentation

[Stage/UX timing](TIMING.md) was added after this run, with mock/offline real-history checks only. It does not retroactively add first-text, pure tool or index-stage times to these completed answer records. Current reproduction source contains that forward-only instrumentation in addition to the code hashes recorded during the run.
