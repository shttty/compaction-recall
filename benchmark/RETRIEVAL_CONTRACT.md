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
- Current SQLite: `search(input, { limit })` (sync or async), where `input` is `{concepts:string[][],match?:'any'|'all',exclude?:string[]}`; returns `{ total, results: [{ id, score }] }`. `total` is the complete match count; `results` is the requested ranked prefix. Literal concepts use the author's strict compiler, not native raw syntax; parameter/analysis and native SQLite errors retain name/code/message. The former `searchRaw` boundary belongs to historical evaluations, not the current SQLite engine or a required group-1 API.
- Optional `dispose()` releases engine resources.

The shared `searchAutomatic(engine, question)` applies the automatic-only 210 weighted-code-point gate **before engine tokenization**: each Han character counts 2, every other character 1, exactly 210 is accepted, more than 210 returns no hints without calling the engine. Manual searches have no such gate.

Both groups pass the frozen user question verbatim to `searchAutomatic`. Group 2's no-call fallback must equal group 1 for the same engine/corpus/question, so the ASK framing is not included in automatic term selection or the 210 gate. The model still receives `evaluate.py`'s `ASK.format(question_date, question)`. Models choose their own manual inputs; current SQLite preserves the original concept object for trace and applies only the author-defined normalization during compilation. Do not force a call or substitute the question as a manual input. Archived raw-query evaluations remain historical evidence.

### Shared worker engine seam (S2-0)

Evaluation adapters must use `BackgroundIndex` from `src/background-index.mjs`, not implement a second worker protocol. Construct `new BackgroundIndex({ engineModule: new URL('./worker-engine.mjs', import.meta.url), timer: recallTiming })`; the path is an explicit native JavaScript **file URL**, supplied by the adapter. `src/` never imports a prototype or benchmark module. Omit `engineModule` for the production cached-token engine in `src/default-worker-engine.mjs`.

The worker module exports `createWorkerEngine()` (sync or async), returning:

```ts
type WorkerEntry = {
  type: 'message'; sourcePosition: number; id: string; timestamp: string;
  message: { role: 'user' | 'assistant'; content: string };
};
type RankedRow = { id: string; date: string; role: string; snippet: string; score?: number };
interface WorkerEngine {
  prepareEntry?(entry: WorkerEntry): WorkerEntry;
  commit(entries: WorkerEntry[], settings: {
    eligibleCount: number; append: boolean; timer?: StageTiming;
  }): { documents: number } | Promise<{ documents: number }>;
  query(query: unknown, settings: {
    mode: 'auto' | 'manual'; options: {limit?: number; offset?: number}; timer?: StageTiming;
  }): { total: number; results: RankedRow[] } | Promise<{ total: number; results: RankedRow[] }>;
  dispose?(): void | Promise<void>;
}
```

The common host owns `begin`, bounded `batch`, oversized text chunk assembly, `commit`, generation checks and serialized asynchronous command execution. `prepareEntry` can pre-tokenize both eligible and live text, preserving entry metadata/source position; omit it when no useful precomputation exists. `commit` receives the complete staged list (not just the additions). **Only entries with `sourcePosition < eligibleCount` may enter searchable postings/statistics.** Live entries may retain prepared tokens, never searchable candidates/DF/N. `append` means the transferred source prefix is unchanged, not that all old entries remain live or eligible; eligibility can expand with zero additions. Engines may diff their previous eligible entries to incrementally update, or rebuild; branch/edit changes use the same common rebuild/reset path. The default engine preserves its cached-token activation.

`index.prepare(branch, {preindexLive:true})` is lifecycle prewarming; `index.queryRanked(question, branch, {mode:'auto'})` waits for required readiness and returns complete automatic ranks for an explicit engine. Other arms preserve their `params.query` manual input; current SQLite forwards the concept object after removing only outer pagination fields to `queryPage`. Prototype compilation, the automatic 210 gate, ranking and snippets belong to the engine wrapper. Complete-rank calls retain their complete ranking; SQLite tool pages apply the SQL limit/offset before rendering.

Custom engine query failures return the original error `message`, `name` and string `code` over RPC, without lexical fallback, rewriting or stopping a healthy worker. Build/import/commit failures likewise surface instead of silently switching retrieval semantics; stack identity and other native error properties are not transported. Production's default worker-failure synchronous-scan fallback remains intact. `await index.dispose()` waits for custom `dispose()` then worker termination; generation invalidation/reset may forcibly terminate obsolete work. Lifecycle event handlers await cleanup where the SDK permits it.

#### SQLite-only page extension (2026-10-05)

