# Historical CLP / Pi SDK 1.0 evaluation method

This page describes the completed historical DEV8/HARD8 experiments, not a runnable default configuration. Fixed provider/model registration, personal-profile handling and the old CLP CLI have been deleted. Current operations use [the external-config evaluator](EVALUATION.md); frozen scores and audits are indexed in [BENCHMARK.md](BENCHMARK.md). Historical labels below remain attribution, not default model selections.

## Source and selection

The original LongMemEval_M source was streamed with `ijson` and SHA-256 hashed in bounded reads. Selected histories, label-free solver questions, judge-only gold and selection metadata lived outside the repository. No full corpus, sessions or credentials are bundled.

DEV8 is exactly `bench.DEV8`, from eight independent original M histories. HARD8 uses deterministic policy `hard8-turn-label-v2`: exclude DEV8; rank metadata only from explicit `has_answer` turns using `20 × min(distinct labeled sessions, 5) + 3 × min(labeled turns, 8) + question-type bonus (knowledge-update 16, temporal-reasoning 12, multi-session 10, preference 8) + 6 if an update/distractor cue occurs; discard scores below 34; retain the top 160 metadata records with deterministic ID/type tie-breaks. Inspect those histories in chronological `bench.build_session` order and actual `bench.chunk_cuts` boundaries; require explicit answer turns in at least two distinct segments among the first three, with none in segment four; select eight by score plus an 8-point bonus for a not-yet-selected type and ID tie-break. `answer_session_ids` without per-turn `has_answer` annotations are coarse/unknown and cannot establish separated evidence. Selection uses dataset labels and structure only, not model answers or candidate success. The policy is a difficulty hypothesis, not a measured result. Manifests freeze selected IDs, types, source SHA-256, rationale, and exact labeled evidence segments; they do not contain copied credentials or full histories.

`answer_session_ids` and turn `has_answer` fields are used only during selection and then stripped from extracted solver histories. Ground-truth answers are stored separately for the official judge and are not passed to the compressor or solver.

## Historical configuration and arms

The historical default answer arm used `clp/gpt-6-luna` / `high`; the later Sol comparison used `clp/gpt-6.1-sol` / `high`. Compression stayed Luna/high and judging Luna/xhigh. All three arms shared the selected answer configuration, official prompt, SDK and per-question snapshot. The recorded Luna descriptor used 372,000 context / 128,000 maximum output tokens; Sol used 372,000 / 8,192 with text input. These are historical descriptors only; the current runner does not register them.

Four ordered segments produced three explicit Pi compactions, followed by the common fourth-segment question snapshot:

- `native`: no extensions or tools.
- `grep`: pinned production grep/expand definitions through the immutable grep-only wrapper, context hook suppressed.
- `production`: the pinned package public entry with automatic locator and all three retrieval tools.

The historical reserve was 16,384 tokens; SDK 1.0.0's summary cap was `floor(0.8 × reserve) = 13,107`. Conservative preflight added 5,000 overhead tokens and used `372,000 − 16,384 = 355,616` as ceiling. Plugin commit identity and archive/wrapper/source hashes are preserved in each original manifest. Candidate selection and model response quality did not alter the source history or gold.

## Historical durability and measurement

Each snapshot key includes the selected history hash, SDK and package-lock hashes, model/effort, system prompt, Pi flags, segment count, provider endpoint identity, context/preflight limits, compression orchestration (`prepare_snapshot` and its session, RPC, preflight, child-environment, cache-manifest/file-hash, and error-redaction helpers), and the sibling compression helper hashes. The cache manifest and actual snapshot byte hash must both match before reuse; a stronger fingerprint intentionally creates new cache keys rather than migrating older snapshots. A run manifest binds the exact candidate and runner plus the byte hashes of the extracted `questions.json`, `gold.json`, and selection manifest; changed inputs are rejected before candidate pinning or provider calls. Per-arm answer and judge records are atomically saved before the physical-LF JSONL ledger append. Resume validates their run/snapshot identities, recovers saved answers or completed judge results without replay, and refuses ambiguous inflight answer/judge attempts. Answer-side candidate changes do not invalidate compression snapshots, but do prevent resuming a mismatched run.

Timing fields were emitted only for observed events: compaction wall time, startup, first visible output, prompt completion and answer wall time. Token totals included only newly appended assistant usage. Synthetic history estimates were not counted as actual usage; missing signals remained null. The previous external `.env`/isolated-model-configuration mechanism has been removed, not retained behind a switch.

## Limits and new-code boundary

The arms differ in tool and locator availability only, but this is an eight-question sample and model behavior is stochastic. The results are descriptive, not a broad causal estimate. A lexical locator, tool use, or one judged response is not evidence of general accuracy or utility. LongMemEval `has_answer` labels give evidence location but do not establish that each answer requires every labeled turn. Compression token consumption may be unavailable from Pi RPC events.

The current directory/config refactor changes source fingerprints and manifest identity. It cannot restore or relabel these historical runs or snapshot caches. Their source bytes, model/effort labels, SDK, commit and statistics stay frozen. New real operations require separate authorization and a new explicit configuration/run directory.
