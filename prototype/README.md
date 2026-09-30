# Per-compaction inverted-index experiment

Status: isolated, offline prototype. Production still uses `buildLocator`'s scan; no production compaction hook, cache or persistence was added. Only the tokenizer and ranking/formatting helpers were exported/shared to prevent algorithm drift. The synthetic `corpus.mjs` is used for correctness tests, not the reported performance experiment.

## Real question and scope

Question: DEV8 `577d4d32`, “What time do I stop checking work emails and messages?”

Chosen because it is a direct, single-session-user fact with one evidence turn, without multi-hop reasoning or time arithmetic. This is an easy-case selection rationale, not proof it is the easiest DEV8 question. The DEV8 IDs come from the existing sibling lme-bench `bench.py`. Corpus is the official **original LongMemEval_M**, not the smaller S dataset, cleaned version, or oracle-only history. The selected full question contains 501 sessions, 4,888 converted messages, and 4,869,499 UTF-16 text units. The original question is the only query. Gold answer/evidence annotations are never fed into retrieval; they are used only to check whether an evidence entry appears afterward.

Sources:
- https://huggingface.co/datasets/xiaowu0162/longmemeval/blob/main/longmemeval_m
- https://github.com/xiaowu0162/LongMemEval

The public dataset is MIT-labelled by its publisher. Downloaded source data is ignored by Git and is not bundled with the extension. Existing project license status remains unchanged.

## What the prototype does

`CompactionIndex.sync(branch)` reads the latest `firstKeptEntryId` boundary using the same `compactedEntries` helper. It indexes newly compacted eligible entries on a prefix extension, retains the existing index if unchanged, and rebuilds on fork/reset/non-prefix changes or duplicate IDs. It retains SessionManager entry references, lexical terms, per-document first occurrence offsets/order, and postings; it does not retain an additional full-text copy.

Each query also calls `sync`: timing includes obtaining a branch array, selecting the compacted prefix, reference comparison, postings retrieval, scoring, sorting, snippets, escaping, deduplication and total output budget. This deliberately includes O(n) freshness work rather than timing only a map lookup. A benchmark branch-array copy approximates acquisition; real SDK parent-link traversal and the extension/model request lifecycle are not measured. Entries are assumed immutable; in-place mutation of an existing object is not detected. Session switches/forks with different objects rebuild. This is not yet a production lifecycle integration.

“Save the index at compaction” here means **retain it in memory**. It does not write an index file or survive process restart. Initial build and each update consume CPU synchronously. All lexical quality limitations remain identical to the scan; this is a speed/memory experiment, not better retrieval or model-answer evidence.

## Reproduce

Node 24+, Python 3 and curl; no new dependencies or model calls.

```sh
# Fetch just the selected real question from a verified range of the official file.
python3 prototype/extract-question.py 508000000 529999999
node --expose-gc prototype/benchmark.mjs prototype/selected.download.json
npm run check
```

`provenance.json` records the selected record offset and SHA-256. `results.json` records environment, raw per-query times, outputs and memory readings. If using the full dataset already downloaded in sibling lme-bench/data, extract question 577d4d32 instead of re-downloading the range. Do not feed oracle-only history into this benchmark.

The complete public M dataset download is independently verified with:

```sh
python3 prototype/verify-dataset.py ../lme-bench/data/longmemeval_m.json.part
```

That verifier requires official byte length and SHA-256, stream-parses all 500 unique records, verifies the selected question hash, then atomically renames `.part` to `.json` and saves verification metadata. Raw downloads are not committed.

## Method

- Three isolated Node processes per arm, alternating arm order across repetitions
- Identical real corpus and unchanged question for both arms
- Three simulated compactions at approximately 25%, 50%, 75% text-volume boundaries, always at a user entry; no generated summaries/model calls. These are controlled boundary simulations, not the original benchmark's saved compaction snapshots
- Each stage: timed build/incremental update; GC-separated retained heap/RSS measurement; first query; three warmups; twenty measured queries
- Reported numbers below are medians of the three process-level statistics. p95 is the median of three individual 20-sample p95s, not a pooled percentile
- The first stage's “first query” is cold after process/data setup (and index construction for the index arm); later stages' first query is cold only to that expanded corpus. Module loading, input JSON conversion, GC pauses, model calls and generated compaction costs are excluded
- Query output equality is checked byte-for-byte across all stages, arms and repetitions
- A separate full-corpus download ran during measurement; this may introduce shared-system noise. Small isolated-process sample, one easy question, repeated fixed query and synthetic boundaries limit generalization

## Observed results (2026-09-30)

Environment: Node v24.19.0, Linux x64, AMD EPYC 9V74. Exact runtime details and all raw samples are in `results.json`.

| Compacted entries | Scan warm median / p95 | Index warm median / p95 | Index initial build / incremental update |
| --- | --- | --- | --- |
| 1,242 | 184.78 / 218.87 ms | 0.78 / 1.29 ms | 232.98 ms initial |
| 2,498 | 341.17 / 378.53 ms | 1.52 / 2.61 ms | 286.62 ms incremental |
| 3,670 | 498.54 / 593.89 ms | 2.06 / 3.34 ms | 338.92 ms incremental |

First-query scan/index timings by stage: 189.21/2.98 ms, 334.63/3.60 ms, 564.19/5.05 ms. Index first-query values exclude the separately shown construction/update cost; they must not be presented as zero-setup latency.

Retained host-record heap was approximately 6.70 MiB above process/module baseline. The index added approximately 8.27, 15.60 and 22.26 MiB of retained heap at the three boundaries. At the final stage, RSS was about 58.97 MiB above host baseline for the index process versus 41.25 MiB for the scan process. RSS includes allocator/JIT/transient high-water effects and is not a precise measure of retained index bytes.

Exact output parity passed. The answer-bearing entry `00000005` appeared in the top five at every stage (rank four in the final stage), including the actual “7 pm” text. This is evidence-location coverage on one question, not an end-to-end model correctness result.

## Interpretation

Retaining postings avoided repeated full-text tokenization and greatly reduced repeated-query latency on this particular haystack. It traded roughly 22 MiB of retained heap plus roughly 0.90 seconds of total build/update work (median of per-process cumulative costs) for that benefit. A single final query alone would not necessarily repay the accumulated index work; repeated calls are where it can amortize. Real production behavior still needs testing for session lifecycle, large/high-frequency postings, very long entries, memory pressure, and latency during compaction callbacks. Keep the prototype isolated until those trade-offs are accepted.

## Larger stacked experiment

`STACKED.md` records the separately requested ten-real-haystack (~10.06M tokens by the existing character heuristic) stress experiment. Its scripts, provenance, raw results and summary use the `stacked-` prefix, preserving this single-question experiment.

## Version note after manual-pagination update

The recorded timings and output/coverage files above describe the earlier code committed in `22c2d93`. Subsequent changes separate manual recall pagination (default/max 50) from automatic hints (max five) center snippets on the most informative matched term, and include assistant tool names/inputs while excluding toolResult bodies from all search entrypoints. Existing benchmark artifacts were preserved and have not been rerun to claim results for the new snippets. Current offline tests verify automatic scan/index parity.
