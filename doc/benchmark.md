# How to run the benchmark

[English](benchmark.md) | [简体中文](benchmark.zh-CN.md)

[Project overview](../README.md) | [Configuration and behavior reference](PLUGIN.md)

Use `benchmark/run.py` to compare Pi native / lite / full and explicit third-party Pi packages on fixed `LME16-English` / `LME16-Chinese` questions, and to run recall questions derived from SWE-chat. `runner/` prepares, schedules, and persists runs; `judging/` defines and executes scoring; `sdk/` runs the actual Pi SDK and observes evidence. The benchmark ships with the source, not in the npm package.

Offline checks and `--stage prepare` / `--stage preflight` do not authorize paid work. Real answers and scoring require separate authorization and incur model fees. Package compression in this runner is always zero-model. The examples below are usage instructions, not authorization to call a model or network service; maintenance authorization alone does not authorize a benchmark run.

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
| `--snapshot-source` | Native-compression source with `manifest.json` and per-question snapshot references. English uses its native source; Chinese can use the genuine Pi native compression snapshots in historical `lme16-zh-rawfts`, whose answers were produced with an extension, not a no-plugin baseline. SWE can bind snapshots directly in its question set. |
| `--output` | A new external result directory, or an existing result directory with exactly matching identity for recovery. |
| `--source-root` | The directory containing the source under test and its locked dependencies; defaults to the current repository when omitted. |
| `--package-root` | An already installed third-party Pi package tree, including its `node_modules`; required with `--arm package`. |
| `--compression native\|package` | Package arm only: reuse native snapshots, or run the package's compression hooks over the source history at the frozen native cuts. |
| `--baseline-source` | Historical answer-run directory for exact prompt / reference binding; required for `LME16-Chinese`, optional for English. It is not a claim that the historical arm was native. |

The LME question set retains `question.json`, `corpus.json`, `answer.json`, and `judge.json` under `data/dev8/<id>/` and `data/hard8/<id>/`. Each split's `data/<split>/manifest.json` lists its question IDs in run order under `selected`; the runner reads the selection there and binds the manifest hash into the run identity, so changing questions means editing data, not code. Legacy arms and `--compression native` reuse existing native compaction. `--compression package` uses the original chronological history and the three verified native cuts; it does not invent new cuts. `LME16-Chinese` binds the historical 2026-10-06 Chinese prompts and references through `--baseline-source` while native snapshot provenance remains separate. SWE uses external `freeze.json`, `questions.json`, and `gold.json`, with actual snapshot paths and hashes bound to its questions. These questions are derived from local SWE-chat sessions, not ready-made upstream QA.

The runner's preparation stage generates and freezes candidate and input bindings from the actual source and locked dependencies, questions and references, model configuration, and existing snapshots. Do not supply `CANDIDATE`, `PINS`, `PREFLIGHT`, two judge configurations, or manual archive / commit hashes. Historical Chinese preflight is not reused as native snapshot evidence. Original frozen materials and historical metrics retain their original values; new code must not rewrite old fingerprints or write into an old run.

The Chinese historical rawfts source has real native compaction entries and cuts; historical simulated preflight does not. No Chinese no-plugin answer baseline is implied or supplied. `--baseline-source` separately binds the historical 2026-10-06 `zh-full` prompts / references; it must not relabel that run as native answers.

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

