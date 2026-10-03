# Public retrieval evaluation contract (S0)

Plan and frozen prompts: `doc/SOFT_MATCH_EVAL_PLAN.md` and `doc/SOFT_MATCH_PROMPTS.md`. This layer is shared infrastructure, not either prototype. It never generates answers, invokes a judge, rewrites raw queries, or invokes a real model by itself.

## Inputs and corpus

`loadEvaluationCases({ dataRoot, goldPath })` from `benchmark/retrieval-eval-core.mjs` loads the explicit dataset root `/home/rinne/workspace/pi-context-recall-dev/benchmark/data` and explicit gold file `/home/rinne/.hermes/task-runs/recall-soft-match-20261003/zh-retrieval/gold.json`. It reads `.gold`, requires 16 keys of the form `{dev8,hard8}/<id>`, and reads only `corpus.json`, `corpus-zh.json`, and `question-zh.json` beneath those keys. The bilingual question fields are `question_en` and `question`. Every gold coordinate must exist in both languages and its role must equal the frozen gold role. All 16 bilingual cases validate before filtering a run or returning any cases; a mismatch throws, with no report or scores written.

The returned 32 cases contain `{ key, questionId, language, question, questionDate, branch, documents, positions, goldIds }`. Gold and positions are scorer-side data, never engine/model input. Engine input is only `documents: [{ id, text }]`; renderer metadata comes from `branch`. Question and branch fields are explicitly allowlisted. No answer, judge, label, provenance or `has_answer` fields are copied from input objects.

`buildEvaluationCorpus({ questionId, haystack_dates, haystack_sessions })` follows `buildBlindCorpus` exactly: stable date ordering after removing weekday annotations; prefix a first user turn with `[Session Date: ...]`, otherwise insert a synthetic user date turn; sequential hex ids and the same timestamps; retained tail followed by a compaction with an empty summary. All history is compacted. `positions` maps original zero-based `session:turn` to generated id, accounting for ordering and inserted turns. Synthetic date turns have no original position.

Document scope is production `compactedEntries(branch)` followed by `searchableEntryText(entry)`: eligible user/assistant text and assistant tool-call names/arguments, not tool results, thinking or images. Undefined (excluded) entries are omitted, not converted into empty documents. The source corpus has text turns; the builder does not attach source labels to messages.

## Engine module boundary

An explicit module exports `createEngine(documents)` (sync or async), returning:

- `searchAuto(question)` (sync or async): a **complete**, ordered array of unique `{ id, score }`, with finite numeric scores. It performs the prototype's normal automatic query selection/stopword handling, with `autocut=true`. It must not cut the ranking to the display's top five or a manual page limit.
- `searchRaw(query, { limit })` (sync or async): `{ total, results: [{ id, score }] }`, native raw-query semantics with `autocut=false`. `total` is the complete match count; `results` is the requested ranked prefix. No wrapper rewriting, token selection, stopword deletion, truncation or automatic length cutoff. Native errors propagate unchanged (the tool boundary may report their original message).
- Optional `dispose()` releases engine resources.

The shared `searchAutomatic(engine, question)` applies the automatic-only 210 weighted-code-point gate **before engine tokenization**: each Han character counts 2, every other character 1, exactly 210 is accepted, more than 210 returns no hints without calling the engine. Raw searches have no such gate.

Both groups pass the frozen user question verbatim to `searchAutomatic`. Group 2's no-call fallback must equal group 1 for the same engine/corpus/question, so the ASK framing is not included in automatic term selection or the 210 gate. The model still receives `evaluate.py`'s `ASK.format(question_date, question)`. Models write manual queries themselves; those raw query strings remain untouched. Do not force a call or substitute the question as a raw query.

## Rendering and production package loading

Automatic display reuses production `formatLocatorRows(rows)` from `src/locator.mjs` (top-five and character budget). Manual display reuses `recallPageFromRows(rows, { limit, offset }, timer?)` from the same file. Rows are already ordered `{ id, date, role, snippet }`; the helper does not score, reorder, filter or deduplicate. It uses the same JSON escaping, header, 16000-code-point budget, oversized-row progress rule, defaults, validation and pagination details as the production `recallPageFromCandidates` path. Offsets refer to the supplied complete ranking; fetch enough engine results before rendering. Relevance metrics use full ranking sidecars, not ids parsed from budget-truncated display text.

