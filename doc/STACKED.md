# Ten-real-haystack stacked stress experiment

This experiment concatenates ten distinct **original LongMemEval_M** question histories. It is an artificial stress workload made from real benchmark text, not one natural ten-million-token conversation, not ten independent QA evaluations, and not a model-context or model-answer test. No model calls, generated compactions, semantic search or production index switch are involved. The original single-question `results.json` and report remain unchanged.

## Selection and size

Deterministic order: original DEV8 with `577d4d32` first, followed by the first two additional `single-session-user` records in the complete dataset's existing file order. No answers are used for selection or query construction.

1. `577d4d32`: What time do I stop checking work emails and messages?
2. `778164c6`: Jamaican snapper dish previously recommended
3. `51b23612`: Soviet cartoon previously mentioned
4. `ceb54acb`: Four alternatives to “sexual compulsions”
5. `3d86fd0a`: Where did I meet Sophia?
6. `15745da0`: How long have I collected vintage cameras?
7. `gpt4_65aabe59`: Smart thermostat or mesh network set up first?
8. `982b5123`: Months since booking the San Francisco Airbnb
9. `e47becba`: What degree did I graduate with?
10. `118b2229`: How long is my daily commute to work?

These labels abbreviate some long questions only for this report. Retrieval uses each complete, unchanged original question. Exact questions, source hash and selection recipe are in `stacked-provenance.json`.

Corpus accounting:

- 5,012 declared sessions, of which 4,756 are nonempty
- 48,981 raw turns plus 379 date-only headers inserted for sessions that start with an assistant, yielding 49,360 searchable converted messages
- 48,692,918 UTF-16 text units after session-date prefixes; **~10.06 million tokens only under the old benchmark's 4.84-character/token heuristic**. This is not a token count from any current model's tokenizer
- 46,119 unique original role/text turns, containing 45,772,273 UTF-16 text units; physical original text contains 48,507,813 units
- 4,497 unique sessions ignoring dates and evidence annotations, versus 4,756 nonempty physical sessions

Thus histories share some repeated content. No corpus deduplication is applied before either arm; both see the same physical text. Production locator snippet deduplication still runs identically in both arms. IDs are namespaced as `question_id:entry_sequence`; entry dates are retained. Histories are appended in selection order, each internally chronological, rather than pretending all ten describe one globally ordered person/conversation.

## Method and boundaries

The same lexical tokenizer, ranking, snippets, escaping, deduplication and 1,500-codepoint/max-five budget are used by scan and index. The index retains references to existing entries and postings, not another full-text copy. It is memory-only and experimental.

Three simulated compaction boundaries cover roughly 25%, 50%, and **100%** of the combined text, at 12,443, 24,732 and 49,360 compacted messages. The final boundary keeps only an artificial live tail, deliberately exposing the full stacked history to retrieval. These are controlled stress-test boundaries, not saved real benchmark compaction outputs.

After a resource pilot, the protocol runs three isolated processes per arm, alternating arm order. Per stage/process:

1. Time index initial build or incremental update separately
2. Force GC and record retained heap/RSS relative to loaded host records
3. Time one first query, then run one additional warmup query
4. Run all ten unchanged questions once, rotating their order across repetitions

Total measured mixed-query samples: 90 per arm, 180 overall, plus 18 first queries and 18 warmups overall. These are ten-question **mixed-query latency** distributions, not the prior single fixed query's distribution. Per-question medians have only three samples per stage; p95 over a small mixed sample is descriptive, not an SLA estimate.

Every timed query includes a fresh branch-array copy, compaction-boundary selection, index prefix-reference freshness checks, retrieval, scoring, ranking, snippets and result formatting. It does not measure actual SDK parent-link traversal, model/network calls, JSON input conversion, module startup or GC pauses. Build/update cost is separate and must be added when considering cold or total cost. Output strings are compared exactly for every question/stage/arm/repetition, not just matching IDs.

Post-hoc gold turn coverage uses official `has_answer` annotations. Those annotations never enter query text or ranking. Coverage counts directly returned marked turns; history_expand neighbor expansion was not executed, so a missed direct gold locator does not establish end-to-end failure. Coverage is evidence location, not model correctness; in this artificial merged workload, identical gold role/text may occur in another question's source history. Shared-text-aware coverage and own-source coverage should be distinguished, especially because snippet deduplication may favor a newer duplicate from another source.

## Reproduce

Supply an already authorized, verified original M dataset and new external output paths. No implicit sibling directory or download is used.

```sh
python3 benchmark/prepare-stacked.py --source "$DATA" --output "$QUESTIONS"
node --expose-gc benchmark/stacked-benchmark.mjs --input "$QUESTIONS" --output "$PILOT" --pilot
node --expose-gc benchmark/stacked-benchmark.mjs --input "$QUESTIONS" --output "$RESULTS"
node benchmark/summarize-stacked.mjs --results "$RESULTS" --data "$QUESTIONS" --output "$SUMMARY"
npm run check
```

