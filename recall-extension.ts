// pi-recall tool registration; retained as the historical lme-bench entry point.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_HITS, SNIPPET, MAX_EXPAND_CHARS, entryText, searchableEntryText, compactedEntries, toRegExp } from "./history.ts";

import { buildRecallPage, withLocators } from "./locator.ts";

export default function(pi: ExtensionAPI) {
  pi.on("context", (event, ctx) => ({
    messages: withLocators(event.messages, ctx.sessionManager.getBranch()),
  }));
  pi.registerTool({
    name: "history_recall",
    label: "History recall",
    description:
      "Primary keyword lookup of compacted conversation history on the current branch. " +
      "Use automatic locator hints, then this tool with focused or rewritten keywords to find related entry ids. " +
      "Uses the same lexical ranking as automatic hints, not semantic search: supply alternative wording or synonyms yourself. " +
      "Searches user/assistant text plus assistant tool-call names and arguments; excludes toolResult bodies, thinking and images. Paginated results: limit defaults to 50 (maximum 50), offset defaults to 0. " +
      "Returns total, returned, nextOffset and hasMore; use nextOffset (not offset + limit) with the same query and unchanged branch for another page. " +
      "Pages target 16000 Unicode codepoints; an oversized metadata row is returned alone and flagged rather than lost. " +
      "Each snippet contains up to 120 Unicode codepoints around the most informative matched term, plus optional ellipses. " +
      "Verify exact details with history_expand. If evidence remains insufficient, use history_grep as a supplementary " +
      "text-search fallback over the same text and tool-input scope. No hit does not prove the information was never mentioned.",
    parameters: Type.Object({
      query: Type.String({ description: "Focused keywords or revised wording; first 4000 Unicode codepoints and 24 distinct terms are used" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results on this page (default 50)" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Result offset (default 0); use nextOffset from the previous page" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const page = buildRecallPage(params.query, ctx.sessionManager.getBranch(), params);
      return { content: [{ type: "text", text: page.text }], details: page.details };
    },
  });

  pi.registerTool({
    name: "history_grep",
    label: "History grep",
    description:
      "Supplementary text-search fallback when automatic locators, history_recall and expanded entries leave insufficient evidence. " +
      "Search ORIGINAL user/assistant text and assistant tool-call names/arguments on the current compacted branch; exclude toolResult bodies, thinking and images. No matches do not prove absence. " +
      "`pattern` is a case-insensitive JavaScript regular expression (not SQL LIKE); use " +
      "alternation for synonyms, e.g. `5K|5 km|personal best`. Returns entry ids with snippets; read full text with history_expand.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Case-insensitive JavaScript regular expression" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rx = toRegExp(params.pattern);
      const lines: string[] = [];
      let total = 0;
      for (const e of compactedEntries(ctx.sessionManager.getBranch())) {
        const text = searchableEntryText(e);
        if (text === undefined) continue;
        let shown = 0;
        for (const m of text.matchAll(rx)) {
          total += 1;
          if (lines.length >= MAX_HITS || shown >= 3) continue;
          shown += 1;
          const i = m.index ?? 0;
          const snip = text.slice(Math.max(0, i - SNIPPET), i + m[0].length + SNIPPET).replace(/\s+/g, " ");
          const role = e.type === "message" ? e.message.role : e.type;
          lines.push(`[${e.id}] ${e.timestamp.slice(0, 10)} ${role}: …${snip}…`);
        }
      }
      const head = total === 0 ? "No matches in compacted history." : `${total} matches (showing ${lines.length}).`;
      return { content: [{ type: "text", text: [head, ...lines].join("\n") }], details: { total } };
    },
  });

  pi.registerTool({
    name: "history_expand",
    label: "History expand",
    description:
      "Read original text of a compacted history entry by id (from automatic locators, history_recall or history_grep), plus neighbouring " +
      "entries for context, including tool-call names/arguments and readable toolResult text (output capped at 16000 UTF-16 code units; use before=0 and after=0 to focus on the entry). Neighbouring entries of the same conversation carry the session date in its first user message.",
    parameters: Type.Object({
      id: Type.String({ description: "Entry id from automatic locators, history_recall or history_grep" }),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries before (default 2)" })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries after (default 2)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const entries = compactedEntries(ctx.sessionManager.getBranch());
      const at = entries.findIndex((e) => e.id === params.id);
      if (at < 0) return { content: [{ type: "text", text: `No compacted entry with id ${params.id}.` }], details: {} };
      const from = Math.max(0, at - (params.before ?? 2));
      const to = Math.min(entries.length, at + (params.after ?? 2) + 1);
      let out = "";
      for (const e of entries.slice(from, to)) {
        const role = e.type === "message" ? e.message.role : e.type;
        out += `\n--- [${e.id}] ${e.timestamp} ${role}${e.id === params.id ? " (requested)" : ""}\n${entryText(e)}\n`;
      }
      if (out.length > MAX_EXPAND_CHARS) out = out.slice(0, MAX_EXPAND_CHARS) + "\n[truncated]";
      return { content: [{ type: "text", text: out.trim() }], details: { from: entries[from].id, to: entries[to - 1].id } };
    },
  });
}
