---
name: recall-tool-validation
description: Use when validating compaction-recall tools or runners. Exercise the maintained production entry and isolated SDK flow.
---

# Recall tool validation

Work from the repository root and preserve unrelated changes. Use [the benchmark guide](../../../doc/benchmark.md) for current inputs and CLI options; [the plugin reference](../../../doc/PLUGIN.md) defines production behavior.

## Offline behavior

Run focused tests while changing a behavior, then the complete offline suites:

```sh
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

Check the relevant public behavior rather than retired implementation helpers: branch/context-edit visibility, full/lite registration, recall/grep/expand output, worker lifecycle and failures, timing, and configuration. Remove tests only when their behavior is retired or its coverage has moved to the current implementation.

## Actual SDK and runner wiring

Use the maintained three-mode smoke with an explicit candidate directory and a fresh external output directory:

```sh
node benchmark/smoke.mjs \
  --three-arms "$CANDIDATE_ROOT" "$NEW_SMOKE_OUT"
```

The candidate must provide the package source and the locked host dependencies needed by benchmark preparation. The smoke uses synthetic profiles and blocks network access. Verify actual registered/serialized tools, automatic content only in full, real tool/worker execution, shared candidate preparation, and resume without repeating SDK work. For package checks, exercise extracted package bytes; keep host test resources separate from tarball contents.

Runner regressions must cross the real prepare/run/answer/judge/report paths with only the provider boundary replaced. Check completed-phase reuse, identity-change rejection, unknown-inflight handling, failure-versus-wrong-answer accounting, and separate correctness/partial-credit verdicts. Do not replace the runner itself with a stand-in.

## Live evaluations

Run real LME16 or SWE-chat evaluations only when explicitly authorized. Use a fresh external result directory, explicit model/profile paths, frozen candidate and input identities, and the guide's resource limits. Keep references and prior solutions out of solver requests; pass them only to judges. Do not read, print or copy profile credentials.

Report offline checks, SDK wiring and live model accuracy separately. Fixture success is not an accuracy result. Preserve original evidence and independently label manual review or historical peak selection; a directory/config migration does not validate or relabel old scores.
