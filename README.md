# pi-context-recall

[English](README.md) | [简体中文](README.zh-CN.md)

A lexical recall extension for Pi's native compacted conversation history.
**Automatic locator → `history_recall` → `history_expand` → `history_grep` when evidence is still missing.**
It reads the current branch, without taking over compaction or adding a database, background work, or model calls.

## Install or try

Requires **Node.js 24+** and Pi; verified against Pi SDK **1.0.0**. The host supplies the Pi SDK and TypeBox.

Install as a Pi package (updates Pi settings):

```sh
pi install npm:pi-context-recall
```

Try for one invocation without permanently writing the package into settings (Pi may download/cache it):

```sh
pi -e npm:pi-context-recall
```

From a source checkout, try the local entry instead:

```sh
pi -e ./src/index.ts
```

Load only one copy. The package entry is `src/index.ts`; no root-level extension shim is required.
These are usage instructions, not a claim that version 0.1.0 has been published.

## How it works

1. After native compaction, the `context` hook uses the latest actual user text to produce a small, relevance-ranked locator hint.
2. The model can call `history_recall` with focused or rewritten keywords to find entry IDs.
3. `history_expand` reads the branch-effective text for an ID to verify exact details. Useful automatic IDs can be expanded directly.
4. If evidence remains insufficient, `history_grep` supplies a regex fallback over the same searchable history.

The extension neither forces tool calls nor decides that evidence is sufficient. Snippets are leads, not verified answers.
Automatic hints include at most five candidates and fit within **1,500 Unicode code points**, including metadata.
They are inserted after the latest user message for that request only: not persisted to the session or accumulated across requests.
Although hidden in the UI, hints are sent to the configured model service as part of its ordinary request.
Historical text is marked as untrusted data and escaped; this does not eliminate prompt-injection risk.

### Tool examples

These are model-facing tool calls, not shell commands. Use an actual returned ID in place of `ENTRY_ID`.

```js
history_recall({ query: "bicycle repair", limit: 10 })
history_expand({ id: "ENTRY_ID", before: 1, after: 1 })
history_grep({ pattern: "bicycle|repair", limit: 10 })
```

When `hasMore` is true, pass the returned `nextOffset` as `offset`, keeping the query/pattern or ID and neighbor settings unchanged.
Do not calculate `offset + limit`: output budgets can shorten pages. Restart at offset 0 after branch, edit, or compaction-boundary changes.

| Tool | Search / output contract |
| --- | --- |
| `history_recall` | Ranked, deduplicated IDs, entry dates, roles and snippets; default/max 50 results. `total` counts deduplicated hits. Pages target 16,000 code points; an oversized metadata row is returned alone with `budgetExceeded: true` rather than losing its ID. |
| `history_expand` | Requested entry first; neighbors default to 2 before/after, each configurable from 0–20. Up to 16,000 code points per response. `offset`, `total`, `returned`, `nextOffset`, `hasMore` describe the requested entry's text, not neighbor count. Whole neighbors fit only after the target page is complete. |
| `history_grep` | Case-insensitive JavaScript `gi` regex, invalid regex falls back to a literal. Branch-order pagination over matching entries: default 30, max 50. At most 30 snippet lines, 3 per entry, and 16,000 code points per response; snippets may clip matches. |

Pagination is visible in both tool text and structured `details`. Budgets count Unicode code points, **not tokens**.
For grep, `total` counts raw regex matches, `totalEntries` counts matching entries, and `returned` counts entries consumed, including explicitly skipped oversized metadata.
`covered` counts other raw matches fully visible in this response's snippets; `omitted` counts all raw matches not shown in this response, including other pages—not unread matches tracked across calls.
Grep is not SQL LIKE and has no regex execution timeout; avoid high-backtracking expressions.

## Scope and limits

- **Current branch, compacted history only.** The latest compaction's original `firstKeptEntryId` bounds the hidden segment. No compaction means no history to recall. If the boundary ID is absent, messages before the latest compaction are used.
- No cross-session, `parentSession`, abandoned-branch, current retained-context, or compaction-summary search.
- Automatic lookup, recall and grep search user/assistant text and assistant tool-call names and input arguments. They **do not search `toolResult` bodies**, thinking, images or custom messages.
- Expand can read an available `toolResult`'s text by ID, but still excludes thinking and images. It cannot recover content Pi has deleted or omitted.
- All paths honor normalized branch-local `context_edit` messages: the latest edit wins, `replacement: null` hides an entry, and replacements hide original content. String/text-block replacements are supported, with assistant/tool-result strings normalized to Pi 1.0 text blocks. Expansion and its neighbors use this same view; “original text” never means bypassing edits.
- This is **lexical, not semantic retrieval**. Queries use up to 4,000 code points and 24 distinct terms, with English identifier splitting and overlapping Chinese bigrams. Synonyms, pronouns, single Chinese characters, spelling variants and image-only evidence may be missed. No hit does not prove absence.
- No database, embeddings, persistent index, production cache, background worker, compaction hook or additional model call. Each request scans branch edits and compacted text locally; large histories cost more local processing.

