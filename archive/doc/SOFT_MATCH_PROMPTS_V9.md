# Soft-match tool descriptions — English v9

On **2026-10-05**, 凛音 decided that **v9 = v8 plus one punctuation-quoting sentence** in both the history_recall description and query parameter description (**RSM-SQLITE-V9-ESCAPE-20261005**); that wording-only change left retrieval logic and the other two tools unchanged. Under **RSM-SQLITE-SNIP240-SQLPUSH-20261005**, the snippet wording below now reflects a default of 240 weighted units, and the implementation groups normalized full-message contents in SQL rather than query-selected snippets; grep/expand wording remains unchanged.

## Status and applicable configuration

On **2026-10-05**, 凛音 approved applying English v8 to the **SQLite prototype** for end-to-end comparison under **RSM-SQLITE-V8-JSFAST-20261005**. `archive/benchmark/retrieval-sqlite-adapter.ts` now registers the complete descriptions and parameter strings below as static literals. This does not replace the frozen descriptions in `archive/doc/SOFT_MATCH_PROMPTS.md` or change production `src/recall-extension.ts`; applying the text is not a claim that a model evaluation has run.

The baseline is the **full-mode English** `description` and parameter-description strings in `src/recall-extension.ts`, not the frozen Chinese SQLite prompt. `porter-jieba` is the SQLite configuration to which the Porter/jieba wording applies; it is **not the production default** and is not the default SQLite arm. `createIndex` defaults to `off`, and `createWorkerEngine` selects `COMPACTION_RECALL_SQLITE_ARM` or `off`. Porter wording below applies to unquoted English operands in the selected `porter-jieba` arm; it is not a claim about every arm.

The three complete description blocks below can be copied independently. Comparison labels and code evidence are outside the copyable text. Parameter blocks contain the complete English description strings; they do not propose a schema change.

Reference shorthand in the comparison tables: `index.mjs`, `query.mjs`, `porter.mjs`, `arms.mjs`, and `lexical.mjs` all mean files under `archive/prototype/soft-match-sqlite/`; `history.mjs` means `src/history.mjs`. References to the changing SQLite path identify implementation symbols rather than unstable line numbers. Production-source line ranges retain their original baseline context.

## 1. history_recall

### Complete description

```text
Primary keyword lookup of compacted conversation history on the current branch. Honors the latest branch-local context edits: omitted entries are unavailable and replacements hide original content. Use automatic locator hints, then this tool with focused or rewritten keywords to find related entry ids. Uses the same lexical ranking as automatic hints, not semantic search: supply alternative wording or synonyms yourself. The query uses FTS5 MATCH syntax; space-separated bare terms are combined with OR, while explicit AND, NOT and NEAR() expressions are supported. Double quotes request an exact indexed-token phrase, not an arbitrary substring of the original text; unqualified quoted terms are not Porter-stemmed. For terms containing FTS5 syntax characters ($, -, :, *, parentheses or quotes), use double quotes, doubling any embedded double quote; matching still follows indexed tokens, not literal punctuation. In the porter-jieba configuration, unquoted English terms also match their English Porter stems, while Chinese indexing combines adjacent Han bigrams with jieba-derived words of at least three Han characters. Two-character Chinese terms are the most reliable building blocks; longer terms must exist in the index, and mixed bigram/word token sequences can affect quoted phrase matches. There is no explicit query-length or keyword-count cap; SQLite syntax and resource limits still apply. Manual recall has a configurable cooperative JavaScript deadline, defaulting to 5000 ms, covering index preparation and query execution; native MATCH is non-interruptible and may continue until the next checkpoint, late results are discarded, and healthy worker caches are reused without cancelling other requests. Searches user/assistant text plus assistant tool-call names and arguments; excludes toolResult bodies, thinking and images. Paginated results: limit defaults to 50 (maximum 50), offset defaults to 0. Returns total, returned, nextOffset and hasMore; use nextOffset (not offset + limit) with the same query and unchanged branch for another page. Pages target 16000 Unicode codepoints; an oversized metadata row is returned alone and flagged rather than lost. Each snippet contains up to the configured snippet budget (default 240 weighted units) in a matched-term window selected for distinct-term coverage, plus optional ellipses. Han codepoints count as 2 snippet-budget units and other codepoints as 1; configure snippetBudget or COMPACTION_RECALL_SNIPPET_BUDGET to override the default. Verify exact details with history_expand. If evidence remains insufficient, use history_grep as a supplementary text-search fallback over the same text and tool-input scope. No hit does not prove the information was never mentioned.
```

