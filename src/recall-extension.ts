// Production registration; src/index.ts is the public package entry.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadRecallConfig } from "./extension/recall-config.mjs";
import { createRecallTrace } from "./observability/recall-trace.mjs";
import { registerIndexLifecycle } from "./extension/index-lifecycle.ts";
import { registerAutomaticContext } from "./extension/automatic-context.ts";
import { registerRecall } from "./tools/recall.ts";
import { registerGrep } from "./tools/grep.ts";
import { registerExpand } from "./tools/expand.ts";

export default function(pi: ExtensionAPI) {
  // Mode and cadence share one agent-directory snapshot until the extension reloads.
  const warn = (message: string) => { process.stderr.write(message + "\n"); };
  const config = loadRecallConfig({ warn });
  const { mode, trace } = config;
  const recallTrace = createRecallTrace({ enabled: trace, warn, inputFields: ["concepts", "match", "exclude"] });
  if (mode === "full") {
    if (recallTrace) {
      pi.on("message_end", (event, ctx) => { recallTrace.messageEnd(ctx.sessionManager.getSessionId(), event.message); });
      pi.on("tool_call", (event, ctx) => { recallTrace.toolCall(ctx.sessionManager.getSessionId(), event); });
      pi.on("agent_end", () => { recallTrace.flush(); });
      pi.on("session_shutdown", () => { recallTrace.flush(); });
    }
    const index = registerIndexLifecycle(pi, config);
    registerAutomaticContext(pi, index);
    registerRecall(pi, index, recallTrace);
  }
  registerGrep(pi, mode);
  registerExpand(pi, mode);
}
