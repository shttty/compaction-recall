# How to run the benchmark

[English](benchmark.md) | [简体中文](benchmark.zh-CN.md)

[Project overview](../README.md) | [Configuration and behavior reference](PLUGIN.md)

Use `benchmark/run.py` to compare Pi native / lite / full on the fixed English LME16 set and run recall questions derived from SWE-chat. The current LME dataset is `LME16-English`. `runner/` prepares, schedules, and persists runs; `judging/` defines and executes scoring; `sdk/` runs the actual Pi SDK and observes evidence. The benchmark ships with the source, not in the npm package.

Offline tests verify only the product and its wiring. Real answers and scoring require separate authorization and incur model fees. The run examples below do not authorize model calls.

## 1. Environment and offline checks

Node.js >=24.18.0, Python 3, and the project's locked dependencies are required. Real runs require Linux cgroup v2, systemd user services, and one shared execution scope with 14 GiB of memory and zero swap.

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
python3 benchmark/run.py --help
python3 benchmark/report.py --help
```

The real SDK / worker check uses an isolated synthetic profile and blocks network access without calling real models. Its output must be a nonexistent external directory:

```sh
node benchmark/smoke.mjs \
  --three-arms "$CANDIDATE_ROOT" "$NEW_SMOKE_OUT"
```

`CANDIDATE_ROOT` is a source directory containing `src/index.ts`, package metadata, and installed locked dependencies. The check loads the actual entry point and executes real tools to verify the 0/2/3 tool sets and automatic hints only in full mode.

## 2. Supply inputs

LME16 uses the fixed DEV8 and HARD8 subsets of [LongMemEval_M](https://huggingface.co/datasets/xiaowu0162/longmemeval), with eight questions each; it is neither the full LongMemEval dataset nor a new random sample. See [input materials](../benchmark/data/release-0.1.0/INDEX.md) for provenance and frozen question IDs. Public metadata and Chinese question text cannot reconstruct the original text, references, or native snapshots stored outside the repository.

| Caller input | Purpose |
|---|---|
| `--config` | One model configuration without credentials, containing the answer model, two judges, profile paths, and an optional budget. |
| `--data-root` | External question sets, reference answers, and their source materials. |
| `--snapshot-source` | A directory from a complete English native run for LME16, containing `manifest.json` and per-question native snapshot references. SWE can use snapshot bindings directly from its question set. |
| `--output` | A new external result directory, or an existing result directory with exactly matching identity for recovery. |
| `--source-root` | The directory containing the source under test and its locked dependencies; defaults to the current repository when omitted. |

The LME question set retains `question.json`, `corpus.json`, `answer.json`, and `judge.json` under `data/dev8/<id>/` and `data/hard8/<id>/`. Snapshots reuse existing native compaction; no new compaction is added. SWE uses external `freeze.json`, `questions.json`, and `gold.json`, with actual snapshot paths and hashes bound to its questions. These questions are derived from local SWE-chat sessions, not ready-made upstream QA.

The runner's preparation stage generates and freezes candidate and input bindings from the actual source and locked dependencies, questions and references, model configuration, and existing snapshots. Do not supply `CANDIDATE`, `PINS`, `PREFLIGHT`, two judge configurations, or manual archive / commit hashes. The runner operates independently of historical Chinese preflight. Original frozen materials and historical metrics retain their original values; new code must not rewrite old fingerprints.

An explicit source directory supplies the actual bytes under test. A Git commit is provenance only; uncommitted runtime code must not be presented as bytes from that commit. Preparation freezes a copy and hashes, and subsequent stages verify the same identity. All three modes share one candidate freeze and the same questions / references / snapshots; gold answers go only to judges and are not mixed into answer requests.

## 3. One model configuration

For example, an external `models.json`:

```json
{
  "answer": { "provider": "your-provider", "model": "your-answer-model", "effort": "high" },
  "judges": {
    "luna": { "provider": "your-provider", "model": "your-first-judge", "effort": "xhigh" },
    "sol": { "provider": "your-provider", "model": "your-second-judge", "effort": "medium" }
  },
  "profiles": {
    "answer": "/absolute/benchmark-profile",
    "luna": "/absolute/benchmark-profile",
    "sol": "/absolute/benchmark-profile"
  },
  "protocol": { "reserve_tokens": 16384, "overhead_tokens": 4096 },
  "system_prompt": "You are a helpful assistant."
}
```

All models, providers, and effort settings must be explicit. `luna` / `sol` are role names for two independent judges, not fixed model defaults. Profiles may point to the same dedicated evaluation directory; prepare model / credential files readable by the SDK in advance. The configuration stores only paths, not copies of credentials. The SDK validates the actual model / effort, does not select implicit personal defaults, and does not clamp unsupported effort settings.

## 4. Preparation and execution

Preparation deterministically generates and checks manifests for source and dependencies, questions and references, model configuration, and snapshots. It does not open profiles or start the SDK or a provider:

```sh
python3 benchmark/run.py \
  --config "$CONFIG" --data-root "$DATA_ROOT" \
  --snapshot-source "$SNAPSHOT_SOURCE" --output "$OUT" \
  --arm all --stage prepare