### Complete parameter descriptions

`query`:

```text
FTS5 MATCH expression; space-separated bare terms use OR; explicit AND, NOT and NEAR() are supported. Double quotes match an exact indexed-token phrase, not an arbitrary original-text substring, and unqualified quoted terms are not Porter-stemmed. For terms containing FTS5 syntax characters ($, -, :, *, parentheses or quotes), use double quotes, doubling any embedded double quote; matching still follows indexed tokens, not literal punctuation. In the porter-jieba configuration, unquoted English terms also match English Porter stems; Chinese uses adjacent Han bigrams plus jieba-derived words of at least three Han characters, so two-character terms are the most reliable and mixed token sequences can affect phrases. No explicit query-length or keyword-count cap; SQLite syntax and resource limits still apply. Manual recall uses a cooperative JavaScript deadline of 5000 ms by default, including preparation and query execution; native MATCH is non-interruptible and may continue until the next checkpoint, late results are discarded, and healthy worker caches are reused without cancelling other requests; configure recallTimeoutMs or COMPACTION_RECALL_QUERY_TIMEOUT_MS.
```

`limit` (verbatim):

```text
Maximum results on this page (default 50)
```

`offset` (verbatim):

```text
Result offset (default 0); use nextOffset from the previous page
```

### Sentence-by-sentence comparison with the formal English baseline

“Preserved” means the sentence is retained verbatim, not merely equivalent. One original concatenated string contains both the scope and pagination sentences; these are audited separately. Code references identify the behavior checked by source inspection, not a newly executed test.

