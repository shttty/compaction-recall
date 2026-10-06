# Actual Pi TUI warm-session demo

One original DEV8 question, `577d4d32`, was run in three visible Herdr panes with Pi 0.99.1, `openai-codex/gpt-6-luna`, high effort, 372k context metadata and the existing 340k safety guard. The three sessions started from independent copies of the same previously compacted snapshot. No new compaction calls were needed.

Each pane received `hello`, completed that turn, then received the exact original question. Input was inserted in eight-character chunks over a measured common interval of **3000.10 ms**. All three persisted question strings matched the source byte-for-byte. Three Pi sessions completed six user turns (three hello turns, three answers), with ten observed provider-prepared callbacks including tool continuations. No retries or judge-model calls.

| Arm | Hello wall | Question wall | Question first visible text | Question tools | Reference review |
|---|---:|---:|---:|---|---|
| Native | 4.514 s | 14.474 s | 13.732 s | none | Incorrect: inferred 9:30 pm |
| Grep | 5.151 s | 19.790 s | 19.053 s | grep, expand | Correct: 7 pm |
| Indexed recall + grep | 10.495 s | 15.136 s | 14.209 s | recall, expand | Correct: 7 pm |

Wall intervals run from Pi's interactive input event to its completed agent event, using its monotonic clock. First visible text is an observed text delta, not genuine provider TTFT. This is one observation per arm, not a general speed or quality result.

## Background versus foreground

The indexed worker completed its initial build in **1954.73 ms**, including **4.12 ms** of recorded main-thread extraction. It was already ready **191.45 seconds before question submission** because configuring the visible terminal took time. Thus this is a warm-session demonstration, not proof that a three-second delay alone hides initial startup.

During the actual indexed question, recorded readiness waits summed to **3.81 ms** across automatic contexts and manual recall. Those waits are on the foreground critical path even though worker processing runs off the main thread. Query, ranking, rendering, transfer, tool and model spans remain in the accompanying JSON; inclusive nested spans must not be summed as disjoint costs.

Hello also warmed model/provider caches. The ten-user-cycle OR ten-tool-round maintenance threshold was not reached; startup prewarm was the relevant indexing trigger. No forced grep fallback was added. Per-arm first/last-keystroke times were not recorded separately; the common typing interval is measured, not inferred.

## Reproducibility and state

- Normalized results: `pi-tui-warm-results.json`; aggregation: `summarize-tui-demo.py`
- Session preparation: `prepare-tui-demo.py`; event observer: `pi-tui-milestones.mjs`
- Raw ignored sessions and timings: sibling `lme-bench/runs/pi-tui-warm-20260930/`
- Actual desktop controller: `/workspace/shared/h.py`, using the official Herdr pane API from an actual Herdr-managed process
- Herdr 0.9.3 official Linux binary SHA256: `18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7`

The three live Pi consoles were preserved after completion. A helper wrote/reloaded `terminal.default_shell = "/bin/bash"`, but the actual fresh-pane shell executable and effective config path were not verified before the session was stopped. The existing pane layout was equalized without restarting Pi. The subsequent installation of official Herdr Pi integration version 9 into all three test profiles happened **after** this experiment. A `/reload` activation attempt was inconclusive. A later new Herdr session explicitly loaded each official hook with `-e` and Pi reached ready; authoritative hook state was not verified before the user stopped the session. The hooks did not affect these experiment results. The integration reports local session/state metadata and adds no retrieval tools.
