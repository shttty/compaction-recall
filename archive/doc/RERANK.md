# Retrieval-only reranker comparison

This compares retrieval and ordering, not answer generation or actual Pi-agent behavior. Main data is the unchanged ten-real-history English stack: 49,360 messages and approximately 10.06M tokens under the historical 4.84-character heuristic. It does **not** establish multilingual quality, despite using multilingual models. Three tiny handwritten Chinese passage-choice pairs are separate smoke checks, not a representative benchmark.

## Fixed protocol

1. Search scope remains normal text plus assistant tool-call names/inputs, excluding toolResult bodies, thinking and images.
2. Filter duplicate IDs and whitespace-normalized display snippets **before ranking/caps**. Newest branch position is the deterministic representative; lexical scores/gold labels do not choose representatives.
3. Pure grep uses the actual registered history_grep tool, with one escaped-OR regular expression over the existing deterministic queryTerms output. It preserves chronological ordering and the tool's 30-snippet/three-per-entry limits. No gold-derived query, model rewrite, tuned keyword subset or interactive follow-up is used. This is a reproducible single-shot baseline, not the best human/agent grep strategy.
4. Mechanical arm unions actual grep IDs and up to 50 actual paginated history_recall IDs. Deduplicate first, use existing distinct-term/IDF-weighted ranking and recency ties, then freeze at most 50 candidates.
5. Both rerankers score **exactly this same frozen pool**. They cannot add candidates or search more history. Model input contains only question, candidate ID and source window; no reference answers, evidence flags or gold locations.
6. Reranker source windows are up to 2,048 Unicode codepoints around the most informative matched term, rather than the 120-codepoint display snippet. Each model's tokenizer applies a 512-token maximum including query and model-specific prompt/special tokens. Tokenizers differ, so final visible passage extents can differ; long-source/window truncation can still omit evidence.
7. Final endpoint is top five first, then the identical 1,500-codepoint display budget. Dropped oversized rows are not backfilled from rank six. Before-budget hits are also reported separately.

The automatic-hint and manual-recall implementations use dedupe-before-ranking. This report preserves a completed historical neural-reranker experiment, not a production integration. Its fixed-model inference/download scripts have been removed; current generic candidate extraction and external-result aggregation do not register a model.

## Models and local runtimes

- Official cross-encoder/mmarco-mMiniLMv2-L12-H384-v1, revision `1427fd652930e4ba29e8149678df786c240d8825`, Apache-2.0. Official FP32 ONNX weights (~471 MB), onnxruntime CPU, four threads, batch four.
- Official Qwen/Qwen3-Reranker-0.6B, revision `e61197ed45024b0ed8a2d74b80b4d909f1255473`, Apache-2.0. Official safetensors (~1.19 GB), Transformers/PyTorch CPU, FP32, four threads, batch two. Scores are yes-minus-no final-token logits using the published reranker chat structure and a fixed English historical-evidence instruction. No answer tokens are generated.

Sources:
- https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1
- https://huggingface.co/Qwen/Qwen3-Reranker-0.6B

Observed host: AMD EPYC 9V74 80-Core Processor, approximately 2.60 GHz reported; 9 logical CPUs (affinity 0–8) are visible in this workspace. AVX2, AVX512 and BF16 flags are exposed; actual CPU quota is unknown because cpu.max is unavailable. Both runtimes use four inference threads. These observations do not mean the task owns an 80-core CPU.

The historical run used no trust_remote_code, credentials or inference APIs. Downloaded public-model hashes remain in [rerank-model-manifest.json](../benchmark/rerank-model-manifest.json); primary runtime versions remain in the original per-model result JSON. The obsolete fixed-runtime install file was removed with its specialized runners. These were model-plus-runtime configurations, not a controlled architecture-only comparison: engines and batch sizes differed.

## Timing, memory and evidence definitions

- One retrieval preparation and one complete scoring pass per model; ten queries × fifty candidates, no latency distribution claim beyond this small mixed-query sample.
- Actual grep tool time, actual recall tool time and shared candidate/window/ranking preparation time are recorded separately. The shared preparation currently rescans history to get exact term statistics; it is deliberately not presented as an optimized end-to-end production implementation. Pure-grep display deduplication/windows also use these shared statistics, so grep-tool-only timing is not a complete pipeline latency.
- Model loading is measured separately in fresh processes, but the filesystem may already be warm from smoke runs; these are not cold-machine startup measurements. Neural per-query timing includes tokenization, CPU scoring and ordering. Three small Chinese smoke pairs warm each loaded model before the main pass.
- Linux process high-water RSS is reported for each isolated model process. It includes libraries, weights and transient inference allocations, not merely parameter storage. Retrieval preparation records process memory separately.
- Gold annotations are consulted only after candidate selection. A positive is an officially marked historical turn (including identical role/text in a different stacked history), not merely a passage containing the literal reference answer. Own-source hits and literal-reference presence in pool windows are separate diagnostics.
- Candidate-pool marked-evidence coverage is the ceiling for any reranker in this experiment. Hit on a multi-evidence question does not mean all necessary evidence was recovered, and no statistic is a model-answer accuracy score. No history_expand or adaptive grep fallback workflow was executed.

## Current generic preparation and aggregation

External paths are mandatory. No model is downloaded or selected by these entrypoints:

```sh
node archive/benchmark/prepare-rerank.mjs --data "$QUESTIONS" --candidates "$CANDIDATES" --results "$RETRIEVAL"
node archive/benchmark/summarize-rerank.mjs --config "$SUMMARY_CONFIG"
```