| Baseline sentence / location | v8 treatment | Code evidence and verified scope |
| --- | --- | --- |
| “Primary keyword lookup of compacted conversation history on the current branch.” (`src/recall-extension.ts:171`) | **Preserved.** | `src/history.mjs:125–132`, `compactedEntries`, resolves the latest compaction boundary on the supplied branch; `src/background-index.mjs`, `BackgroundIndex.prepare`, uses that compacted projection; adapter obtains `ctx.sessionManager.getBranch()`. No cross-session or abandoned-branch search is added. |
| “Honors the latest branch-local context edits: omitted entries are unavailable and replacements hide original content.” (`:172`) | **Preserved.** | `src/history.mjs:92–117`, `branchMessageEntries`, scans all branch edits, applies latest replacement, skips null replacements; `BackgroundIndex.prepare` uses that projection. |
| “Use automatic locator hints, then this tool with focused or rewritten keywords to find related entry ids.” (`:173`) | **Preserved.** | `archive/benchmark/retrieval-sqlite-adapter.ts`, `sqliteAdapter`: context hook calls `queryRanked` with `mode: 'auto'`; manual executor calls `queryPage`. This remains a suggested workflow, not mandatory automatic tool execution. |
| “Uses the same lexical ranking as automatic hints, not semantic search: supply alternative wording or synonyms yourself.” (`:174`) | **Preserved.** | `index.mjs`, `collect`, uses SQL MATCH/BM25, groups by normalized full-content SHA-256, selects the best BM25 representative (ties: timestamp/source recency), then sorts by score and time. Automatic and manual queries share the SQL ranking; bounded tool paths select only the current page, while `queryRows` remains the complete-rank evaluation interface when no bounds are passed. |
| “Searches user/assistant text plus assistant tool-call names and arguments; excludes toolResult bodies, thinking and images.” (`:175`, first sentence) | **Preserved.** | `src/history.mjs:49–78`, `messageText` / `searchableEntryText`, extract text and assistant tool calls, only for user/assistant records; `src/background-index.mjs`, `BackgroundIndex.build`, supplies that search scope to the worker. |
| “Paginated results: limit defaults to 50 (maximum 50), offset defaults to 0.” (`:175`, second sentence) | **Preserved.** | `src/locator.mjs`, `validateRecallPageOptions` / `recallPageFromRows`; `archive/benchmark/retrieval-sqlite-page.mjs`, `sqliteRecallPage`, reuses this renderer inside worker-side `queryPage`. These are result-page controls, not a query-term cap. |
| “Returns total, returned, nextOffset and hasMore; use nextOffset (not offset + limit) with the same query and unchanged branch for another page.” (`:176`) | **Preserved.** | `src/locator.mjs:303–311,321–330`, `recallPageFromRows`, counts actual returned rows and may stop before `limit`; `sqliteRecallPage` may reduce the page limit to fit missing-term diagnostics. Pagination is not a persistent snapshot of an edited branch. |
| “Pages target 16000 Unicode codepoints; an oversized metadata row is returned alone and flagged rather than lost.” (`:177`) | **Preserved.** | `src/locator.mjs`, `recallPageFromRows`, measures `Array.from(page.text).length`, returns one oversized row with `budgetExceeded`, and does not skip it; `archive/benchmark/retrieval-sqlite-page.mjs`, `sqliteRecallPage`, preserves the page renderer. |
| “Each snippet contains up to 120 Unicode codepoints around the most informative matched term, plus optional ellipses.” (`:178`) | **Modified selection and default budget:** “Each snippet contains up to the configured snippet budget (default 240 weighted units) in a matched-term window selected for distinct-term coverage, plus optional ellipses.” | `index.mjs`, `collect`, lazily selects and renders only displayed rows with `sentenceBonus: false`, `weighted: true`; Han codepoints cost 2 and other codepoints 1. All valid configured budgets use these units; missing/invalid configuration defaults to 240. Content grouping does not depend on snippet text. |
| “Verify exact details with history_expand.” (`:179`) | **Preserved.** | `src/recall-extension.ts:389–430`, expand executor reads branch-effective entry text rather than relying on snippets; adapter reuses the executor. |
| “If evidence remains insufficient, use history_grep as a supplementary text-search fallback over the same text and tool-input scope.” (`:179–180`) | **Preserved.** | `src/recall-extension.ts:223–240`, grep scans `compactedEntries` through `searchableEntryText`; `src/history.mjs:49–78` defines the same search scope. Adapter reuses the executor. |
| “No hit does not prove the information was never mentioned.” (`:180`) | **Preserved.** | MATCH is lexical (`index.mjs`, `collect` / `rawRows`) and scoped to currently available compacted history (`compactedEntries`); a lexical miss cannot establish conversational absence. This caveat remains unchanged. |
| `query`: “Focused keywords or revised wording; first 4000 Unicode codepoints and 24 distinct terms are used” (`:182`) | **Replaced in full** by the query block above. | Manual SQLite `rawRows` and `queryOperands` use the supplied expression rather than production's bounded keyword extractor; additions are individually accounted for in the next table. |
| `limit`: “Maximum results on this page (default 50)” (`:183`) | **Preserved.** | Adapter schema and `validateRecallPageOptions` / `recallPageFromRows`; the 50 maximum remains. |
| `offset`: “Result offset (default 0); use nextOffset from the previous page” (`:184`) | **Preserved.** | Adapter offset schema and `recallPageFromRows:301–311`; only result pagination is affected. |

### Added / replacement lexical sentences and their evidence

Each row covers one added description sentence; equivalent information in the replacement `query` description is covered by the same row.

