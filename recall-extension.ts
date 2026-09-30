// pi-recall tool registration; retained as the historical lme-bench entry point.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_HITS, SNIPPET, MAX_EXPAND_CHARS, entryText, compactedEntries, toRegExp } from "./history.ts";

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "history_grep",
    label: "History grep",
    description:
      "Search the ORIGINAL text of older conversation history that was compacted out of your context. " +
      "The compaction summary is lossy: before answering that something was never mentioned, or when you need an exact " +
      "detail (name, number, date, time, place), search here. `pattern` is a case-insensitive regular expression; use " +
      "alternation for synonyms, e.g. `5K|5 km|personal best`. Returns entry ids with snippets; read full text with history_expand.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Case-insensitive JavaScript regular expression" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rx = toRegExp(params.pattern);
      const lines: string[] = [];
      let total = 0;
      for (const e of compactedEntries(ctx.sessionManager.getBranch())) {
        const text = entryText(e);
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
      "Read original text of a compacted history entry by id (from history_grep), plus neighbouring " +
      "entries for context (output capped at 16000 UTF-16 code units; use before=0 and after=0 to focus on the entry). Neighbouring entries of the same conversation carry the session date in its first user message.",
    parameters: Type.Object({
      id: Type.String({ description: "Entry id from history_grep" }),
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