The summary config is JSON with `retrieval`, `inputs`, `data`, `output` paths and a `models` object mapping user-supplied labels to result paths. Relative paths resolve from that config file. Each external model-result file must provide `inputSha256`, `results` entries with the unchanged candidate IDs, finite `scores`, `orderedIds`, and recorded `seconds`; optional timing/runtime fields are not fabricated. The aggregator verifies the original candidate input hash and pool identity. It does not run a model or infer missing scores.

For example (placeholders, not a runnable model configuration):

```json
{"retrieval":"retrieval.json","inputs":"candidates.private.json","data":"questions.json","output":"new-summary.json","models":{"external_run":"external-results.json"}}
```

Candidate windows and original frozen result bytes stay external. Public results retain historical model labels, source hashes and non-text metrics through schema projection. The removed fixed-model runner is not hidden in an archive or compatibility path.

## Results

Completed both full passes: **500 query/passage pairs per model**, CPU-only. Frozen model-input SHA-256 and exact candidate sets were verified for both models. Every final output contained five locators; the length guard did not change hit rates in this run.

| Arm | Questions with ≥1 marked evidence turn | Marked turns recovered | Questions with all marked turns | Strict own-source question hits |
| --- | --- | --- | --- | --- |
| Pure deterministic grep | 1/10 | 1/14 | 1/10 | 1/10 |
| Grep + recall, mechanical ordering | 4/10 | 5/14 | 4/10 | 3/10 |
| Same pool + mMiniLMv2 | 8/10 | 8/14 | 6/10 | 7/10 |
| Same pool + Qwen3 0.6B | 8/10 | 9/14 | 7/10 | 7/10 |

The fixed-pool ceiling is **8/10 questions and 10/14 marked turns**. The degree and commute questions contain no marked target evidence in their pools; neither reranker could recover it. The ceiling is based on whole marked entries, not a guarantee that an answer-bearing span survives source-window/token clipping.

Candidate accounting after scope filtering: grep exposed 14–24 deduplicated entry IDs; recall provided 50 per question. Their ID unions contained 64–73 entries and 64–72 after cross-source snippet deduplication, before the fixed cap of 50. **All final pools equaled recall's first 50 in this run**: grep added raw candidates, but none survived the existing mechanical ordering/cap. Thus this experiment does not demonstrate added retrieval value from grep, and is not an evaluation of adaptive agent grep fallback.

### CPU resource cost

| Model | Median added rerank time / 50 candidates | Range across ten questions | Total scoring time | Fresh-process model load | Peak process RSS |
| --- | --- | --- | --- | --- | --- |
| mMiniLMv2 / FP32 ONNX | 8.154 s | 7.455–8.721 s | 81.11 s | 4.538 s | 1,163 MiB (1.14 GiB) |
| Qwen3 0.6B / FP32 PyTorch | 183.322 s | 161.571–192.636 s | 1,815.46 s | 6.847 s | 3,888 MiB (3.80 GiB) |

In this specific four-thread CPU configuration Qwen's median added rerank time was about **22.5×** mMiniLM's, for one additional marked turn and no additional question-level hit. This is not intrinsic model speed: engine, batching, precision, CPU quota and token lengths matter. BF16/INT8/GPU or prefix-cache optimizations were not tested, even though BF16 CPU flags are visible.

Retrieval preparation component medians: actual grep tool **200.48 ms**, actual recall tools **6,505.50 ms**, shared term-statistics/window/ranking pass **6,078.36 ms**. These separate components must not be confused with an optimized complete deployment latency or simply sum-of-medians latency. The common retrieval process ended at an RSS snapshot of **612.94 MiB** (heap used 360.34 MiB); this was not an isolated per-arm peak or a post-GC retained-size measurement. Deployment memory combining live history/index and a model was not measured.

Source windows were shortened from longer entries for 18–36 candidates per query. Across 500 pairs, mMiniLM had 162 non-padding sequences at the 512-token cap and Qwen had 147. Equal cap does not imply equal passage text because tokenizers and prompt overhead differ. mMiniLM's length metadata was recomputed from attention masks after inference; scores and timings were unchanged.

### What changed in evidence coverage

Both rerankers recovered marked evidence for IDs `577d4d32`, `3d86fd0a` and `15745da0` missed by the mechanical top five. For `982b5123`, Qwen returned both marked turns and mMiniLM one; for `gpt4_65aabe59`, both returned one of three, while the pool held two. A hit is not a fully supported answer.

One shared-text hit was a duplicate under another history. Reference strings appeared in pool windows for eight questions, including two whose marked evidence was absent; other annotated-support cases lacked a literal match. Those strings remain external and were not the scoring rule.

Both models chose the intended passage in all three tiny Chinese smoke pairs. These easy hand-authored checks establish basic execution on Chinese text only; the main ten-question results remain English-only and do not establish multilingual or cross-lingual quality.

### Practical reading

For this small fixed English stress set, mMiniLM captured the available question-level gain at much lower CPU cost. Qwen added one useful evidence turn, at substantially higher measured latency and memory. This favors mMiniLM as a low-cost prototype starting point here, not a universal model recommendation. Better candidate retrieval is needed for the two pool misses; a real multilingual set and the full recall/expand/iterative-grep answering workflow would be separate experiments, not implied by these results.

Historical non-text artifacts remain under [archive/benchmark/](../benchmark/): `rerank-summary.json`, `rerank-retrieval-results.json`, `rerank-mmarco-results.json`, `rerank-qwen-results.json`, `rerank-model-manifest.json`, and `rerank-code-manifest.json`. Code/source hashes are historical identities, not a current runnable dependency list; original full bytes stay external.