| v8 sentence | Difference from formal English baseline | Code evidence |
| --- | --- | --- |
| “The query uses FTS5 MATCH syntax; space-separated bare terms are combined with OR, while explicit AND, NOT and NEAR() expressions are supported.” | **Added:** documents manual MATCH syntax instead of suggesting natural-text keyword extraction. | `index.mjs`, `implicitOr`, groups adjacent implicit operands with OR while preserving explicit syntax; `rawRows` applies it before `collect` executes MATCH. `query.mjs`, `operands`, distinguishes operators and NEAR distances from terms. |
| “Double quotes request an exact indexed-token phrase, not an arbitrary substring of the original text; unqualified quoted terms are not Porter-stemmed.” | **Added:** phrase precision is indexed-token precision, not raw-text substring precision. | `index.mjs`, `createIndex`, stores pretokenized token sequences in FTS5, not original text; `porter.mjs`, `porterExpression`, routes unqualified quoted units to `tokens` with `stem: false`; `query.mjs`, `queryOperands`, does not retokenize Han MATCH operands into bigrams. Explicit column filters are native escape hatches, so the statement is deliberately qualified. |
| “In the porter-jieba configuration, unquoted English terms also match their English Porter stems, while Chinese indexing combines adjacent Han bigrams with jieba-derived words of at least three Han characters.” | **Added, configuration-qualified:** not a Porter default for every arm. | `index.mjs`, `createIndex`, selects stem columns and `createStemmer` only for appropriate arms; `porter.mjs`, `createStemmer` / `porterExpression`, uses SQLite `porter ascii` and expands unquoted operands to raw/stem columns. `arms.mjs`, `createTokenizer`, supplies `jieba.cutForSearch`; `lexical.mjs`, `tokenizeSpans`, always adds adjacent Han bigrams and adds segmented terms only at length ≥3. |
| “Two-character Chinese terms are the most reliable building blocks; longer terms must exist in the index, and mixed bigram/word token sequences can affect quoted phrase matches.” | **Added:** explains practical query construction and phrase limits without falsely promising arbitrary Chinese substrings. | `lexical.mjs`, `tokenizeSpans`, emits bigrams plus longer segmented words, ordered by source start and shorter length first; `index.mjs`, `createIndex`, serializes them into one indexed sequence. `query.mjs`, `queryOperands`, leaves a long Han operand whole. Two-character terms are the systematic indexed unit; jieba membership for longer terms is conditional. |
| “There is no explicit query-length or keyword-count cap; SQLite syntax and resource limits still apply.” | **Added / replaces the capped query parameter:** removes the old first-4000/24 wording and does not substitute a new term count. | `archive/benchmark/retrieval-sqlite-adapter.ts`, manual `execute`, passes `params.query` without a term-count rejection. Manual `rawRows` (`index.mjs`) and `queryOperands` (`query.mjs`) take the complete expression. This means no application-enforced length/count cap, not unlimited native SQLite resources; automatic hint gating is separate. |
| “Manual recall has a configurable cooperative JavaScript deadline, defaulting to 5000 ms, covering index preparation and query execution; native MATCH is non-interruptible and may continue until the next checkpoint, late results are discarded, and healthy worker caches are reused without cancelling other requests.” | **Added:** cooperative deadline rather than an input cap or hard native cancellation guarantee. | `SQLiteBackgroundIndex.queryRanked` starts an absolute `queryNow()` deadline before the shared operation and passes `options.queryDeadlineAt` / `queryTimeoutMs`; `deadline.mjs`, `createQueryCheck`, throws `TimeoutError` at elapsed checkpoints. `index.mjs`, `collect`, checks before and after synchronous `match.all` and inside JS phases. `SQLiteBackgroundIndex.queryRanked` checks the result again after await. No request-time terminate/reset occurs. `src/recall-config.mjs`, `loadRecallConfig`, defaults to 5000. |
| “Han codepoints count as 2 snippet-budget units and other codepoints as 1; configure snippetBudget or COMPACTION_RECALL_SNIPPET_BUDGET to override the default.” | **Added:** the default and every valid override use weighted units; there is no legacy codepoint-mode switch. | `src/recall-config.mjs`, `loadRecallConfig`, loads root `snippetBudget` once with environment priority and a 240 fallback; `index.mjs`, `collect`, always uses weighted range selection. |

## 2. history_grep — full-mode description copied verbatim

### Complete description

```text
Supplementary text-search fallback when automatic locators, history_recall and expanded entries leave insufficient evidence. Search branch-effective user/assistant text and assistant tool-call names/arguments on the current compacted branch, honoring context edits; exclude toolResult bodies, thinking and images. No matches do not prove absence. `pattern` is a case-insensitive JavaScript regular expression (not SQL LIKE); invalid patterns fall back to literal search. Pages matching entries in branch order: limit defaults to 30 (maximum 50), offset defaults to 0. Use nextOffset with the same pattern and unchanged branch; returned counts entries consumed, including explicitly skipped oversized metadata. total counts raw regex matches, totalEntries matching entries; covered counts other matches visible in this page's snippets, omitted counts raw matches not shown anywhere in this response. Each page shows up to 30 representative snippets overall and at most 3 per entry; full output stays within 16000 Unicode codepoints. Clipped-out text is not covered. Read full text with history_expand or use a narrower pattern to find matching context not shown.
```