## Verification

The following are **observed offline checks**, not live inference or evidence of better answer accuracy:

| Surface | Observed result | Boundary |
| --- | --- | --- |
| TypeScript + Node | `npm run check`: typecheck and **99 Node tests passed** | Includes 5 SDK checks: descriptors, guarded native RPC, read-only auth; package and both `src/` entries load in isolation. |
| Python runner | **15 Python tests passed** | Two explicit synthetic configurations reach CLI → run → answer → RPC; covers three arms, zero-call resume, changed-config rejection and guarded real SDK `get_state` startup for all arms. No live model calls. |
| Clean-copy reproduction | Locked `npm ci --ignore-scripts` installation, then **99 Node + 15 Python tests passed** | Source-only temporary copy; no original `node_modules`, Git history, external helper, profile or dataset copied. |
| npm artifact | Dry-run and actual tarball: **11 allowlisted files**, no bundled dependencies; existing SDK loading case passed | Package manifest and both `src/` entries resolve in isolation; context hook and all three tools execute. Raw benchmark evidence, tests and personal configuration are excluded. This is local packaging verification, not npm publication. |

To repeat development checks from a checkout (Python 3 and Git are also required):

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

Dependency installation needs network access or an npm cache. Tests use isolated synthetic fixtures, not your personal profile or credentials.
Benchmarking requires separate authorization and an explicit external configuration; historical model IDs below are evidence, not runtime defaults.

## Historical benchmark observations

These are archived single-run **LongMemEval_M** results, **not a fresh benchmark of 0.1.0**.
Each DEV8/HARD8 set has 8 histories; every cell is correct answers out of 8, in **native / grep / production** order.
“Production” names the historical experimental arm, not a claim that its commit equals this release.
The native baseline has no tools/extensions; grep uses a pinned grep/expand wrapper with the context hook suppressed; production loads the public entry with automatic locators and recall/grep/expand.

| Set / run | Answer model / effort | Candidate commit | Native / grep / production |
| --- | --- | --- | --- |
| DEV8 capacity-base | `clp/gpt-6-luna` / high | A | 0 / 5 / 7 |
| DEV8 capacity-paging | `clp/gpt-6-luna` / high | B | 0 / 6 / 8 |
| DEV8 coverage | `clp/gpt-6-luna` / high | C | 0 / 4 / 7 |
| DEV8 grep-pages | `clp/gpt-6-luna` / high | D | 0 / 3 / 8 |
| HARD8 base | `clp/gpt-6-luna` / high | A | 1 / 1 / 3 |
| HARD8 paging | `clp/gpt-6-luna` / high | B | 0 / 1 / 2 |
| HARD8 grep-pages | `clp/gpt-6-luna` / high | D | 0 / 1 / 3 |
| HARD8 sol-high-d4259198 | `clp/gpt-6.1-sol` / high | D | 1 / 6 / 6 |

Historical base A: `f5715d1901b6bedf19811030f18f3733eefb7bc4`; paging B: `7d1980b8b7512ec8568c3ddaaecdccb8e0ad4014`; coverage C: `5acf40efa9cb33146d3e9526fc411a769511cee8`; grep-pages D: `8149e1f6caece71de148c92a88790e5d35212d9e`.
All eight groups used SDK 1.0.0 and `clp/gpt-6-luna` / high compression. These small, single-round observations do not establish causality or general accuracy; candidates were answered in separate rounds, and HARD8 paging regressed relative to base.

Frozen manifests record judge `clp/gpt-6-luna` with **requested xhigh**. Historical grading calls the external helper, not Pi SDK; the retained evidence does not establish provider-effective judge effort, so no SDK clamp to high is asserted.
A separate, unscored SDK 1.0.0 preparation probe requested Sol **xhigh** but a loopback mock captured serialized **high**, with zero live calls. That clamp is not a scored xhigh run; the formal Sol row explicitly used high. The linked aggregate identifies the proof by hash.

See the packaged [benchmark results and provenance](doc/BENCHMARK_RESULTS.md) for arm identities, runner commits, judging configuration, failures and excluded pilots.
The [source benchmark index](https://github.com/shttty/pi-context-recall/blob/main/doc/BENCHMARK.md) and raw evidence are in the **private** GitHub repository and require access; they are not publicly accessible evidence links.

## License and source

**MIT — Copyright (c) 2026 shttty.** See [LICENSE](LICENSE).
Extracted from the recall experiments in `pi-lossless-context`; third-party design attribution and license text are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Detailed source-only [plugin documentation](https://github.com/shttty/pi-context-recall/blob/main/doc/PLUGIN.md) and [evaluation protocol](https://github.com/shttty/pi-context-recall/blob/main/doc/EVALUATION.md) require repository access.
