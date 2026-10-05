import { appendFileSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import registerProduction from "../src/recall-extension.ts";
import { formatLocatorRows, locatorText, withLocators } from "../src/locator.mjs";
import { loadRecallConfig } from "../src/recall-config.mjs";
import { createRecallTrace } from "../src/recall-trace.mjs";
import { SQLiteBackgroundIndex } from "./sqlite-background-index.mjs";
import { PreindexCadence } from "../src/preindex-cadence.mjs";
import { recallTiming, flushTiming } from "../src/timing.mjs";
import { displayRows, SQLITE_LOCATOR_HEADER } from "./retrieval-sqlite-page.mjs";

const descriptions = {
  history_recall: "Primary lexical lookup of compacted conversation history on the current branch, not semantic search. Use automatic locator hints first, then history_recall to locate entry ids and history_expand to verify exact details. Honors branch-local context edits: omitted entries are unavailable and replacements hide originals. Supply concepts as 1..5 groups of 1..4 alternative literal surface forms each; choose alternative wording or synonyms yourself. match defaults to any (one group suffices); all requires every group in the same indexed record. Fully indexable surfaces use analyzed term co-occurrence, not phrase order or adjacency; analyzer branches are OR alternatives and terms within a branch are AND. Surfaces with zero tokens or lost letter/number/mark characters automatically use case-insensitive literal substring matching of the entire trimmed surface, preserving internal whitespace and punctuation, never regular expressions. This routing is based on tokenizer coverage, not zero hits: normal FTS zero hits are not broadened and errors never trigger fallback. Strings are literal data, never SQL, FTS syntax or an arbitrary query AST; do not hand-split Han bigrams or write MATCH expressions. Optional exclude contains at most 5 literal surfaces: any matching exclusion removes the whole record, not a ranking penalty; overly broad exclusions can hide useful evidence. Nonempty trimmed surfaces permit at most 256 Unicode codepoints each and 2048 total; invalid text and unknown fields are rejected, never silently truncated. Backend analysis is limited to 4 branches per surface, 16 atoms per branch, 4096 codepoints per atom, 256 expanded atoms total and 32768 compiled MATCH UTF-16 units. Manual queries have no automatic length gate or extra stemming expansion; tokenizer/lemma normalization aligns indexed terms. Pure FTS uses native BM25; if any positive or exclusion surface needs literal matching, the entire request ranks by corpus-row surface rarity, taking the maximum matching alternative per positive group and summing groups, then group count and time ties. Both routes deduplicate full content before pagination. Searches user/assistant text plus assistant tool-call names/arguments, not toolResult bodies, thinking or images. limit defaults to 50 (maximum 50), offset to 0; use nextOffset with the same concepts, match, exclude and unchanged branch. Pages target 16000 Unicode codepoints with the existing oversized-metadata progress exception. Snippets default to 240 weighted units (Han 2, other codepoints 1), configurable by snippetBudget or COMPACTION_RECALL_SNIPPET_BUDGET; positive literal evidence is shown, exclusions do not guide snippets. Manual recall retains the configurable cooperative JavaScript deadline (default 5000 ms); native MATCH is non-interruptible, late results are discarded and healthy worker caches are reused. A true zero total suggests checking concept groups, any/all and surface wording; a positive-total empty offset page does not warn. No hit does not prove the information was never mentioned.",
  history_expand: "Read branch-effective text (honoring context edits) of a compacted history entry by id from automatic locators or history_recall. The requested entry is shown first; output is bounded to 16000 Unicode codepoints. Use offset (default 0), in Unicode codepoints of the requested entry, to continue a long entry; when hasMore is true, pass nextOffset with the same id and before/after values. Neighbor entries (before/after default 2, maximum 20) are included only when the full target is shown and each full neighbor fits. Includes tool-call names/arguments and readable toolResult text; excludes thinking and images. Only the current compacted branch is readable.",
};
const parameters = {
  history_recall: Type.Object({
    concepts: Type.Array(Type.Array(Type.String({ description: "Nonempty trimmed literal surface, at most 256 Unicode codepoints; fully indexable text uses FTS co-occurrence, otherwise automatic whole-surface case-insensitive literal matching preserves internal whitespace/punctuation; never regex or FTS syntax" }), { minItems: 1, maxItems: 4 }), { minItems: 1, maxItems: 5, description: "Concept groups; alternatives within each group. All surfaces together are limited to 2048 Unicode codepoints. Normal FTS zero hits do not trigger literal fallback." }),
    match: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")], { description: "Default any: one group suffices. all: every group must match the same record; co-occurrence is not phrase matching." })),
    exclude: Type.Optional(Type.Array(Type.String({ description: "Hard exclusion with the same automatic FTS/literal routing; any match removes the entire record and may hide relevant evidence" }), { maxItems: 5 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results on this page (default 50)" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Result offset (default 0); use nextOffset from the previous page" })),
  }),
  history_expand: Type.Object({
    id: Type.String({ description: "Entry id from automatic locators or history_recall" }),
    before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries before (default 2)" })),
    after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries after (default 2)" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Unicode codepoint offset within the requested entry (default 0); use nextOffset to continue" })),
  }),
};


