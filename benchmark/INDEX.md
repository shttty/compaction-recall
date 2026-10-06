# Benchmark entrypoints

Production retrieval lives only in `src/`. This directory owns the maintained runners, shared support and offline checks; it imports no sibling worktree. Old JS/index/strategy experiments and their projected historical metrics are in [archive/](../archive/), not production options.

## Inputs, sources and frozen metrics

[Release provenance](data/release-0.1.0/INDEX.md) separates upstream sources, processing, fixed inputs and replay requirements. [manifest](data/release-0.1.0/manifest.json) binds seven runs, 96 completed cases, strict/1–10 scores, judge errors and separate human review. The 16 authorized frozen Chinese LME questions are in `data/release-0.1.0/lme16/zh/`; original English/SWE questions, references, answers, retrieved excerpts and full histories remain external.

LME originals can be extracted by fixed ID from externally obtained original M data. Exact translated histories, revised references, locally authored SWE questions, native snapshots and frozen outputs require matching external artifacts. Their metadata cannot regenerate the original answers. Historical source hashes remain historical; current file hashes describe this repository-owned closure.

## Current commands

All paths below are caller-selected. `CONFIG` is an external JSON with explicit SDK/helper/data/output/candidate paths, model/provider/effort, protocol and isolated credential resources. Use this tree's `benchmark/lme-helper.py` and `node_modules/@earendil-works/pi-coding-agent` for current support, not a sibling checkout. For exact older inputs, unpack the matching candidate package into `CANDIDATE_ROOT` and rebind pins/config to that artifact; a removed worktree path is never a prerequisite. Rebinding changes run identity: do not resume a historical run under a new fingerprint.

```sh
# Offline helpers: no provider requests.
PYTHONDONTWRITEBYTECODE=1 python3 benchmark/evaluate.py --help
PYTHONDONTWRITEBYTECODE=1 python3 benchmark/evaluate.py prepare --set both --config "$CONFIG"
node benchmark/coding-recall/e2e/lme-zh-smoke.mjs "$CANDIDATE_ROOT" "$NEW_SMOKE_OUT"

# LME native-snapshot flow. Execution requires separate model-run authorization.
PYTHONDONTWRITEBYTECODE=1 python3 benchmark/coding-recall/e2e/lme-zh-run.py \
  --config "$CONFIG" --luna-config "$LUNA_CONFIG" --sol-config "$SOL_CONFIG" \
  --data-root "$DATA_ROOT" --candidate "$CANDIDATE" --pins "$PINS" --preflight "$PREFLIGHT" \
  --commit "$COMMIT" --archive-sha256 "$ARCHIVE_SHA256" --task "$TASK_ID" \
  --snapshot-source "$SNAPSHOT_SOURCE" --output "$NEW_OUT/lme16" \
  --language en --arm pi-restored-grep --han-phrase-trial jieba --workers 8 --stage flow

# Eight locally derived SWE cases: supply the complete external frozen bundle.
PYTHONDONTWRITEBYTECODE=1 python3 benchmark/coding-recall/e2e/run-swechat.py \
  --config "$SWE_CONFIG" --luna-config "$LUNA_CONFIG" --sol-config "$SOL_CONFIG" \
  --data-root "$SWE_DATA_ROOT" --candidate-root "$CANDIDATE_ROOT" \
  --tool-definition-manifest "$TOOL_DEFINITION_MANIFEST" \
  --commit "$COMMIT" --task "$TASK_ID" --output "$NEW_OUT/swe-chat8"
```

The existing model flow requires one shared `MemoryMax=14G`, `MemorySwapMax=0` cgroup and at most eight RPC sessions. Missing required external input paths fail before runtime/cgroup startup. No new downloader, runner platform, path shim or runtime copy was added.

Current English comparisons use `--arm pi-native`, `--arm pi-lite` or `--arm pi-full` with the same frozen native snapshot source, an immutable complete candidate archive whose entry is `src/index.ts`, and `--workers 8`. Native loads no extension; lite/full load the real production entry with an isolated formal mode file. The three existing per-arm flows run sequentially in one shared outer scope, not three eight-session pools. `--english-answer-soft-estimate` leaves provider request budgets unchanged and makes chars/4 diagnostic-only; capacity rejection stops new scheduling without retrying the rejection. Historical arm names retain their historical meanings.

Before authorized model calls, `node benchmark/coding-recall/e2e/lme-zh-smoke.mjs --three-arms "$CANDIDATE_ROOT" "$NEW_SMOKE_OUT"` checks real SDK dispatch, 0/2/3 tools, automatic locators only in full, and native production tool execution with synthetic profiles and blocked networking. Observers save serialized tools, current-entry registration/hash, automatic context, model/effort and private provider JSON bodies outside the repository; they never record credential headers.

[Retrieval contract](methods/RETRIEVAL_CONTRACT.md) documents `retrieval-group1.mjs`, `retrieval-group2.py`, `retrieval-session.mjs` and their external data/gold/engine/config/output inputs. Original strategy comparison engines are explicitly under `archive/prototype/` and `archive/benchmark/`; their algorithms are not adopted by production. Shared score accounting counts either explicitly false structured-input or legacy-query comparison as a mismatch, without double-counting a call.

## Verification

```sh
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

Tests use synthetic data, isolated temporary profiles and mocked provider boundaries; the production SDK/worker smoke blocks fetch. Passing offline checks does not establish model accuracy. Benchmark, tests, archive and full inputs are excluded from npm.

Native concept/fallback reports validate the recorded eight-session, 14-GiB, no-swap policy before accepting completion. The migrated regression exposed a missing concept-arm guard; it now shares the existing fallback check. Frozen results were not regenerated or rescored.