Generic package runs keep this same `answer` / `judges` configuration; there is no separate compression-model key. Compression uses the answer-model descriptor. The generated SDK configuration retains `sdk_path` from the frozen candidate, not from the third-party package's dependencies. Offline preflight blocks network access even when those descriptors are present.

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
| `--arm all` | Runs only the three legacy modes sequentially in one shared scope, with at most eight in-flight sessions globally. It never includes `package`. |
| `--arm package` | Loads a frozen installed package supplied by `--package-root`; no package name, tool count, or storage implementation is assumed. |
| `--stage prepare` | Freezes input / candidate / package and model identities; does not open profiles or call the SDK / provider. |
| `--stage preflight` | Offline prepare, package compression when selected, and real SDK serialization; stops before sending an answer or running a judge. |
| `--question-id ID` | Repeatable, for explicitly authorized offline subsets with `prepare` / `preflight` only; does not reduce the fixed paid question set. |
| `--stage pilot` | The first question in each arm and two strict judges; that question counts toward the question set, without a separate answer run. |
| `--stage all` | Reuses the first question and completes answers and strict scoring. |
| `--stage flow` | Also performs independent 1 to 10 scoring and reporting on the same answers; does not replace strict scoring. |

The frozen `benchmark/grep-only-adapter.mjs` is historical evidence, not current lite; the current CLI does not load it.

At most eight sessions may run concurrently; `--workers` accepts 1 to 8. The runner checks resource boundaries. On an actual provider capacity rejection, it stops new scheduling and does not retry that rejection. Character estimates are diagnostic only. Bounded ordinary provider retries retain evidence for each attempt; unknown in-flight state prevents replay.

### Generic installed Pi packages

Supply installed runtime dependencies before freezing: use `npm ci --omit=dev` when the package has a lockfile, otherwise `npm install --omit=dev` after unpacking. Installation can access the network and is separate from offline prepare / preflight; it requires its own authorization or already cached dependencies.

Preparation freezes the entire installed tree, including `node_modules`, under `OUT/package`, with read-only file bytes. The SDK loads only the package's declared `pi.extensions` and `pi.skills`, not guessed entry points or an ambient user profile. Registered tools are discovered dynamically; every registered descriptor is preserved in serialization, and answer resume must match frozen preflight evidence. Judges run without extensions.

Repeat `--package-root FIRST --package-root SECOND` to load both in command-line order: each tree is independently frozen and hashed under `OUT/packages/<index>`, the ordered identities are recorded, and compression / answer load the same complete tool and hook set without filtering.

Compression and answer share `OUT/homes/<question-id>` so package state survives resume. Serialization preflight uses a private clone under `OUT/serialization/<question-id>` and cannot mutate the question's persistent HOME. Compression evidence is saved independently in `OUT/compression/<question-id>/snapshot.json`, so an offline subset can have recorded compactions without any answers. SDK evidence includes `tools.json`, `sdk-registration.json`, compaction hooks / events, tool executions, and context / wire payload observations.

`--compression native` reuses frozen native snapshots. `--compression package` invokes the package over the source history at the same three native cuts and always requires zero-model compression, including paid answer stages: a package that tries to contact a provider fails explicitly, with no native or fake-summary fallback. Use `native` for packages whose compression needs a model.

One-command English offline preflight, reusing native compression (all variables name explicit external inputs; `QID_1` / `QID_2` are authorized frozen question IDs):

```sh
systemd-run --user --scope -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py --dataset LME16-English \
    --config "$CONFIG" --data-root "$EN_DATA_ROOT" \
    --snapshot-source "$EN_NATIVE_SOURCE" --package-root "$PACKAGE_ROOT" \
    --arm package --compression native --output "$NEW_EN_OUT" \
    --stage preflight --question-id "$QID_1" --question-id "$QID_2"
```

One-command Chinese offline preflight, exercising package compression and binding historical prompts / references:

```sh
systemd-run --user --scope -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py --dataset LME16-Chinese \
    --config "$CONFIG" --data-root "$ZH_DATA_ROOT" \
    --snapshot-source "$ZH_NATIVE_SOURCE" --baseline-source "$ZH_BASELINE_SOURCE" \
    --package-root "$PACKAGE_ROOT" --arm package --compression package \
    --output "$NEW_ZH_OUT" --stage preflight \
    --question-id "$QID_1" --question-id "$QID_2"
```