export default function sqliteAdapter(pi: ExtensionAPI) {
  const warn = (message: string) => { process.stderr.write(message + "\n"); };
  const config = loadRecallConfig({ warn });
  const trace = createRecallTrace({ enabled: config.trace, warn, inputFields: ["concepts", "match", "exclude"] });
  const inputPath = process.env.PI_RETRIEVAL_INPUT_FILE;
  let input: { question: string; prompt: string } | undefined;
  if (inputPath) {
    const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
    if (typeof parsed.question !== "string" || typeof parsed.prompt !== "string") throw new Error("Invalid PI_RETRIEVAL_INPUT_FILE question/prompt");
    input = { question: parsed.question, prompt: parsed.prompt };
  }

  // Registration is synchronous: force the production lite branch, then restore the
  // environment. Only its expand executor survives; no production engine/hooks.
  const previousMode = process.env.COMPACTION_RECALL_MODE;
  try {
    process.env.COMPACTION_RECALL_MODE = "lite";
    registerProduction(new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "on") return () => () => { };
        if (property === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
          if (tool.name !== "history_expand") return;
          const name = tool.name;
          target.registerTool({ ...tool, description: descriptions[name], parameters: parameters[name] });
        };
        return Reflect.get(target, property, receiver);
      },
    }));
  } finally {
    if (previousMode === undefined) delete process.env.COMPACTION_RECALL_MODE;
    else process.env.COMPACTION_RECALL_MODE = previousMode;
  }

  // jiti loads the TS entry while workers require its original native file URL.
  const sourceURL = typeof __filename === "string" ? pathToFileURL(__filename) : import.meta.url;
  const index = new SQLiteBackgroundIndex({
    engineModule: new URL("./retrieval-sqlite-worker.mjs", sourceURL), timer: recallTiming,
    autoGate: config.autoGate, recallTimeoutMs: config.recallTimeoutMs, snippetBudget: config.snippetBudget
  });
  const cadence = new PreindexCadence(config.userCycles, config.toolRounds);
  let scheduled: NodeJS.Immediate | undefined;
  let locator: string | undefined;
  const cancelScheduled = () => { clearImmediate(scheduled); scheduled = undefined; };
  const prewarm = (event: { type?: string }, ctx: ExtensionContext) => {
    if (scheduled) return;
    recallTiming?.mark("preindex_scheduled", {
      trigger: event.type ?? "lifecycle", userCounter: cadence.completed,
      toolCounter: cadence.toolRounds, execution: "synchronous_main_thread",
    });
    cadence.scheduled();
    scheduled = setImmediate(() => {
      scheduled = undefined;
      void index.prepare(ctx.sessionManager.getBranch(), { preindexLive: true }).catch(() => { }).finally(flushTiming);
    });
  };
  pi.on("session_start", (event, ctx) => { cancelScheduled(); cadence.reset(); index.reset(); prewarm(event, ctx); });
  pi.on("session_compact", prewarm);
  pi.on("session_tree", (event, ctx) => { cancelScheduled(); cadence.reset(); index.reset(); prewarm(event, ctx); });
  pi.on("message_end", event => { if (event.message.role === "user") cadence.userMessage(); });
  pi.on("turn_end", (event, ctx) => { if (cadence.toolBatch(event)) prewarm(event, ctx); });
  pi.on("agent_end", (event, ctx) => { if (cadence.end(event.messages)) prewarm(event, ctx); flushTiming(); });
  pi.on("context", async (event, ctx) => {
    try {
      const branch = ctx.sessionManager.getBranch();
      const user = event.messages.findLast(message => message.role === "user");
      const text = user ? locatorText(user) : "";
      const query = input && text === input.prompt ? input.question : text;
      const found = user ? await index.queryRanked(query, branch, { mode: "auto", options: { limit: 5 } }) : { results: [] };
      locator = formatLocatorRows(displayRows(found.results), SQLITE_LOCATOR_HEADER);
      return { messages: withLocators(event.messages, branch, () => locator) };
    } finally { flushTiming(); }
  });

  pi.registerTool({
    name: "history_recall", label: "History recall", description: descriptions.history_recall,
    parameters: parameters.history_recall,
    async execute(id, params, _signal, _onUpdate, ctx) {
      const token = trace?.begin(ctx.sessionManager.getSessionId(), id, params);
      try {
        const { limit, offset: requestedOffset, ...query } = params;
        const found = await index.queryPage(query, ctx.sessionManager.getBranch(), { limit, offset: requestedOffset });
        const page = found.page;
        const { total, offset, returned, nextOffset } = page.details;
        const fallback = found.fallback ?? page.details.fallback;
        trace?.complete(token, { ids: found.ids, total, offset, returned, nextOffset, ...(fallback ? { fallback } : {}) });
        return { content: [{ type: "text" as const, text: page.text }], details: page.details };
      } catch (error) {
        trace?.fail(token, error);
        throw error;
      } finally { flushTiming(); }
    },
  });

  if (trace) {
    pi.on("message_end", (event, ctx) => { trace.messageEnd(ctx.sessionManager.getSessionId(), event.message); });
    pi.on("tool_call", (event, ctx) => { trace.toolCall(ctx.sessionManager.getSessionId(), event); });
    pi.on("agent_end", () => { trace.flush(); });
    pi.on("before_provider_request", (event, ctx) => {
      // Inspect actual provider payload, but persist no request text except our own
      // exact locator. Never serialize payloads, assistant reasoning, or credentials.
      let present = false;
      const seen = new Set<object>();
      const visit = (value: unknown) => {
        if (typeof value === "string") { if (locator && value.includes(locator)) present = true; return; }
        if (!value || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
          if (["thinking", "reasoning", "reasoning_content", "signature", "encrypted_content"].includes(key)) continue;
          visit(child);
        }
      };
      visit(event.payload);
      const payload = event.payload as { reasoning_effort?: unknown; reasoning?: { effort?: unknown } } | null;
      const rawEffort = payload?.reasoning_effort ?? payload?.reasoning?.effort;
      const effort = typeof rawEffort === "string" && ["none", "minimal", "low", "medium", "high", "xhigh"].includes(rawEffort) ? rawEffort : null;
      try {
        appendFileSync(process.env.COMPACTION_RECALL_TIMING_FILE!, JSON.stringify({
          type: "sqlite_provider_evidence", sessionId: ctx.sessionManager.getSessionId(),
          locatorPresent: present, locator: present ? locator : null, effort,
        }) + "\n", { mode: 0o600 });
      } catch { /* Diagnostics must not affect provider requests. */ }
    });
  }
  pi.on("session_shutdown", async () => {
    cancelScheduled();
    cadence.reset();
    try { await index.dispose(); }
    finally { trace?.flush(); flushTiming(); }
  });
}