### Parameter descriptions — all verbatim

| Parameter | Complete English description |
| --- | --- |
| `pattern` | `Case-insensitive JavaScript regular expression` |
| `limit` | `Maximum matching entries on this page (default 30)` |
| `offset` | `Matching-entry offset (default 0); use nextOffset to continue` |

### Preserved-sentence verification

All sentences and parameter strings are unchanged from `src/recall-extension.ts:209–221`, choosing the **full** branch of the first sentence.

| Preserved sentence | Verified scope / code evidence |
| --- | --- |
| “Supplementary text-search fallback when automatic locators, history_recall and expanded entries leave insufficient evidence.” | Full-mode workflow wording (`:212`); grep executor remains independent of the SQLite index. |
| “Search branch-effective user/assistant text and assistant tool-call names/arguments on the current compacted branch, honoring context edits; exclude toolResult bodies, thinking and images.” | `:225–232` uses `compactedEntries` / `searchableEntryText`; `history.mjs:49–78,92–132` verifies extraction, edit visibility and compaction boundary. |
| “No matches do not prove absence.” | Same bounded text scope and regex-only matching; unchanged epistemic caveat (`:213`). |
| “`pattern` is a case-insensitive JavaScript regular expression (not SQL LIKE); invalid patterns fall back to literal search.” | `history.mjs:136–141`, `toRegExp`, constructs `gi` regex or escaped literal regex. |
| “Pages matching entries in branch order: limit defaults to 30 (maximum 50), offset defaults to 0.” | `:220–221,227–245` verifies schema, branch-order collection and matching-entry pagination. |
| “Use nextOffset with the same pattern and unchanged branch; returned counts entries consumed, including explicitly skipped oversized metadata.” | `:278–287,296–323,360–365` tracks consumed entries and pagination state, not regex-occurrence offset. |
| “total counts raw regex matches, totalEntries matching entries; covered counts other matches visible in this page's snippets, omitted counts raw matches not shown anywhere in this response.” | `:227–238,345–365` verifies count accumulation and visible-match accounting. |
| “Each page shows up to 30 representative snippets overall and at most 3 per entry; full output stays within 16000 Unicode codepoints.” | `:288–291,329–340`; `src/history.mjs:6–8` constants. |
| “Clipped-out text is not covered.” | `:345–355` counts only fully visible ranges; codepoint clipping is not evidence coverage. |
| “Read full text with history_expand or use a narrower pattern to find matching context not shown.” | Unchanged recommendation (`:217`), supported by the separate expand executor (`:389–430`). |
| All three parameter descriptions | Copied from `:219–221`; schema remains regex string, optional limit 1–50 and nonnegative safe offset. |

## 3. history_expand — full-mode description copied verbatim

### Complete description

```text
Read branch-effective text (honoring context edits) of a compacted history entry by id (from automatic locators, history_recall or history_grep). The requested entry is shown first; output is bounded to 16000 Unicode codepoints. Use offset (default 0), in Unicode codepoints of the requested entry, to continue a long entry; when hasMore is true, pass nextOffset with the same id and before/after values. Neighbor entries (before/after default 2, maximum 20) are included only when the full target is shown and each full neighbor fits. Includes tool-call names/arguments and readable toolResult text; excludes thinking and images. Only the current compacted branch is readable.
```

### Parameter descriptions — all verbatim

| Parameter | Complete English description |
| --- | --- |
| `id` | `Entry id from automatic locators, history_recall or history_grep` |
| `before` | `Entries before (default 2)` |
| `after` | `Entries after (default 2)` |
| `offset` | `Unicode codepoint offset within the requested entry (default 0); use nextOffset to continue` |

### Preserved-sentence verification

All sentences and parameter strings are unchanged from `src/recall-extension.ts:377–387`, choosing the **full** branches for description and `id`.

