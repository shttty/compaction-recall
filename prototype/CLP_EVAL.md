# CLP / Pi SDK 1.0 evaluation

This runner is isolated under `prototype/`; production behavior is loaded only for the `production` answering arm. It imports the existing `lme-bench/bench.py` session builder, LongMemEval question-type grading prompts, and CLP chat transport. It does not change the sibling benchmark or personal Pi settings.

## Prepare data safely

Use the sibling LongMemEval M source at `../lme-bench/data/longmemeval_m.json`. The preparation command requires `ijson` only in an ephemeral `uv` environment; it hashes the source in fixed 1 MiB reads and streams one source record at a time. It never `json.load`s the 2.7 GB corpus. Only selected histories, labels-free solver questions, separate judge-only gold answers, and selection metadata are written under `/home/rinne/.hermes/task-runs/recall-20261002/evaluation/` (directory mode 0700; generated files mode 0600).

```sh
uv run --no-project --with ijson python prototype/clp-eval.py prepare --set dev8
uv run --no-project --with ijson python prototype/clp-eval.py prepare --set hard8
```

DEV8 is exactly `bench.DEV8`, from eight independent original M histories. HARD8 uses deterministic policy `hard8-turn-label-v2`: exclude DEV8; rank metadata only from explicit `has_answer` turns using `20 × min(distinct labeled sessions, 5) + 3 × min(labeled turns, 8) + question-type bonus (knowledge-update 16, temporal-reasoning 12, multi-session 10, preference 8) + 6 if an update/distractor cue occurs; discard scores below 34; retain the top 160 metadata records with deterministic ID/type tie-breaks. Inspect those histories in chronological `bench.build_session` order and actual `bench.chunk_cuts` boundaries; require explicit answer turns in at least two distinct segments among the first three, with none in segment four; select eight by score plus an 8-point bonus for a not-yet-selected type and ID tie-break. `answer_session_ids` without per-turn `has_answer` annotations are coarse/unknown and cannot establish separated evidence. Selection uses dataset labels and structure only, not model answers or candidate success. The policy is a difficulty hypothesis, not a measured result. Manifests freeze selected IDs, types, source SHA-256, rationale, and exact labeled evidence segments; they do not contain copied credentials or full histories.

`answer_session_ids` and turn `has_answer` fields are used only during selection and then stripped from extracted solver histories. Ground-truth answers are stored separately for the official judge and are not passed to the compressor or solver.

## Run contract

```sh
python prototype/clp-eval.py pin --plugin-ref f5715d1901b6bedf19811030f18f3733eefb7bc4
python prototype/clp-eval.py pin --plugin-ref 7d1980b8b7512ec8568c3ddaaecdccb8e0ad4014
# After parent acceptance only; --plugin-ref is mandatory.
uv run --no-project --with ijson python prototype/clp-eval.py run --set dev8 --run <run-name> --only <question-id> --plugin-ref <full-commit>
```

`pin` uses `git archive` from `/home/rinne/workspace/pi-context-recall`, resolves and records the full commit, discovers the actual relative-import closure from `index.ts`, includes `package.json`/`package-lock.json`, and stores the archive under the private evaluation root. Source files are read-only; the pin manifest records archive and per-file hashes, SDK/TypeBox versions, the closure hash, and the separate immutable grep-wrapper hash. `run --plugin-ref` is required and accepts only the two reviewed commits above. Native, grep, and production use the same archive for that run. Grep loads the pinned `recall-extension.ts` through the hashed wrapper and suppresses its context hook; production loads the pinned public `index.ts`. Plugin refs do not enter the compression snapshot key, so snapshots produced by the same validated compression implementation can be shared across candidates. Pre-strengthening r3 snapshots remain archived; they are not relabeled or migrated to the stronger keys.

Four ordered history segments produce three explicit Pi compactions. The completed fourth segment and final question snapshot are shared by all three arms:

- `native`: Pi with no extensions and no tools.
- `grep`: exact production grep/expand tool definitions through `prototype/grep-only-adapter.mjs`, which suppresses the context hook; only `history_grep` and `history_expand` are exposed.
- `production`: public `index.ts`, its automatic context locator, and `history_recall`, `history_grep`, and `history_expand`.

All arms use `clp/gpt-6-luna`, requested `high`, the same system/question prompt, SDK and history snapshot, and an unchanged 372,000-token model context. Pi SDK 1.0.0 manual compaction explicitly reserves 16,384 tokens; its summary request cap is `floor(0.8 × reserve) = 13,107`, below the model descriptor's unchanged 128,000-token maximum. The runner conservatively budgets the full reserve: preflight adds 5,000 tokens of overhead and accepts totals up to `372,000 − 16,384 = 355,616`. The judge uses `bench.py` official LongMemEval question-type prompts and `clp/gpt-6-luna` requested `xhigh`. Standalone yes/no parsing rejects malformed judge output. Provider failures, empty answers, incorrect answers, and judge errors remain distinct; every selected question remains in the denominator.

Each snapshot key includes the selected history hash, SDK and package-lock hashes, model/effort, system prompt, Pi flags, segment count, provider endpoint identity, context/preflight limits, compression orchestration (`prepare_snapshot` and its session, RPC, preflight, child-environment, cache-manifest/file-hash, and error-redaction helpers), and the sibling compression helper hashes. The cache manifest and actual snapshot byte hash must both match before reuse; a stronger fingerprint intentionally creates new cache keys rather than migrating older snapshots. A run manifest binds the exact candidate and runner plus the byte hashes of the extracted `questions.json`, `gold.json`, and selection manifest; changed inputs are rejected before candidate pinning or provider calls. Per-arm answer and judge records are atomically saved before the physical-LF JSONL ledger append. Resume validates their run/snapshot identities, recovers saved answers or completed judge results without replay, and refuses ambiguous inflight answer/judge attempts. Answer-side candidate changes do not invalidate compression snapshots, but do prevent resuming a mismatched run.

Timing fields are recorded only when an event exists: compaction wall time, Pi startup, first visible output, prompt-to-completion, and overall answer wall time. Answer token totals include only usage returned by newly appended assistant responses. Synthetic historical `usage` estimates and compaction token consumption are not treated as actual model usage; unavailable signals stay null. Tool calls are counted from session tool results. Credentials are loaded from the sibling `.env`, written only to mode-0600 isolated Pi model configuration, and redacted from stored failures; `HERDR_*` variables are removed from child environments.

## Limits

The arms differ in tool and locator availability only, but this is an eight-question sample and model behavior is stochastic. The results are descriptive, not a broad causal estimate. A lexical locator, tool use, or one judged response is not evidence of general accuracy or utility. LongMemEval `has_answer` labels give evidence location but do not establish that each answer requires every labeled turn. Compression token consumption may be unavailable from Pi RPC events.

Do not launch the full 16-question run until the parent freezes and approves the candidate and run manifest. Never copy full LongMemEval data or credentials into the repository.