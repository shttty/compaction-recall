import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SQLiteBackgroundIndex } from "../worker/sqlite-background-index.mjs";
import { PreindexCadence } from "../worker/preindex-cadence.mjs";
import type { loadRecallConfig } from "./recall-config.mjs";
import { recallTiming, flushTiming } from "../observability/timing.mjs";
import { branch } from "./operations.ts";

export function registerIndexLifecycle(pi: ExtensionAPI, config: ReturnType<typeof loadRecallConfig>): SQLiteBackgroundIndex {
  const { userCycles, toolRounds, autoGate, recallTimeoutMs, snippetBudget, jieba } = config;
  const index = new SQLiteBackgroundIndex({ timer: recallTiming, autoGate, recallTimeoutMs, snippetBudget, jieba });
  const cadence = new PreindexCadence(userCycles, toolRounds);
  let scheduled: NodeJS.Immediate | undefined;
  const cancelScheduled = () => {
    clearImmediate(scheduled);
    scheduled = undefined;
  };
  const prewarm = (event: { type?: string }, ctx: ExtensionContext) => {
    if (scheduled) return;
    recallTiming?.mark("preindex_scheduled", {
      trigger: event.type ?? "lifecycle", userCounter: cadence.completed, toolCounter: cadence.toolRounds,
      execution: "synchronous_main_thread",
    });
    cadence.scheduled();
    scheduled = setImmediate(() => {
      scheduled = undefined;
      void index.prepare(branch(ctx), { preindexLive: true }).catch(() => { }).finally(flushTiming);
    });
  };
  pi.on("session_start", (event, ctx) => {
    cancelScheduled();
    cadence.reset();
    index.reset();
    prewarm(event, ctx);
  });
  pi.on("session_compact", prewarm);
  pi.on("session_tree", (event, ctx) => {
    cancelScheduled();
    index.reset();
    cadence.reset();
    prewarm(event, ctx);
  });
  pi.on("message_end", event => { if (event.message.role === "user") cadence.userMessage(); });
  pi.on("turn_end", (event, ctx) => { if (cadence.toolBatch(event)) prewarm(event, ctx); });
  pi.on("agent_end", (event, ctx) => { if (cadence.end(event.messages)) prewarm(event, ctx); });
  pi.on("session_shutdown", async () => {
    cancelScheduled();
    cadence.reset();
    await index.dispose();
    flushTiming();
  });
  return index;
}