A production arm is an explicit, fixed, read-only package root with `package.json` declaring **exactly one** `pi.extensions` entry. SDK loading resolves that entry relative to the package root, not by assuming `src/index.ts` or rewriting the package. Group 2 rejects writable package files and escaping entry paths. No installation into a personal profile, no package mutation, no implicit fallback to another arm. `run.json` records the selected package root, resolved extension path and package/engine hashes.

### Adapter responsibilities

- Export a normal Pi extension registration function from the manifest entry. Register the three tools with the frozen prototype-specific descriptions and parameters from `doc/SOFT_MATCH_PROMPTS.md`; do not change production descriptions.
- Build/update the engine from the current branch's production `compactedEntries` / `searchableEntryText` projection. Gold, answers, judge records and scorer sidecars never enter the engine or provider request.
- In `context`, resolve the initial ASK to the original question using the explicit read-only `PI_RETRIEVAL_INPUT_FILE` metadata, call `searchAutomatic(engine, question)`, and inject `LOCATOR_TYPE` using production `withLocators` and `formatLocatorRows`. Use the same engine module supplied to the runner; preserve the complete ordering before rendering only the top five.
- In `history_recall.execute`, pass `params.query` unchanged to `searchRaw`. Obtain the **complete** ranked rows for `recallPageFromRows`; if a prefix search reports a larger `total`, request that `total` as the engine limit before rendering. Do not render a truncated prefix as if its length were the total. The tool page limit remains at most 50; engine prefix limits are not tool-page limits. Return production page text/details, preserving native error messages and offsets.
- Import `loadRecallConfig` and `createRecallTrace` from the shared `src/` modules. When trace is enabled with a file, wire `message_end` to `messageEnd(sessionId, message)`, `tool_call` to `toolCall(sessionId, event)`, and `agent_end` / shutdown to `flush()`. Call `begin(sessionId, toolCallId, params)` before searching, `complete(token, {ids,total,offset,returned,nextOffset})` with **only actually returned** ids in rank order, or `fail(token, error)` on failure before rethrowing. See `doc/TIMING.md` for nested/missing-model and snapshot semantics.
- Reuse production history helpers for grep/expand scope and branch edits; those tools do not use the prototype engine. Close engine resources on shutdown. A package must include its source dependency closure and explicit engine dependencies; the harness does not rewrite imports or provision them.


## Mechanical runner

```sh
node benchmark/retrieval-group1.mjs \
  --engine /absolute/path/to/engine.mjs \
  --data /home/rinne/workspace/pi-context-recall-dev/benchmark/data \
  --gold /home/rinne/.hermes/task-runs/recall-soft-match-20261003/zh-retrieval/gold.json \
  --output /home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/s0/group1.json \
  --prototype explicit-arm-name
```

All five flags are required. Optional `--question split/id` (or unique id) and `--language zh|en` filter only after full gold validation. Output uses exclusive creation: existing reports are never overwritten. `runGroup1({ enginePath, dataRoot, goldPath, prototype, question?, language? })` is the programmatic equivalent. Engine exceptions propagate; invalid/duplicate ids or non-finite scores fail instead of producing a score. No implicit production engine or prototype is selected.

## Group 2 runner and external configuration

```sh
python benchmark/retrieval-group2.py \
  --config /absolute/path/to/evaluation-config.json \
  --data /home/rinne/workspace/pi-context-recall-dev/benchmark/data \
  --gold /home/rinne/.hermes/task-runs/recall-soft-match-20261003/zh-retrieval/gold.json \
  --engine /absolute/path/to/engine.mjs \
  --adapter-package /absolute/path/to/read-only-adapter-package \
  --prototype explicit-arm-name \
  --output /home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/s0/group2
```

`--question split/id` and `--language en|zh` may each repeat. Output must be a new directory within configuration `output_dir`. A package manifest can declare `{"type":"module","pi":{"extensions":["./adapter.ts"]}}`; a read-only production-source copy instead declares `{"pi":{"extensions":["./src/index.ts"]}}` and includes that entry's source dependency closure. Package location is explicitly supplied, not guessed from a prototype name. The SDK uses `--arm production --plugin-dir PACKAGE` to load the manifest-declared extension. Profile files and the package remain read-only.

Configuration uses the existing strict `benchmark/evaluation-config.py` schema, with exactly these top-level keys:

