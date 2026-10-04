# Codepoint FTS5 snippet experiment

This benchmark-only module is not a production locator replacement. It imports no production tokenizer, index, document frequencies, models, or third-party packages.

## Public interface

```js
import { fts5Snippet, selectFts5Window } from './fts5-snippet.mjs';
const hits = [{ term: '网关', start: 5, end: 7 }];
const snippet = fts5Snippet(text, hits); // default budget: 120 codepoints
const window = selectFts5Window(text, hits, 120);
// { start, end, score, snippet }
```

`text` is a string. Each hit supplies a query identity `term`, an inclusive `start`, and an exclusive `end`, all measured in Unicode codepoints (`Array.from(text)`), not UTF-16 offsets, bytes, or tokens. A repeated identity earns repeat credit; distinct identities earn distinct-term credit. Caller-provided instances are neither tokenized nor deduplicated. Positions are stably sorted without mutating the caller's array. Invalid/empty/out-of-document hit ranges and nonpositive/noninteger budgets throw `RangeError`. The caller owns term matching, normalization, query identity, and stopword decisions.

Returned offsets refer to original text, excluding ellipses. The literal `…` appears only where original text was cut. Ellipses are outside the content budget. No highlighting, word-boundary expansion, trimming, or surrogate splitting is performed. Empty/no-hit input returns the prefix (empty for empty text), score zero. A short document is returned whole.

Both functions accept a fourth argument `{ sentenceBonus: false }` to disable only the sentence-start +100 and first-sentence +120 additions. The default is `{ sentenceBonus: true }`, preserving all prior results. Sentence candidates remain enumerated; distinct/repeated scoring, candidate order/ties, original-score centering, end clamp and ellipses are unchanged.

## Upstream source and provenance

