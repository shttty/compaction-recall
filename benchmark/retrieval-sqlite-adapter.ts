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
import { displayRows } from "./retrieval-sqlite-page.mjs";

const descriptions = {
  history_recall: "Primary lexical lookup of compacted conversation history on the current branch, not semantic search. Honors the latest branch-local context edits: omitted entries are unavailable and replacements hide original content. Use automatic locator hints, then this tool with focused or rewritten queries to find related entry ids; supply alternative wording or synonyms yourself. Active queries are raw FTS5 MATCH expressions passed unchanged as SQL parameters: write explicit AND, OR or binary NOT between independent operands; implicit AND adjacency is rejected rather than converted to OR. You are responsible for choosing indexed tokens. Han indexing uses adjacent two-character tokens within each uninterrupted Han run, with boundaries preventing phrases from crossing runs; longer Han text must be expressed in native token syntax, for example \"南京 京市\". ASCII identifiers index only lowercase camel-case/acronym components of at least two characters, not the complete identifier or a mixture of it with its components; -, _ and $ separate components. Double quotes match indexed-token phrases, not arbitrary original-text substrings. Native NEAR(), prefix *, phrase +, grouping and column filters pass through unchanged. English Porter expansion is not automatic in manual queries; where a stems column is available, explicitly query its stem, for example stems:run. The backend never tokenizes, repairs or expands the manual expression, and native SQLite errors retain their original messages. There is no explicit query-length or keyword-count cap; SQLite syntax and resource limits still apply. Manual recall has a configurable cooperative JavaScript deadline, defaulting to 5000 ms, covering index preparation and query execution; native MATCH is non-interruptible and may continue until the next checkpoint, late results are discarded, and healthy worker caches are reused without cancelling other requests. Searches user/assistant text plus assistant tool-call names and arguments; excludes toolResult bodies, thinking and images. Paginated results: limit defaults to 50 (maximum 50), offset defaults to 0. Returns total, returned, nextOffset and hasMore; use nextOffset (not offset + limit) with the same query and unchanged branch for another page. Pages target 16000 Unicode codepoints; an oversized metadata row is returned alone and flagged rather than lost. Each snippet contains up to the configured snippet budget (default 240 weighted units) in a matched-term window selected for distinct-term coverage, plus optional ellipses. Han codepoints count as 2 snippet-budget units and other codepoints as 1; configure snippetBudget or COMPACTION_RECALL_SNIPPET_BUDGET to override the default. Verify exact details with history_expand. A zero total includes query-format and tokenization guidance; an empty offset page with a positive total does not. If evidence remains insufficient, rewrite the query or use history_grep as a supplementary text-search fallback over the same text and tool-input scope. No hit does not prove the information was never mentioned.",
  history_grep: "Supplementary text-search fallback when automatic locators, history_recall and expanded entries leave insufficient evidence. Search branch-effective user/assistant text and assistant tool-call names/arguments on the current compacted branch, honoring context edits; exclude toolResult bodies, thinking and images. No matches do not prove absence. `pattern` is a case-insensitive JavaScript regular expression (not SQL LIKE); invalid patterns fall back to literal search. Pages matching entries in branch order: limit defaults to 30 (maximum 50), offset defaults to 0. Use nextOffset with the same pattern and unchanged branch; returned counts entries consumed, including explicitly skipped oversized metadata. total counts raw regex matches, totalEntries matching entries; covered counts other matches visible in this page's snippets, omitted counts raw matches not shown anywhere in this response. Each page shows up to 30 representative snippets overall and at most 3 per entry; full output stays within 16000 Unicode codepoints. Clipped-out text is not covered. Read full text with history_expand or use a narrower pattern to find matching context not shown.",
  history_expand: "Read branch-effective text (honoring context edits) of a compacted history entry by id (from automatic locators, history_recall or history_grep). The requested entry is shown first; output is bounded to 16000 Unicode codepoints. Use offset (default 0), in Unicode codepoints of the requested entry, to continue a long entry; when hasMore is true, pass nextOffset with the same id and before/after values. Neighbor entries (before/after default 2, maximum 20) are included only when the full target is shown and each full neighbor fits. Includes tool-call names/arguments and readable toolResult text; excludes thinking and images. Only the current compacted branch is readable.",
};
const parameters = {
  history_recall: Type.Object({
    query: Type.String({ description: "Raw FTS5 MATCH expression, passed unchanged as a SQL parameter. Use explicit AND, OR or binary NOT between independent operands; implicit AND adjacency is rejected. Choose tokens yourself: Han uses adjacent two-character tokens within uninterrupted Han runs, with run boundaries; express longer text as a native phrase such as \"南京 京市\". ASCII camel-case/acronym identifiers index only lowercase components of at least two characters, not full identifiers; -, _ and $ separate components. Quotes match indexed-token phrases, not arbitrary substrings. Native NEAR(), prefix *, phrase +, grouping and column filters pass through; no automatic OR, Porter expansion, Han conversion or error repair. Where available, query English stems explicitly with stems:run. Native SQLite errors retain their messages. No explicit query-length or keyword-count cap; SQLite syntax and resource limits still apply. Manual recall uses a cooperative JavaScript deadline of 5000 ms by default, including preparation and execution; native MATCH is non-interruptible, late results are discarded, and healthy worker caches are reused without cancelling other requests. Configure recallTimeoutMs or COMPACTION_RECALL_QUERY_TIMEOUT_MS." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results on this page (default 50)" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Result offset (default 0); use nextOffset from the previous page" })),
  }),
  history_grep: Type.Object({
    pattern: Type.String({ description: "Case-insensitive JavaScript regular expression" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum matching entries on this page (default 30)" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Matching-entry offset (default 0); use nextOffset to continue" })),
  }),
  history_expand: Type.Object({
    id: Type.String({ description: "Entry id from automatic locators, history_recall or history_grep" }),
    before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries before (default 2)" })),
    after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries after (default 2)" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Unicode codepoint offset within the requested entry (default 0); use nextOffset to continue" })),
  }),
};