Use `--stage prepare` instead for freezing alone. Offline subset identity is not a full paid run: after explicit authorization, use a new output directory, omit `--question-id`, and keep all other full-run bindings explicit. The following English and Chinese commands perform package compression, answers, strict judging, and independent 1–10 judging; neither may be executed without that authorization. English includes optional exact baseline binding:

```sh
systemd-run --user --scope -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py --dataset LME16-English \
    --config "$CONFIG" --data-root "$EN_DATA_ROOT" \
    --snapshot-source "$EN_NATIVE_SOURCE" --baseline-source "$EN_BASELINE_SOURCE" \
    --package-root "$PACKAGE_ROOT" --arm package --compression package \
    --output "$NEW_AUTHORIZED_EN_OUT" --workers 8 --stage flow
```

```sh
systemd-run --user --scope -p MemoryMax=14G -p MemorySwapMax=0 \
  python3 benchmark/run.py --dataset LME16-Chinese \
    --config "$CONFIG" --data-root "$ZH_DATA_ROOT" \
    --snapshot-source "$ZH_NATIVE_SOURCE" --baseline-source "$ZH_BASELINE_SOURCE" \
    --package-root "$PACKAGE_ROOT" --arm package --compression package \
    --output "$NEW_AUTHORIZED_ZH_OUT" --workers 8 --stage flow
```


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

Package runs use the same single-arm layout. `aggregate.json` / `REPORT.md` include compaction seconds and `contextBefore.estimatedTokens` / `contextAfter.estimatedTokens` from each `compression/<question-id>/snapshot.json`, tool milliseconds from answer-attempt `tool-execution.jsonl`, and observed peak RSS from `process-memory.json`. Summaries show median / max / count, including per compression stage and tool; absent observations render as `未记录`, never zero. Estimates are not provider token usage. All recorded answer attempts contribute timings; a preflight-only run can report compression with pending answers and judges. Reports do not assume a package-specific database or invent missing baseline measurements.

Recovery uses the same entry point, configuration, questions, source, snapshots, and output directory. Completed stages are reused without repeating model calls. Changed identity, unknown in-flight markers, or missing or tampered completion evidence cause recovery to be refused. Do not delete the ledger or modify an old manifest to force replay; start a new run when inputs or code change.

Reusing any answer / judge result requires a completion receipt with matching identity, `state=complete`, and result hash, along with an unchanged session hash. Missing receipts, inflight state, or identity / hash drift explicitly prevent recovery. The presence of a result file does not implicitly trigger provider replay.

A capacity rejection preserves `capacity-blocked` and evidence for completed / failed / not-started stages; incomplete results missing judgments are not added to completed. Re-entering this terminal state in the same directory only verifies evidence and rewrites reports: it does not resend completed or capacity-rejected requests or start new provider requests. New calls require a new run; do not delete receipts or overwrite old artifacts.

Accepted non-text metrics for the current version's three arms are in `benchmark/data/lme16-current-three-arms-20261006.json`.

Original questions / references / answers / judge rationales / excerpts / sessions / actual wire data stay in external private directories; only necessary metrics and provenance hashes are published. Code paths, CLI commands, and metrics in historical materials remain bound to their recorded commits, not the current executable entry point. Moving files or migrating configuration does not relabel historical results or replay historical runs.

## 6. Performance and timing

See the [configuration and behavior reference](PLUGIN.md) to enable timing. Compare no plugin, a cold index, and a warm index using the same corpus, branch, query, and environment; model answer accuracy is not a performance metric. Retain actual index wait, worker build / query, context, and tool-call phases. A parallel simulation benchmark framework for the old JS index / prototype strategies is no longer maintained.

Phase durations may be nested, so parent and child phases must not be added together. RSS includes process and native memory; it is neither the plugin's net overhead nor a quantity for which main / worker RSS should be added together. Answer wall time is not provider TTFT. Token statistics distinguish input, output, and cache; unknown metrics remain unknown.