The implementation was read from the requested [SQLite master source](https://raw.githubusercontent.com/sqlite/sqlite/master/ext/fts5/fts5_aux.c), including the complete `fts5SentenceFinderCb`, `fts5SnippetScore`, and `fts5SnippetFunction` and their output/highlight path. `master` is mutable. On 2026-10-03 it was byte-identical to this [immutable revision](https://raw.githubusercontent.com/sqlite/sqlite/95699469b7fff74ceb7492b7dc8370b923f5ccff/ext/fts5/fts5_aux.c):

- Git revision: `95699469b7fff74ceb7492b7dc8370b923f5ccff`.
- Last file-changing commit date: 2026-09-23T11:06:11Z.
- Fossil origin: `55c634d96d390ca52c38c58c66be680c1883d799427ddf23a2501d12e7be07d3`.
- Raw file: 27,519 bytes, 831 lines.
- SHA-256: `47f2a523e2bac297874cd56f55db8f2768604c058ec0cfb4197179e4a1b4aae6`.
- Source inspection transcript artifact: `artifact://22` (session-local, not a repository dependency).

SQLite's source header disclaims copyright and supplies its customary blessing. This is a small algorithm adaptation, not an embedded SQLite copy.

## Preserved scoring

For each hit, score the forward half-open interval `[hit.start, hit.start + budget)`. Inclusion tests the hit **start**, not whether its whole extent fits. The first occurrence of a query identity earns 1000; every subsequent instance of that identity earns 1. No DF, IDF, BM25, rarity boost, or normalized density enters this score.

For hit candidates, preserve upstream's adjusted offset:

```text
first = first included instance's start
last  = last included instance's end (not maximum overlapping end)
iAdj  = first - trunc((budget - (last - first)) / 2)
if iAdj + budget > documentLength: iAdj = documentLength - budget
if iAdj < 0: iAdj = 0
```

`trunc` is C-style integer division toward zero. The score is **not recomputed** after adjustment, even if a very long supplied instance causes the adjusted window to exclude its own start. Sentence candidates are not centered or shifted to fill the end of the document. Strict `>` replaces the winner, so the first equal-scoring candidate wins.

## Intentional modifications

1. **Codepoints, not tokens.** SQLite scores phrase-instance token positions and clamps requested token count to 0–64. Here positions and default budget 120 are codepoints, with no 64-token clamp and no tokenizer. Query identities act as SQLite phrase identities. This is not byte-for-byte `snippet()` equivalence on arbitrary English, and Chinese hits may be overlapping bigrams.
2. **Every sentence is a candidate.** Original SQLite only tries the nearest preceding sentence start for each hit, only when the document exceeds the budget, and only when that start is strictly before the hit. It adds 120 at document start or 100 at another sentence start. This port first preserves that hit-then-preceding-sentence traversal and strict tie order, then enumerates every sentence start in document order (including a hit exactly at a sentence start). Sentence bonuses still apply only to longer-than-budget documents and windows containing at least one hit. Thus an empty sentence never wins by bonus alone and no-hit fallback retains score zero. Enumerating remaining sentences can intentionally choose a different winner than SQLite. Bonuses are not applied to centered hit candidates simply because their adjusted offset happens to be a sentence start.
3. **Multilingual deterministic boundaries.** Upstream recognizes the first token and tokens preceded by ASCII whitespace after `.` or `:`; it does not recognize Chinese punctuation and depends on tokenization. Here the first boundary is codepoint zero. ASCII `. : ! ?` require following whitespace (after optional closing quotes/brackets); Chinese `。！？：` do not. CR/LF create boundaries independently, including CRLF as one effective boundary. Closing characters `" ' ” ’ 」 』 ） ) ]` immediately following punctuation are skipped, then JavaScript Unicode whitespace is skipped. This includes quoted Chinese sentence endings without NLP, abbreviation handling, or language models. Leading opening quotes are retained as content. ASCII punctuation without following whitespace is not a sentence boundary.
4. **Rendering.** SQLite uses tokenizer byte spans and highlight callbacks to retain whole tokens and trailing punctuation. This port slices the chosen codepoint interval literally, which may cut an English word or whitespace. It emits only cut ellipses, no markup.

The direct scoring implementation is intentionally straightforward: each candidate scans caller instances. Its cost is quadratic in hit count plus sentence-count × hit-count, appropriate to this bounded-snippet benchmark; it does not introduce an index or production optimization.

## Verification fixtures

`test/fts5-snippet.test.mjs` contains six real in-memory `node:sqlite` FTS5 `tokenize="ascii"` comparisons with single-term or explicit OR queries. Three-letter words let selected three-token windows correspond to eleven-codepoint windows in these fixtures. Each test asserts SQLite's exact snippet, the port's exact window start, and the port's exact snippet—not merely term coverage. Cases cover the opening match, first-sentence preference, interior centering, end clamp, distinct-term dominance, and repeated-term density. Equal-width fixtures are an explicit controlled mapping, not evidence that token/codepoint budgets generally agree.

A seventh real SQLite comparison uses variable-length English words: SQLite's three-token result includes `extraordinarilylongidentifier gamma delta`, while a fourteen-codepoint port window still contains `gamma` but intentionally cuts a different span. This explicitly checks the declared unit difference rather than forcing token equivalence.

Additional deterministic fixtures cover Chinese answer/sentence selection, overlapping bigram identities, surrogate pairs, all adapted punctuation, quotes and newlines, no hits, empty/short input, first sentence bonus, strict ties, half-open bounds, stable input ordering, overlapping extent behavior, and C-style negative adjustment without score recomputation. SQLite's import warning is not suppressed. Run through the parent task's final verification; this implementation slice does not execute tests mid-flight.

## Saved-run comparison

`benchmark/compare-snippets.mjs` reads explicitly supplied saved group-2 runs, snapshots, reference answers and tokenizers. It never constructs either prototype index or calls a model. Every automatic top-five id and every returned recall id becomes a paired comparison row, using the recorded automatic question or execute query and exactly the same projected original text. Repeated exposures remain samples; they are not independent questions. No returned id is dropped for lack of exact hits. The span reconstruction is checked against both prototypes' exported tokenizers on every document.

The old adapters are not one common forward selector: SQLite uses the earliest production-lex substring with 40 codepoints of left context and ellipses; MiniSearch uses the first query-order, case-sensitive whitespace term, then 120 codepoints with no ellipses. Their actual read-only snippet functions are isolated and timed. The production method calls `locatorWindow` verbatim with a prebuilt candidate; DF is computed over the same full corpus and prototype tokens. Thus this isolates window selection, not the historical production query/DF pipeline. The FTS5 method calls the public `fts5Snippet`. Two warmups and 20 repeated native string-returning calls per exposed row are used; corpus parsing, hit extraction, DF construction and comparison-range bookkeeping are outside timings. Microsecond means are descriptive single-process results, not tail latency or index costs. Cutting LOC excludes blank/comment-only lines and external lexer/DF preparation.

MiniSearch id/score traces omit expanded prefix/fuzzy terms. This comparison conservatively keeps exact indexed-token matches only; it does not invent expansion positions. Raw MiniSearch whitespace/Query-JSON leaves are distinguished from automatically tokenized questions. SQLite raw MATCH operators are excluded from term identities; phrase words score separately, without reconstructing Boolean/NEAR instance constraints. The saved input has no SQLite prefix expressions or MiniSearch Query-JSON calls. These limitations affect hit-coverage interpretation, not the replayed old snippet text.

Answer positions are selected mechanically **before comparing windows**: enumerate every contiguous reference-answer phrase of 2–12 words, longest first, plus complete one-word answers; exclude stopword-only phrases; match case-insensitively over letter/number words, ignoring punctuation; keep all occurrences and discard contained shorter spans. No numeric conversion, synonyms or semantic inference is applied. The sole fixed addition requested by the task is `two months ago` for `982b5123`. All English gold entries are inventoried, including those with no literal reference phrase. Only positions in exposed gold rows enter the paired coverage rate; coverage requires the whole span inside the window. Some anchors are partial reference phrases, not proof that a complete answer is visible or correct. The complete sample inventory is saved for audit.

The mandatory `982b5123:00000553` example is the largest start-distance exposure for that English id. The other four examples are the largest start-distance exposures with distinct entry ids, without selecting for gold status or FTS5 success. This rule deliberately includes irrelevant retrieved text as well as evidence. Report window-disagreement rates compare start/end ranges, not ellipsis formatting.

The authoritative measured output is `runs/snippet-compare/final/` under the explicitly authorized external task directory. The root-level initial report timed the comparison wrappers too; it is a diagnostic run and is not used for the final timing table. `final/report.json` retains command, runtime, source/input hashes, full coverage distributions and per-run/language summaries; `rows.jsonl`, `answer-position-samples.json` and `comparison.md` retain all paired windows, answer anchors and examples. No archived input report, label or provenance is changed.

## Fixed-sample no-sentence-bonus comparison (S4-0B)

Run the same command with `--baseline /absolute/path/to/snippet-compare/final --no-sentence-bonus --output /absolute/path/to/snippet-compare/no-sentence-bonus`. The runner adds `fts5NoBonus` as a fourth method, remeasures all four native snippet functions, and reports zero-start counts/ratios. It loads the **existing** answer-position inventory instead of deriving new positions, requires exactly the same 3,605 exposures, and checks each query/id/channel/call/rank, original length, hit counts, old three windows and answer spans against prior rows. It also checks saved run input hashes. A mismatch fails before any report is written. Prior output files remain read-only.

`pairwise.productionOnly` and `pairwise.noBonusOnly` count exposed English gold rows containing at least one fixed answer span covered by one method but not the other. `uniqueEntryCount` deduplicates by question/entry id across runs and queries; a single entry can appear in both directions under different queries/spans. `exposureCount` retains each run/channel/call exposure. `exclusiveExposureCount` additionally requires the losing method to cover no other answer span on that exposure. Examples are the first at most three distinct entries in saved input order, not selected for largest gain. These are literal answer-position differences, not question-correctness scores. The required `982b5123:00000553` example reuses the original report's exact exposure.