| Preserved sentence | Verified scope / code evidence |
| --- | --- |
| “Read branch-effective text (honoring context edits) of a compacted history entry by id (from automatic locators, history_recall or history_grep).” | `:391–396`, `compactedEntries` and `entryText`; `history.mjs:92–132` verifies edits and boundary. |
| “The requested entry is shown first; output is bounded to 16000 Unicode codepoints.” | `:395–406,417–424` creates target output first, reserves page-status space, and only appends fitting neighbors. |
| “Use offset (default 0), in Unicode codepoints of the requested entry, to continue a long entry; when hasMore is true, pass nextOffset with the same id and before/after values.” | `:397–405,423–428` measures/slices Unicode codepoints and returns continuation state. |
| “Neighbor entries (before/after default 2, maximum 20) are included only when the full target is shown and each full neighbor fits.” | `:385–386,410–420` verifies schema limits and whole-neighbor fit; actual neighbors are considered only when `!hasMore && offset === 0`. Original wording is retained, not broadened into a promise of neighbors on continuation pages. |
| “Includes tool-call names/arguments and readable toolResult text; excludes thinking and images.” | `:396,416` uses `entryText`; `history.mjs:49–63,82–84` includes text/tool calls but not thinking/images, without the search-only role filter. |
| “Only the current compacted branch is readable.” | `:391–393` looks up id only within `compactedEntries(branch(ctx))`; an unavailable id is not read from another scope. |
| All four parameter descriptions | Copied from `:384–387`; defaults and schema constraints remain unchanged. |

## 4. Executor reuse and configuration boundaries

### grep / expand really reuse production execution

`archive/benchmark/retrieval-sqlite-adapter.ts`, `sqliteAdapter`, imports `registerProduction`, temporarily sets mode to `lite` for synchronous registration, filters registrations to `history_grep` and `history_expand`, and registers `{ ...tool, description: descriptions[name], parameters: parameters[name] }`. The `execute` function is preserved from the production tool object; it is not reimplemented as a SQLite query. The production hooks are intercepted during this registration. The adapter restores the original mode environment afterward.

Consequently copying the **full English wording** here is intentional even though the reused executor was registered through the production lite branch. Full versus lite changes those source descriptions/`id` wording and tool availability, not the grep/expand executor's text scope or paging behavior. The adapter installs the English v8 descriptions and parameter descriptions above; no runtime Markdown reading or separate prompt-source module is used.

### Timeout and automatic-gate configuration

The agent-wide file is `<getAgentDir()>/extensions/compaction-recall.json`. These are **root keys**, not `preindex` children:

```json
{
  "recallTimeoutMs": 5000,
  "autoGate": 210
}
```

- `recallTimeoutMs` configures manual SQLite recall's deadline in milliseconds. `COMPACTION_RECALL_QUERY_TIMEOUT_MS` takes precedence over the file value. The default is **5000**.
- `autoGate` configures automatic hint eligibility only. `COMPACTION_RECALL_AUTO_GATE` takes precedence over the file value. The default remains **210**; an experiment setting of **280** is not a new default.
- `snippetBudget` is an optional **root key** for both automatic and manual SQLite snippet windows. `COMPACTION_RECALL_SNIPPET_BUDGET` takes precedence; valid file values are positive safe-integer numbers and valid environment values are strictly decimal positive safe-integer strings. Missing or invalid selected values default to **240 weighted units**; an invalid environment override does not fall through to the file. Each `\p{Script=Han}` codepoint costs 2 and every other Unicode codepoint 1, including for an explicit value of 120. Values are read once at registration. Ellipses remain outside the snippet budget and output/page budgets retain their existing rules; no per-query tool parameter is added.
- File values must be positive safe-integer numbers; environment values must be strictly decimal positive safe-integer strings. If the selected higher-priority environment value is invalid, it silently falls back to the default, not to a lower-priority file value. Invalid selected file values also silently use the default. A missing file is silent.
- Values are loaded once during adapter registration. Editing the file or environment after registration does not change an existing adapter instance's timeout/gate/snippet-budget settings.
- The automatic gate uses weighted input length (Han codepoints count as 2, other codepoints as 1) and may skip automatic hints. It is **not a manual-query cap**. `index.mjs`, `weightedLength`, `automaticRows`, `queryRows` and `queryPage`, establish this distinction.
- A manual deadline covers required index preparation, queueing and query execution. SQLite uses the existing **Worker thread**, not a subprocess. Deadline checks cooperatively stop JavaScript phases and discard late results; synchronous native MATCH cannot be interrupted and may run beyond the nominal deadline until it returns to a checkpoint. Timeout does not terminate/reset the worker, clear its index/span caches or cancel other queued requests. The next request reuses healthy worker caches; this is not a hard native-work-stop guarantee.

