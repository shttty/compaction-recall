import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SQLiteBackgroundIndex } from "../worker/sqlite-background-index.mjs";
import type { createRecallTrace } from "../observability/recall-trace.mjs";
import { branch, observe } from "../extension/operations.ts";

export function registerRecall(pi: ExtensionAPI, index: SQLiteBackgroundIndex, recallTrace: ReturnType<typeof createRecallTrace>) {
  pi.registerTool({
    name: "history_recall",
    label: "History recall",
    description: `Lexical search over this branch's compacted history (not semantic). Returns ids + snippets as hints; use history_expand to verify exact details before relying on them. Covers user/assistant messages and tool-call arguments, not tool results.

Minimal: {"concepts": [["dnf"]]}

Each group = one concept. Search is lexical, so fill the group with the concept's wordings yourself: names, identifiers, synonyms, aliases, abbreviations, Chinese and English forms, broader/narrower terms. Any one matches the group.
Between groups: match="any" (default) needs any group; "all" needs every group in the same entry. Use "all" only when results are too broad.
exclude: any match drops the entry.
Surfaces: single words or short terms; literal text, not regex or query syntax. Skip filler like "earlier" or "you said". Run two or three differently worded calls in parallel.

Counts/totals/lists: find each item and its evidence before aggregating; one page is not everything.
Warnings, timeouts or few results: rephrase or use history_grep. No match ≠ never said.`,
    parameters: Type.Object({
      concepts: Type.Array(Type.Array(Type.String({ description: "Literal text, ≤256 characters" }), { minItems: 1, description: "One concept: 1–8 alternative wordings" }), { minItems: 1, description: 'Required. 1–5 groups, each 1–8 alternative surfaces. Example: [["dnf","yum"],["EL8","Rocky 8"]]' }),
      match: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")], { description: "any (default): any group matches. all: every group in the same entry." })),
      exclude: Type.Optional(Type.Array(Type.String({ description: "Literal text, ≤256 characters" }), { description: "Up to 5 surfaces; any match drops the whole entry" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Results per page, 1–50, default 50" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Pass nextOffset from the previous page; keep the query unchanged" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const token = recallTrace?.begin(ctx.sessionManager.getSessionId(), _id, params);
      try {
        return await observe("tool_history_recall_total", async () => {
          const { limit, offset: requestedOffset, ...query } = params;
          const found = await index.queryPage(query, branch(ctx), { limit, offset: requestedOffset });
          const page = found.page;
          if (recallTrace) {
            const { total, offset, returned, nextOffset } = page.details;
            recallTrace.complete(token, { ids: found.ids, total, offset, returned, nextOffset });
          }
          return { content: [{ type: "text" as const, text: page.text }], details: page.details };
        });
      } catch (error) {
        if (recallTrace) recallTrace.fail(token, error);
        throw error;
      }
    },
  });
}