```json
{
  "sdk_path": "/absolute/path/to/sdk-package",
  "helper_path": "/absolute/path/to/historical-helper.py",
  "data_path": "/absolute/path/to/source-dataset.json",
  "output_dir": "/home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/s0",
  "candidate_repo": "/absolute/path/to/candidate-repository",
  "system_prompt": "Explicit benchmark system prompt",
  "protocol": { "segments": 2, "reserve_tokens": 0, "overhead_tokens": 0 },
  "compression": { "provider": "explicit-provider", "model": "explicit-model", "effort": "high", "profile": "/absolute/path/to/read-only-profile" },
  "answer": { "provider": "explicit-provider", "model": "gpt-6-luna", "effort": "high", "profile": "/absolute/path/to/read-only-profile" },
  "judge": { "provider": "explicit-provider", "model": "explicit-model", "effort": "high", "profile": "/absolute/path/to/read-only-profile" }
}
```

Paths are external inputs resolved relative to the config file. Replace illustrative paths/provider/model choices with explicit authorized values; no credentials belong in the config or repository. Each profile must already contain read-only `models.json` and `auth.json`. `segments` is an integer at least 2; reserve/overhead are nonnegative integers. The output root must not overlap protected input paths. Compression/judge settings remain required by the shared configuration schema, not permission to run those phases: retrieval group 2 does not generate compaction summaries or run a judge. The `answer` phase selects the retrieval-driving model, not an end-to-end answer-quality metric.

`benchmark/retrieval-session.mjs` prepares the original-question automatic ranking and scorer snapshots. The SDK's optional, answer-phase-only `--retrieval-input PATH` supplies a JSON file containing only `{ question, question_date, prompt }`, never gold or labels. After profile/environment isolation, the SDK exposes its path as `PI_RETRIEVAL_INPUT_FILE`. The benchmark adapter uses this metadata to recognize the initial ASK prompt and select the original question for `searchAuto`, matching the sidecar and group 1; subsequent tool queries are not altered. This is evaluation input metadata, not a replacement bootstrap or extension loader: the same read-only `pi.extensions` production-arm loading remains in force. Production `src/index.ts` ignores this benchmark-only metadata; a production smoke must use equivalent lexical input and verify the actual automatic ids received by the provider. Any real-model execution still requires explicit authorization.

## Metrics and sidecars

`scoreRetrieval({ goldIds, autoResults, calls = [] })` accepts ranked `{id,score}` arrays (or id arrays) and calls shaped `{ results?, query_identical?, error? }` in execution order. A failed call still occupies its original position; omitted results mean an empty ranking, not a fallback to a later call.

- Group 1: MRR over the complete automatic ranking; binary nDCG, Recall and Precision at 5/10/20.
- Group 2: Recall@K counts unique gold ids in the union of automatic top K and **each** call's top K. It does not concatenate all rankings and take one global top K.
- Group 2 MRR/nDCG: first call ranking, or automatic ranking only if there were no calls. Precision and top-five evidence use that same reference ranking; precision divides by K, including short/empty result lists.
- Binary nDCG uses `1/log2(rank+1)` and the ideal ranking of `min(K, goldTotal)` gold hits. Repeated ids cannot earn repeated gain.
- `top5Hit` and `locatedGoldTurns` count hit/no-hit and distinct marked gold turns among the reference ranking's first five, matching the old rerank evidence-count convention.
- `callCount`, `noCall`, `queryMismatchCount` (only explicit false), and `errorCount` are separate operational measures. Missing query comparisons do not count as equal or mismatched.

`summarizeRetrieval(rows)` consumes `{ prototype, language, metrics }` and macro-averages MRR/nDCG/Recall/Precision separately per prototype/language. It separately totals top-five hit questions, gold turns, calls, no-call questions, mismatches and errors. No cross-language or cross-prototype headline score is produced.

Group 1 output contains full per-question rankings and metrics, plus separate `latency` (build/search milliseconds) and `memory` (before/after process snapshots). Process-wide peak RSS is separately labeled in `resources`; it is not a per-question isolated peak or a relevance metric. Group 2 is a single run per question, without invented confidence intervals. Query trace/latency/memory sidecars must not enter engine inputs or combine with relevance into one score.

Tests: `test/retrieval-evaluation.test.mjs`; no prototype-specific or frozen result files are modified by this layer.