The complete-rank interface above remains available for automatic hints, mechanical group 1 and other engines. SQLite's actual manual tool uses `SQLiteBackgroundIndex.queryPage(queryObject, branch, {limit?,offset?})` through the same serialized query RPC; there is no second host or worker protocol. The tool takes named `concepts: string[][]`, optional `match: 'any'|'all'` (default `any`), optional `exclude: string[]`, plus outer pagination. Execute removes only `limit` and `offset`; all remaining keys reach the strict author compiler, so old `query`, `must`, `prefer` and other unknown fields fail rather than disappear. The worker's compiler is pure JavaScript generated with Node builtin `stripTypeScriptTypes` from unchanged author source, exporting `parseQuery`, `compileFts5`, `QueryError`, and `LIMITS`. No raw manual compatibility remains in the SQLite chain.

Concepts contain 1..5 groups of 1..4 alternative literal surfaces each. `any` ORs groups; `all` requires every group in the same indexed row. Alternatives within a group are OR; analyzer branches are OR and atoms within each branch AND (co-occurrence, not phrase order or adjacency). Strings are data, never SQL/FTS syntax or arbitrary ASTs; the model need not hand-split Han bigrams. `exclude` has at most 5 literal surfaces and hard-removes a record matching any one, not a rank penalty; broad exclusions risk hiding useful evidence. Trimmed nonempty surfaces have a 256-codepoint individual and 2048-codepoint aggregate budget; malformed text, unknown fields and empty analysis fail without truncation. Author analysis limits remain 4 branches per surface, 16 atoms per branch, 4096 codepoints per atom, 256 expanded atoms and 32768 compiled MATCH UTF-16 units. Analysis uses the actual base tokenizer without U+E000 barriers; lemma-index uses existing document normalization, with no additional stemming expansion in other arms. Only positive concepts guide snippets.

Internal `mode:'auto'|'manual'` alone controls autocut: auto retains natural language, machine-selected terms, query generation and the default 210/configured weighted-length gate, without manual validation or zero-hit warning. Manual uses the strict concept object and parameterized compiled MATCH. Native BM25, normalized-full-content deduplication, time ties and SQL page ordering are unchanged. The worker returns `{total,page:{text,details},ids}` using real distinct-content counts and lazy displayed snippets. Default/maximum 50 rows, 16000-codepoint page budget, default 240 weighted snippet units, nextOffset and oversized-metadata progress rules remain intact. Only a true zero total warns to check concept grouping, any/all and surfaces or use history_grep; an empty offset page with positive total does not warn. QueryError name/code/message and native Error/code survive RPC; healthy workers do not clear caches or fall back after a query error.

SQLite manual deadlines start on the parent before preparation/queueing and are passed as absolute `queryDeadlineAt` and `queryTimeoutMs`. Checks cooperatively abort JavaScript work and discard late worker/parent results. Synchronous native MATCH is non-interruptible: it can exceed the nominal timeout until it returns to a checkpoint. Timeout is an engine `TimeoutError`, not a broken worker; it does not terminate/reset, clear index/span caches or cancel other queued requests. Healthy caches remain reusable. Normal generation invalidation and shutdown retain the shared lifecycle semantics.



## Rendering and production package loading

Automatic display reuses production `formatLocatorRows(rows)` from `src/locator.mjs` (top-five and character budget). Manual display reuses `recallPageFromRows(rows, { limit, offset }, timer?)` from the same file. Rows are already ordered `{ id, date, role, snippet }`; the helper does not score, reorder, filter or deduplicate. It uses the same JSON escaping, header, 16000-code-point budget, oversized-row progress rule, defaults, validation and pagination details as the production `recallPageFromCandidates` path. Offsets refer to the supplied complete ranking; fetch enough engine results before rendering. Relevance metrics use full ranking sidecars, not ids parsed from budget-truncated display text.

A production arm is an explicit, fixed, read-only package root with `package.json` declaring **exactly one** `pi.extensions` entry. SDK loading resolves that entry relative to the package root, not by assuming `src/index.ts` or rewriting the package. Group 2 rejects writable package files and escaping entry paths. No installation into a personal profile, no package mutation, no implicit fallback to another arm. `run.json` records the selected package root, resolved extension path and package/engine hashes.

### Adapter responsibilities

