import { appendFileSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import registerProduction from "../src/recall-extension.ts";
import { compactedEntries, searchableEntryText } from "../src/history.mjs";
import { formatLocatorRows, lex, locatorText, recallPageFromRows, withLocators } from "../src/locator.mjs";
import { loadRecallConfig } from "../src/recall-config.mjs";
import { createRecallTrace } from "../src/recall-trace.mjs";
import { searchAutomatic } from "./retrieval-eval-core.mjs";
import { createEngine } from "./retrieval-sqlite-engine.mjs";

const descriptions = {
  history_recall: `搜当前分支压缩后历史。
范围：user/assistant 正文、assistant 工具调用名+参数。不含工具结果、思考、图片。
关键词匹配，非语义。同义词、别称、译名自己写进 query。
query = FTS5 MATCH 语法。
空格=OR。
索引：中文=相邻双字+分词所得≥3字词；英文整词。中文拆双字，OR 连。
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
    query: Type.String({ description: "FTS5 MATCH 表达式，原样执行" }),
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

type Document = { id: string; text: string };
type Ranked = { id: string; score: number };
type SqliteEngine = {
  searchAuto(question: string): Ranked[];
  searchRaw(query: string, options?: { limit?: number }): { total: number; results: Ranked[] };
  dispose(): void;
};

// Display only: first literal lexical-term occurrence, 40 codepoints of left context,
// 120 codepoints total; prefix fallback. FTS syntax and ranking remain untouched.
function snippet(text: string, query: string) {
  const lower = text.toLowerCase();
  let first = -1;
  for (const { term } of lex(query)) {
    const at = lower.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  const points = Array.from(text);
  const start = Math.max(0, (first < 0 ? 0 : Array.from(text.slice(0, first)).length) - 40);
  return (start ? "…" : "") + points.slice(start, start + 120).join("") + (start + 120 < points.length ? "…" : "");
}

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

  let engine: SqliteEngine | undefined;
  let indexed: Document[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let locator: string | undefined;
  // Serialize engine use/replacement/disposal so concurrent calls cannot close a DB
  // still being searched. Compare projected text, not branch identity/last entry id.
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => { });
    return result;
  }
  async function prepare(branch: SessionEntry[]) {
    if (closed) throw new Error("SQLite retrieval adapter is shut down");
    const entries = compactedEntries(branch);
    const documents: Document[] = [];
    const sources = new Map<string, { entry: SessionEntry; text: string }>();
    for (const entry of entries) {
      const text = searchableEntryText(entry);
      if (text === undefined) continue;
      documents.push({ id: entry.id, text });
      sources.set(entry.id, { entry, text });
    }
    if (!engine || documents.length !== indexed.length || documents.some((doc, i) => doc.id !== indexed[i].id || doc.text !== indexed[i].text)) {
      const replacement = await createEngine(documents);
      await engine?.dispose?.();
      engine = replacement;
      indexed = documents;
    }
    return {
      engine, rows(ranking: Ranked[], query: string) {
        return ranking.map(({ id }) => {
          const source = sources.get(id);
          if (!source) throw new Error(`SQLite returned an unknown entry id: ${id}`);
          const { entry, text } = source;
          return { id, date: entry.timestamp.slice(0, 10), role: entry.type === "message" ? entry.message.role : entry.type, snippet: snippet(text, query) };
        });
      }
    };
  }

  pi.on("context", (event, ctx) => serial(async () => {
    const branch = ctx.sessionManager.getBranch();
    const user = event.messages.findLast(message => message.role === "user");
    const text = user ? locatorText(user) : "";
    const query = input && text === input.prompt ? input.question : text;
    const current = await prepare(branch);
    const ranking = user ? await searchAutomatic(current.engine, query) : [];
    locator = formatLocatorRows(current.rows(ranking, query));
    return { messages: withLocators(event.messages, branch, () => locator) };
  }));

  pi.registerTool({
    name: "history_recall", label: "History recall", description: descriptions.history_recall,
    parameters: parameters.history_recall,
    async execute(id, params, _signal, _onUpdate, ctx) {
      const token = trace?.begin(ctx.sessionManager.getSessionId(), id, params);
      try {
        return await serial(async () => {
          const current = await prepare(ctx.sessionManager.getBranch());
          let found = await current.engine.searchRaw(params.query);
          if (found.results.length < found.total) found = await current.engine.searchRaw(params.query, { limit: found.total });
          if (found.results.length !== found.total) throw new Error("SQLite did not return the complete ranking");
          const page = recallPageFromRows(current.rows(found.results, params.query), params);
          const { total, offset, returned, nextOffset } = page.details;
          trace?.complete(token, { ids: found.results.slice(offset, offset + returned).map((row: Ranked) => row.id), total, offset, returned, nextOffset });
          return { content: [{ type: "text" as const, text: page.text }], details: page.details };
        });
      } catch (error) {
        trace?.fail(token, error);
        throw error;
      }
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
  pi.on("session_shutdown", () => serial(async () => {
    closed = true;
    try { await engine?.dispose?.(); }
    finally { engine = undefined; indexed = []; trace?.flush(); }
  }));
}