```

Keep the same inputs and output directory and change only the stage. The runner executes the three modes sequentially.

`pilot` / `all` / `flow` first run a recoverable serialization preflight through the actual SDK within the shared resource scope, stopping before network transmission. Answer requests are sent only after it passes. The isolated three-arm smoke check in section 1 can also verify production wiring beforehand.

```sh
systemd-run --user --scope \
  -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py \
    --config "$CONFIG" --data-root "$DATA_ROOT" \
    --snapshot-source "$SNAPSHOT_SOURCE" --output "$OUT" \
    --arm all --workers 8 --stage flow
```

| Option | Meaning |
|---|---|
| `--arm pi-native` | No extension, history-retrieval tools, or automatic locators. |
| `--arm pi-lite` | The production entry point with production mode=lite, grep/expand, and no automatic hints. |
| `--arm pi-full` | The production entry point with production mode=full and product defaults. Only full runs by default. |
| `--arm all` | Runs the three modes sequentially in one shared scope, with at most eight in-flight sessions globally. |
| `--stage prepare` | Freezes input / candidate and model identities; does not open profiles or call the SDK / provider. |
| `--stage pilot` | The first question in each arm and two strict judges; that question counts toward the question set, without a separate answer run. |
| `--stage all` | Reuses the first question and completes answers and strict scoring. |
| `--stage flow` | Also performs independent 1 to 10 scoring and reporting on the same answers; does not replace strict scoring. |

The frozen `benchmark/grep-only-adapter.mjs` is historical evidence, not current lite; the current CLI does not load it.

At most eight sessions may run concurrently; `--workers` accepts 1 to 8. The runner checks resource boundaries. On an actual provider capacity rejection, it stops new scheduling and does not retry that rejection. Character estimates are diagnostic only. Bounded ordinary provider retries retain evidence for each attempt; unknown in-flight state prevents replay.

SWE uses the same entry point and orchestration:

```sh
systemd-run --user --scope \
  -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py \
    --dataset SWE-chat --config "$CONFIG" --data-root "$SWE_DATA_ROOT" \
    --output "$SWE_OUT" --arm pi-full --stage flow
```

## 5. Reports, failures, and recovery

Completed answers and both sets of raw scoring results are persisted; strict and 1 to 10 scoring are independent. Errors, missing answers, and scoring failures are not wrong answers or zero scores. Manual review is listed separately and does not overwrite machine scoring; historical peaks must not be presented as results of the current run.

`completed` includes only questions with a successful answer and two successful strict judgments. The independent 1 to 10 stage likewise requires successful results from both judges. The state is `complete` only when all selected questions are complete; some successful questions yield `partial`, and no successfully completed questions yield `failed`. These failure terminal states make the CLI exit nonzero. If answers / strict scoring fail, `flow` only saves a report and does not proceed to 1 to 10 requests. If 1 to 10 scoring fails, the overall report shows that stage's failure terminal state and lists `answerStrictState` separately.

Each judge and subset report explicitly states `selected / scored / failed / pending`. Accuracy and mean scores use only scored records; for example, `1/1` with `selected=16, scored=1, failed=15` does not mean a perfect score across 16 questions.

With `--arm all`, each arm's results are in its corresponding arm directory under the output directory; a single arm uses the specified output directly. `manifest.json` stores frozen identity and terminal state. Results, attempts, and sessions are bound by content hashes, and reports read only existing artifacts. To generate an offline report separately:

```sh
python3 benchmark/report.py --run "$ARM_OUT"
```

Recovery uses the same entry point, configuration, questions, source, snapshots, and output directory. Completed stages are reused without repeating model calls. Changed identity, unknown in-flight markers, or missing or tampered completion evidence cause recovery to be refused. Do not delete the ledger or modify an old manifest to force replay; start a new run when inputs or code change.

Reusing any answer / judge result requires a completion receipt with matching identity, `state=complete`, and result hash, along with an unchanged session hash. Missing receipts, inflight state, or identity / hash drift explicitly prevent recovery. The presence of a result file does not implicitly trigger provider replay.

A capacity rejection preserves `capacity-blocked` and evidence for completed / failed / not-started stages; incomplete results missing judgments are not added to completed. Re-entering this terminal state in the same directory only verifies evidence and rewrites reports: it does not resend completed or capacity-rejected requests or start new provider requests. New calls require a new run; do not delete receipts or overwrite old artifacts.

Accepted non-text metrics for the current version's three arms are in `benchmark/data/lme16-current-three-arms-20261006.json`.

Original questions / references / answers / judge rationales / excerpts / sessions / actual wire data stay in external private directories; only necessary metrics and provenance hashes are published. Code paths, CLI commands, and metrics in historical materials remain bound to their recorded commits, not the current executable entry point. Moving files or migrating configuration does not relabel historical results or replay historical runs.

## 6. Performance and timing

See the [configuration and behavior reference](PLUGIN.md) to enable timing. Compare no plugin, a cold index, and a warm index using the same corpus, branch, query, and environment; model answer accuracy is not a performance metric. Retain actual index wait, worker build / query, context, and tool-call phases. A parallel simulation benchmark framework for the old JS index / prototype strategies is no longer maintained.

Phase durations may be nested, so parent and child phases must not be added together. RSS includes process and native memory; it is neither the plugin's net overhead nor a quantity for which main / worker RSS should be added together. Answer wall time is not provider TTFT. Token statistics distinguish input, output, and cache; unknown metrics remain unknown.
