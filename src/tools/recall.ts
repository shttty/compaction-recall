import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SQLiteBackgroundIndex } from "../worker/sqlite-background-index.mjs";
import type { createRecallTrace } from "../observability/recall-trace.mjs";
import { branch, observe } from "../extension/operations.ts";

export function registerRecall(pi: ExtensionAPI, index: SQLiteBackgroundIndex, recallTrace: ReturnType<typeof createRecallTrace>) {
  pi.registerTool({
    name: "history_recall",
    label: "History recall",
    description:
      "Primary lexical lookup of compacted conversation history on the current branch, not semantic search. Use automatic locators, history_recall to locate entry ids and history_expand to verify details; if evidence remains insufficient, history_grep can supplement the search. Honors branch-local context edits and excludes toolResult bodies, thinking and images. Supply concepts as 1..5 groups of 1..4 alternative literal surfaces; match defaults to any, while all requires every group in the same indexed record. Analyzer branches are OR and terms within a branch are AND co-occurrence, not phrase order. Optional exclude has at most 5 surfaces and hard-removes matching records. Manual recall uses the original strict concept compiler and SQLite BM25 with full-content deduplication and time ties. Worker-default jieba ranks distinct positive all-Han long-surface hits (at least three characters) before BM25 in SQLite, before pagination; exclude never adds ranking points and FTS alone decides candidates; no automatic literal scan or hybrid rarity. Zero-token surfaces raise the original compiler QueryError. Partial loss of Letter/Number/Mark information in any positive or exclusion surface returns a short warning with the original surface and actual terms alongside normal FTS results: revise query terms or use history_grep. Declared punctuation/case handling and legal normalization do not add warnings. Surfaces are nonempty trimmed literal data, at most 256 Unicode codepoints each and 2048 total, never SQL/FTS syntax or regex; unknown fields are rejected. limit defaults to 50 (maximum 50), offset to 0; use nextOffset with the same query and unchanged branch. Pages target 16000 Unicode codepoints with the existing oversized-metadata progress exception. Snippets default to 240 weighted units (Han 2, others 1), configurable by snippetBudget or COMPACTION_RECALL_SNIPPET_BUDGET; only positive terms select windows. The configurable cooperative deadline defaults to 5000 ms; native MATCH is non-interruptible, late results are discarded and healthy worker caches retained. After timeout, narrow concepts or use independent history_grep; grep has no regex execution timeout. Normal FTS zero hits remain zero. No hit does not prove absence.\n\nFor questions asking for a count, sum, or list, first collect the distinct items and their supporting evidence, then aggregate them. Check the time range, item status, and duplicate mentions; the number of retrieved entries is not the number of items. Do not treat the first page or a single query as a complete inventory. If specific gaps remain, search related expressions and, when needed, expand the original entries or use history_grep. Give an evidence-supported breakdown and aggregate; do not guess missing items to complete the list.",
    parameters: Type.Object({
      concepts: Type.Array(Type.Array(Type.String({ description: "Nonempty trimmed literal surface, at most 256 Unicode codepoints; analyzed FTS co-occurrence, never regex or FTS syntax; partial token loss warns while using the analyzed terms" }), { minItems: 1, maxItems: 4 }), { minItems: 1, maxItems: 5, description: "Concept groups with OR alternatives; all surfaces together at most 2048 Unicode codepoints" }),
      match: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")], { description: "Default any: one group suffices. all: every group must match the same record; co-occurrence is not phrase matching." })),
      exclude: Type.Optional(Type.Array(Type.String({ description: "Hard exclusion analyzed by the same FTS compiler; partial token loss warns, any match removes the entire record" }), { maxItems: 5 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results on this page (default 50)" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Result offset (default 0); use nextOffset from the previous page" })),
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
