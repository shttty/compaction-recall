# compaction-recall

[English](README.md) | [简体中文](README.zh-CN.md)

When Pi compacts a long conversation, summaries can lose names, numbers and exact wording. compaction-recall lets the model search the original messages removed from the current branch and expand the evidence.

**0.1.0 is prepared locally; this preparation does not publish an npm package or a release tag.** The default `full` mode uses SQLite FTS5 **in memory**, inside a native Node worker. It does not replace Pi compaction, persist an index, create database/WAL/SHM files, or make extra model calls. `lite` keeps only regex grep and expansion, without a worker or automatic hints.

## Requirements and local use

Requires **Node.js >=24.18.0** and Pi SDK **1.0.0** (the checked host version). The host supplies the Pi SDK and `typebox` as peers. The only production npm dependency is `@node-rs/jieba`; it loads only in the worker.

For a checkout, install its locked dependencies, then try one entry without changing your Pi profile:

```sh
npm ci --ignore-scripts
pi -e ./src/index.ts
```

A local package can also be loaded with `pi -e /absolute/path/to/compaction-recall`. Local directories do not have their dependencies installed by Pi; install them first. Pi-managed npm/git packages install their declared dependencies. `pi install` modifies settings, so it is not performed by this release preparation. Do not register `src/index.ts` and the alternate `src/recall-extension.ts` together.

## Tools and configuration

After compaction, `full` supplies short lexical locations before each answer. The model decides whether more evidence is needed:

- `history_recall({concepts, match?, exclude?, limit?, offset?})`: 1–5 concept groups, each with 1–4 alternative literal surfaces. `any` (default) ORs groups; `all` requires every group in the same record. Analyzed terms within a surface require co-occurrence, not phrase order. For example: `{"concepts":[["bicycle","bike"],["repair","service"]],"match":"all"}`.
- `history_expand({id, before?, after?, offset?})`: read and page through the branch-effective original text.
- `history_grep({pattern, limit?, offset?})`: independent JavaScript regex search when evidence is insufficient. Recall never silently switches to literal scanning or grep.

FTS decides candidates. The measured production strategy is English Porter plus raw Han bigrams. Worker-default jieba adds only a SQL ranking signal: distinct positive all-Han surfaces of at least three characters found in the existing dictionary-word table, then BM25 and stable time/recency/rowid ties, **before pagination**. Exclusions never add points. Automatic query terms stay unchanged; with the measured raw-bigram analyzer they generally have no Chinese long-surface bonus. No semantic/synonym expansion is implied.

Partial token loss continues the analyzed FTS search and returns a short warning; a zero-token surface retains the compiler error. Normal zero hits remain zero. Recall pages default to at most 50 entries and target 16,000 Unicode codepoints; use the returned `nextOffset`, not a guessed offset.

Optional agent-wide `<agent-dir>/extensions/compaction-recall.json` (default agent directory `~/.pi/agent`):

```json
{
  "mode": "full",
  "jieba": true,
  "autoGate": 280,
  "snippetBudget": 240,
  "recallTimeoutMs": 5000,
  "trace": false,
  "preindex": { "userCycles": 10, "toolRounds": 10 }
}
```

Han codepoints weigh 2, other codepoints 1 for the automatic gate and snippet budget. The automatic gate skips overlong questions; manual recall is not subject to that gate. The deadline is cooperative: native MATCH cannot be interrupted, but late results are discarded without clearing healthy worker caches.

```sh
COMPACTION_RECALL_MODE=lite pi -e ./src/index.ts
COMPACTION_RECALL_JIEBA=off pi -e ./src/index.ts
```

Environment overrides use `COMPACTION_RECALL_AUTO_GATE`, `COMPACTION_RECALL_SNIPPET_BUDGET`, `COMPACTION_RECALL_QUERY_TIMEOUT_MS` and the existing preindex variables. Configuration is read once at extension load; reload after changes. `PI_CODING_AGENT_DIR` selects the agent directory, not cwd or an SDK `agentDir` option. Production does not read old SQLite trial/arm variables. Full details are in the repository's [PLUGIN guide](https://github.com/shttty/pi-context-recall/blob/main/doc/PLUGIN.md).

## Scope and privacy

Only compacted user/assistant text and assistant tool-call names/arguments on the **current branch** are searched. Thinking, images, tool-result bodies and compaction summaries are excluded; readable tool results can still be expanded by id. Latest context edits apply: omitted entries disappear and replacements hide original text. Nothing searches other sessions or abandoned branches.

Hints and tool results can be sent to your model provider. `lite` injects no hidden hints, but it is not a guarantee that history never reaches the provider. No hit proves absence. Worker failures surface as errors rather than changing retrieval algorithms; shutdown waits for the worker. Optional timing writes only to an explicitly selected file. File-only `trace: true` records content-bearing structured inputs and requires private handling.

## Frozen evaluation and historical performance

The [0.1 benchmark index](https://github.com/shttty/pi-context-recall/tree/main/benchmark/archive/release-0.1.0) publishes sources, processing, fixed-input hashes, runner code and non-text metrics, plus the **16 frozen Chinese question translations** explicitly retained by the user. English originals, references, answers, judgment reasons and retrieved excerpts stay external. Upstream IDs reconstruct original LME questions; exact translated histories, revised references, locally derived SWE questions and frozen outputs require matching external artifacts. Sources alone cannot reproduce 96 frozen answers. SWE's latest machine strict result stays **7/8**, with sw08 human acceptance separate. Benchmark materials are excluded from npm.

Older JS implementation results are retained in [BENCHMARK_RESULTS](doc/BENCHMARK_RESULTS.md); older memory/latency tables remain in the repository's [PERFORMANCE notes](https://github.com/shttty/pi-context-recall/blob/main/archive/doc/PERFORMANCE.md). They are **historical, not measurements of this SQLite release**, and must not be used as current production memory/latency guarantees. Small single-run scores do not establish stable accuracy. The old JS runtime and original documentation remain archived in git, not in the package.

## Development

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

Checks use offline synthetic fixtures and isolated agent directories. Real evaluation requires an explicit external configuration and separate authorization.

## License

MIT. Dataset/software attribution and the SWE-chat database/content-rights distinction are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Benchmark materials are git-only; full histories, credentials, profiles and provider wire are not bundled.