Configuration and interruption evidence:

| Claim | Actual code reference |
| --- | --- |
| Agent path, root keys, missing-file silence | `src/recall-config.mjs`, `loadRecallConfig`, uses `getAgentDir()` and root `parsed.recallTimeoutMs` / `parsed.autoGate` / `parsed.snippetBudget`; ENOENT does not warn. |
| Decimal environment parsing, positive safe integers, silent defaults and environment precedence | `src/recall-config.mjs`, `positiveInteger` / `decimal` / `loadRecallConfig`; environment presence selects its value before validation, with literal defaults 5000/210/240 for timeout/gate/snippet budget. No warnings are emitted for invalid selected values of these fields. |
| Registration-time load and fixed constructor values | `archive/benchmark/retrieval-sqlite-adapter.ts`, `sqliteAdapter`, loads once and passes `config.autoGate` / `config.recallTimeoutMs` / `config.snippetBudget`; `SQLiteBackgroundIndex.constructor` fixes those values without a child-process host. |
| Manual-only deadline, preparation/queueing included, optional scoped timeout override | `SQLiteBackgroundIndex.queryRanked` starts `queryNow() + timeoutMs` before awaiting the shared operation; `queryPage` selects manual mode. `BackgroundIndex.queryRanked` / `query` include `prepare(branch)` and its readiness wait before RPC. The adapter does not expose a tool-schema timeout parameter. |
| Cooperative checkpoints, late-result discard, healthy caches retained | `deadline.mjs`, `queryNow` / `createQueryCheck`, share absolute monotonic performance timestamps across parent/worker. `createWorkerEngine.query` constructs the manual check from `options.queryDeadlineAt` / `queryTimeoutMs`, passes it to `queryRows` / `queryPage`, materializes full-rank replies inside engine handling and checks before returning. `index.mjs`, `compileOperands` / `collect`, check JS stages and MATCH boundaries; synchronous native MATCH cannot be preempted. `SQLiteBackgroundIndex.queryRanked` checks received results too. A timeout remains a custom engine error, not a worker failure; no reset/terminate/cache drop or cancellation of unrelated queued work occurs. |
| Production remains separate | The SQLite specialization lives under `benchmark/`; production `src/recall-extension.ts` retains `index.query` and its original lexical behavior. v8 does not imply a production SQLite cutover. |
| Weighted snippet budget without a compatibility branch | `loadRecallConfig` selects root `snippetBudget` / `COMPACTION_RECALL_SNIPPET_BUDGET` once, defaulting to 240. The worker passes this to `createIndex`; every `collect` snippet uses `weighted: true`, Han 2 / other codepoints 1, inward-rounded codepoint boundaries, and unchanged ellipses. Automatic/manual share the same SQL and snippet path. |

## Verification boundary

This document records source-inspection evidence and copies the official full-mode English strings, with the explicitly audited SQLite changes above. v8 is applied to the prototype as static adapter literals. No model calls, profile changes or frozen benchmark-data changes are part of applying these strings. Retrieval quality and runtime measurements belong to separately authorized offline verification; no new measurements are asserted here.

Scoped offline SDK registration smoke loaded the actual adapter from an isolated temporary agent directory: all three registered descriptions and all ten parameter-description strings matched this document byte-for-byte. It did not start a worker or call a model; project-wide checks remain a separate final integration step.

An explicit-240 offline surface smoke exercised `index.queryPage` text and automatic `queryRows` on mixed ASCII/Han content: both returned the same snippet, its window cost exactly 240 weighted units and exceeded 120 codepoints, while that historical unconfigured window remained 120 codepoints (before the default-240 cutover). The manual page returned the actual id. This is a targeted budget-surface observation, not retrieval-quality evidence or a suite result.
