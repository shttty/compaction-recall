import { appendFileSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import registerProduction from "../src/recall-extension.ts";
import { formatLocatorRows, locatorText, withLocators } from "../src/locator.mjs";
import { loadRecallConfig } from "../src/recall-config.mjs";
import { createRecallTrace } from "../src/recall-trace.mjs";
import { BackgroundIndex } from "../src/background-index.mjs";
import { PreindexCadence } from "../src/preindex-cadence.mjs";
import { recallTiming, flushTiming } from "../src/timing.mjs";
import { countKeywords } from "../prototype/soft-match-sqlite/query.mjs";
import { displayRows, sqliteRecallPage } from "./retrieval-sqlite-page.mjs";

const descriptions = {
  history_recall: `搜当前分支压缩后历史。
范围：user/assistant 正文、assistant 工具调用名+参数。不含工具结果、思考、图片。
关键词匹配，非语义。
query = FTS5 MATCH 语法。空格=OR。
每次≤5个关键词，超了报错。同义词、别称、译名分几次查。
索引：中文=相邻双字+分词所得≥3字词；英文整词。
中文写2字词；1字查不到，3字以上多半不在索引。
零命中→换说法。没命中≠没说过。
命中 id→history_expand 读原文。正则/字面子串→history_grep。`,
  history_grep: `正则/字面子串搜当前分支压缩后历史。按关键词找线索先用 history_recall。
范围：user/assistant 正文、assistant 工具调用名+参数。不含工具结果、思考、图片。
pattern = JS 正则，不分大小写；正则非法→按字面搜。
片段有截断，读全文→history_expand。
没命中≠没说过。`,
  history_expand: `按 id 读当前分支压缩后历史条目全文，附前后邻居。
id 来自自动提示、history_recall、history_grep。
含工具调用名+参数、可读的工具结果；不含思考、图片。
长条目分页，邻居只在目标读完时附上。`,
};
const offset = () => Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "翻页时填上一页返回的 nextOffset" }));
const parameters = {
  history_recall: Type.Object({
    query: Type.String({ description: "FTS5 MATCH 表达式，空格=OR" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "每页条数，默认 50，最多 50" })),
    offset: offset(),
  }),
  history_grep: Type.Object({
    pattern: Type.String({ description: "JS 正则，不分大小写" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "每页条目数，默认 30，最多 50" })),
    offset: offset(),
  }),
  history_expand: Type.Object({
    id: Type.String({ description: "条目 id" }),
    before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "前、后邻居条数，默认 2，最多 20" })),
    after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "前、后邻居条数，默认 2，最多 20" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "续读长条目时填上一页返回的 nextOffset，id 和 before/after 保持不变" })),
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
  const index = new BackgroundIndex({ engineModule: new URL("./retrieval-sqlite-worker.mjs", sourceURL), timer: recallTiming });
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
      const found = user ? await index.queryRanked(query, branch, { mode: "auto" }) : { results: [] };
      locator = formatLocatorRows(displayRows(found.results));
      return { messages: withLocators(event.messages, branch, () => locator) };
    } finally { flushTiming(); }
  });

  pi.registerTool({
    name: "history_recall", label: "History recall", description: descriptions.history_recall,
    parameters: parameters.history_recall,
    async execute(id, params, _signal, _onUpdate, ctx) {
      const token = trace?.begin(ctx.sessionManager.getSessionId(), id, params);
      const keywordCount = countKeywords(params.query);
      if (token) Object.assign(token, { keywordCount, rejected: keywordCount > 5 });
      try {
        if (keywordCount > 5) throw new Error(`本次 ${keywordCount} 个关键词，上限 5，请拆开分几次查`);
        const found = await index.queryRanked(params.query, ctx.sessionManager.getBranch(), { mode: "manual", options: params });
        const missingTerms = (found as typeof found & { missingTerms?: string[] }).missingTerms ?? [];
        const page = sqliteRecallPage(found.results, params, missingTerms);
        const { total, offset, returned, nextOffset } = page.details;
        trace?.complete(token, { ids: found.results.slice(offset, offset + returned).map(row => row.id), total, offset, returned, nextOffset });
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