export default function sqliteAdapter(pi: ExtensionAPI) {
  const warn = (message: string) => { process.stderr.write(message + "\n"); };
  const config = loadRecallConfig({ warn });
  const trace = createRecallTrace({ enabled: config.trace, warn });
  const inputPath = process.env.PI_RETRIEVAL_INPUT_FILE;
  let input: { question: string; prompt: string } | undefined;
  if (inputPath) {
    const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
    if (typeof parsed.question !== "string" || typeof parsed.prompt !== "string") throw new Error("Invalid PI_RETRIEVAL_INPUT_FILE question/prompt");
    input = { question: parsed.question, prompt: parsed.prompt };
  }

  // Registration is synchronous: force the production lite branch, then restore the
  // environment. Only its grep/expand executors survive; no production engine/hooks.
  const previousMode = process.env.COMPACTION_RECALL_MODE;
  try {
    process.env.COMPACTION_RECALL_MODE = "lite";
    registerProduction(new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "on") return () => () => { };
        if (property === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
          if (tool.name !== "history_grep" && tool.name !== "history_expand") return;
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
      locator = formatLocatorRows(displayRows(found.results));
      return { messages: withLocators(event.messages, branch, () => locator) };
    } finally { flushTiming(); }
  });

  pi.registerTool({
    name: "history_recall", label: "History recall", description: descriptions.history_recall,
    parameters: parameters.history_recall,
    async execute(id, params, _signal, _onUpdate, ctx) {
      const token = trace?.begin(ctx.sessionManager.getSessionId(), id, params);
      try {
        const found = await index.queryPage(params.query, ctx.sessionManager.getBranch(), params);
        const page = found.page;
        const { total, offset, returned, nextOffset } = page.details;
        trace?.complete(token, { ids: found.ids, total, offset, returned, nextOffset });
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