Artifacts: `stacked-provenance.json`, `stacked-pilot.json`, `stacked-results.json`; `stacked-progress.json` is intermediate progress. Raw downloaded/extracted corpus is Git-ignored. All scripts run without new dependencies or model calls.

Pilot only (one full-history question, not the final aggregate): scan 6.60 seconds, index build 12.32 seconds, indexed lookup 57 milliseconds, observed post-GC RSS about 634 MiB. At start approximately 8.3 GiB system memory was available; this stayed well within the resource budget.

## Results

Completed 2026-09-30 on Node v24.19.0, Linux x64, AMD EPYC 9V74. All six isolated processes completed. Exact output parity passed for every question, boundary, arm and repetition.

The following medians/p95s pool **30 measured samples per stage/arm = ten questions × three isolated repetitions**. p95 uses nearest-rank order statistics; medians average the middle two samples. These are small repeated mixed-query samples, not thirty independent workloads.

| Compacted messages | Scan mixed median / p95 | Index mixed median / p95 | Index initial build / incremental update median |
| --- | --- | --- | --- |
| 12,443 (about 25%) | 1,589.44 / 1,810.91 ms | 6.75 / 16.16 ms | 2,626.71 ms initial |
| 24,732 (about 50%) | 3,221.91 / 3,542.52 ms | 15.09 / 27.66 ms | 2,758.27 ms update |
| 49,360 (100%) | 6,418.27 / 7,437.76 ms | 30.90 / 78.79 ms | 5,665.97 ms update |

First-query medians (scan/index): 1,663.84/17.87 ms, 3,210.12/24.00 ms, 6,592.80/42.01 ms. Index first-query figures exclude the separately measured build/update. Median per-process cumulative build/update cost was **11,005.09 ms**, not zero. It should not be inferred by simply summing independently computed stage medians.

Retained host-record heap was about **75.41 MiB** above process/module baseline. Index additional heap was **68.57, 132.21, 260.00 MiB** at the three stages. Final index RSS was about **336.59 MiB above its host-record baseline**, while scan RSS was about 23.27 MiB above its own host baseline. RSS includes allocator/JIT/transient history and is not a clean retained-data measurement. No OOM or timeout occurred.

### Evidence location is unchanged, not improved

At 100%, both arms return exactly the same locators. Direct marked-turn coverage is:

| Question | Gold turns in full corpus | Shared-text-aware gold turns returned | Own-source gold turns returned |
| --- | --- | --- | --- |
| 577d4d32 | 1 | 0 | 0 |
| 778164c6 | 1 | 1 | 1 |
| 51b23612 | 1 | 1 | 1 |
| ceb54acb | 1 | 1 | 0 |
| 3d86fd0a | 1 | 0 | 0 |
| 15745da0 | 1 | 0 | 0 |
| gpt4_65aabe59 | 3 | 0 | 0 |
| 982b5123 | 2 | 2 | 2 |
| e47becba | 2 | 0 | 0 |
| 118b2229 | 1 | 0 | 0 |

Shared-text-aware: **4/10 questions have a directly returned gold turn, 5/14 marked turns returned**. Strict own-source: **3/10 questions, 4/14 marked turns**. One shared-text hit is an identical marked role/text under another history's namespaced ID. The original easy email-time question no longer has its marked turn directly in the top-five shortlist after adding distractors.

These are direct locator measurements only. No model answered the questions, no agent decided evidence sufficiency, no history_expand neighboring-entry expansion ran, and no history_grep fallback ran. Missing direct gold turns does not establish end-to-end failure; conversely the speedup does not establish better answering. Grep remains the intended supplementary fallback when evidence is insufficient, but that workflow was not tested here.

### Conclusion

On this stacked real-text workload, keeping a per-compaction inverted index substantially reduces repeated retrieval latency while retaining exact scan behavior. It costs roughly **11 seconds of cumulative indexing and 260 MiB of extra retained heap**. It does not improve lexical ranking or resolve interference between concatenated histories. The final full-scan median is about 6.4 seconds, so one isolated final query would not repay all preceding index work; repeated queries can amortize it. This supports further engineering evaluation, not an automatic production switch or an end-to-end quality claim.

Machine-readable analysis: `stacked-summary.json`; exact queries, output strings and raw timings: `stacked-results.json`. `summarize-stacked.mjs` reproduces the statistics and distinguishes cross-history duplicate evidence from own-source evidence.

## Version note after manual-pagination update

The recorded timings and output/coverage files above describe the earlier code committed in `22c2d93`. Subsequent changes separate manual recall pagination (default/max 50) from automatic hints (max five) center snippets on the most informative matched term, and include assistant tool names/inputs while excluding toolResult bodies from all search entrypoints. Existing benchmark artifacts were preserved and have not been rerun to claim results for the new snippets. Current offline tests verify automatic scan/index parity.