- Export a normal Pi extension registration function from the manifest entry. Register the three tools with the arm's approved descriptions and parameter strings; frozen arms retain `doc/SOFT_MATCH_PROMPTS.md`. SQLite applied English v8 on 2026-10-05 per `doc/SOFT_MATCH_PROMPTS_V9.md`; production descriptions remain unchanged.
- Build/update the worker engine through `BackgroundIndex.prepare`; the common layer owns the current branch's production projection and transfer. Gold, answers, judge records and scorer sidecars never enter the engine or provider request.
- In `context`, resolve the initial ASK to the original question using explicit read-only `PI_RETRIEVAL_INPUT_FILE` metadata, call `index.queryRanked(question, branch, {mode:'auto'})`, and inject `LOCATOR_TYPE` using production `withLocators` and `formatLocatorRows`. The worker wrapper applies the same `searchAuto` and 210 gate as the mechanical engine, retaining complete rankings; render only top five on the main thread.
- In `history_recall.execute`, other arms preserve `params.query` unchanged and use their existing complete-rank path. SQLite removes only outer `limit`/`offset`, passes the remaining concept query object to `index.queryPage`, and returns its worker-rendered page. Unknown keys remain for strict rejection. SQL groups normalized full-content SHA-256, chooses the best BM25 representative (time ties), orders and applies LIMIT/OFFSET, and counts distinct hashes before display. Actual automatic hints retain the existing five-row SQL limit; mechanical full-rank retrieval is not limited. Branch visibility and context edits are projected before indexing.
- Import `loadRecallConfig` and `createRecallTrace` from the shared `src/` modules. When trace is enabled with a file, wire `message_end` to `messageEnd(sessionId, message)`, `tool_call` to `toolCall(sessionId, event)`, and `agent_end` / shutdown to `flush()`. Call `begin(sessionId, toolCallId, params)` before searching, `complete(token, {ids,total,offset,returned,nextOffset})` with **only actually returned** ids in rank order, or `fail(token, error)` on failure before rethrowing. See `doc/TIMING.md` for nested/missing-model and snapshot semantics.
- SQLite opts into `createRecallTrace({...,inputFields:['concepts','match','exclude']})`: complete original `execute.params` and `model.arguments` are snapshotted, `execute.input` selects these fields in fixed key order, and `input_identical` compares them preserving array order. It emits no fake `query_identical` or stringified object query. Structured errors retain `{name,code,message}`. The production default query/string trace and error strings remain unchanged; trace off adds no behavior. Provider evidence captures only locator presence/own locator and allowlisted effort, never payload text, thinking or credentials. Automatic locators, recall, expand verification and supplementary grep retain the existing selection order.
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

`scoreRetrieval({ goldIds, autoResults, calls = [] })` accepts ranked `{id,score}` arrays (or id arrays) and calls shaped `{ results?, query_identical?, input_identical?, error? }` in execution order. The existing report field `queryMismatchCount` counts `input_identical===false` for structured SQLite calls and `query_identical===false` for legacy string calls; null means no model evidence, not a mismatch. Session scoring preserves the actual marker, without inventing query identity. A failed call still occupies its original position; omitted results mean an empty ranking, not a fallback to a later call.

- Group 1: MRR over the complete automatic ranking; binary nDCG, Recall and Precision at 5/10/20.
- Group 2: Recall@K counts unique gold ids in the union of automatic top K and **each** call's top K. It does not concatenate all rankings and take one global top K.
- Group 2 MRR/nDCG: first call ranking, or automatic ranking only if there were no calls. Precision and top-five evidence use that same reference ranking; precision divides by K, including short/empty result lists.
- Binary nDCG uses `1/log2(rank+1)` and the ideal ranking of `min(K, goldTotal)` gold hits. Repeated ids cannot earn repeated gain.
- `top5Hit` and `locatedGoldTurns` count hit/no-hit and distinct marked gold turns among the reference ranking's first five, matching the old rerank evidence-count convention.
- `callCount`, `noCall`, `queryMismatchCount` (only explicit false), and `errorCount` are separate operational measures. Missing query comparisons do not count as equal or mismatched.

`summarizeRetrieval(rows)` consumes `{ prototype, language, metrics }` and macro-averages MRR/nDCG/Recall/Precision separately per prototype/language. It separately totals top-five hit questions, gold turns, calls, no-call questions, mismatches and errors. No cross-language or cross-prototype headline score is produced.

Group 1 output contains full per-question rankings and metrics, plus separate `latency` (build/search milliseconds) and `memory` (before/after process snapshots). Process-wide peak RSS is separately labeled in `resources`; it is not a per-question isolated peak or a relevance metric. Group 2 is a single run per question, without invented confidence intervals. Query trace/latency/memory sidecars must not enter engine inputs or combine with relevance into one score.

Tests: `test/retrieval-evaluation.test.mjs`; no prototype-specific or frozen result files are modified by this layer.
