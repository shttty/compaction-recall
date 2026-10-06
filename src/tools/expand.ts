import { Type } from "typebox";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { MAX_EXPAND_CHARS, entryText, compactedEntries } from "../history/history.mjs";
import { recallTiming, measured } from "../observability/timing.mjs";
import { branch, observe } from "../extension/operations.ts";
import { codePointLength, codePointSlice } from "./unicode.ts";

function expandHeader(e: SessionEntry, requested: boolean): string {
  const role = e.type === "message" ? e.message.role : e.type;
  return `--- [${e.id}] ${e.timestamp} ${role}${requested ? " (requested)" : ""}\n`;
}

export function registerExpand(pi: ExtensionAPI, mode: "full" | "lite") {
  pi.registerTool({
    name: "history_expand",
    label: "History expand",
    description:
      mode === "full" ? "Read branch-effective text (honoring context edits) of a compacted history entry by id from automatic locators, history_recall or history_grep. The requested entry is shown first; output is bounded to 16000 Unicode codepoints. Use offset (default 0), in Unicode codepoints of the requested entry, to continue a long entry; when hasMore is true, pass nextOffset with the same id and before/after values. Neighbor entries (before/after default 2, maximum 20) are included only when the full target is shown and each full neighbor fits. Includes tool-call names/arguments and readable toolResult text; excludes thinking and images. Only the current compacted branch is readable. If evidence remains insufficient after expanding, history_grep can supplement the search." :
      "Read branch-effective text (honoring context edits) of a compacted history entry by id from history_grep. The requested entry is shown first; output is bounded to 16000 Unicode codepoints. " +
      "Use offset (default 0), in Unicode codepoints of the requested entry, to continue a long entry; when hasMore is true, pass nextOffset with the same id and before/after values. Neighbor entries (before/after default 2, maximum 20) are included only when the full target is shown and each full neighbor fits. " +
      "Includes tool-call names/arguments and readable toolResult text; excludes thinking and images. Only the current compacted branch is readable.",
    parameters: Type.Object({
      id: Type.String({ description: mode === "lite" ? "Entry id from history_grep" : "Entry id from automatic locators, history_recall or history_grep" }),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries before (default 2)" })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries after (default 2)" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Unicode codepoint offset within the requested entry (default 0); use nextOffset to continue" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return observe("tool_history_expand_total", () => measured(recallTiming, "expand", () => {
        const entries = measured(recallTiming, "branch_selection_projection", () => compactedEntries(branch(ctx)));
        const at = entries.findIndex((e) => e.id === params.id);
        if (at < 0) return { content: [{ type: "text" as const, text: `No compacted entry with id ${params.id}.` }], details: {} };

        const target = entries[at];
        const targetText = measured(recallTiming, "text_extraction", () => entryText(target));
        const total = codePointLength(targetText);
        const offset = Math.min(params.offset ?? 0, total);
        const header = expandHeader(target, true);
        const statusReserve = codePointLength(`\n[page offset=${Number.MAX_SAFE_INTEGER} returned=${Number.MAX_SAFE_INTEGER} total=${Number.MAX_SAFE_INTEGER} nextOffset=${Number.MAX_SAFE_INTEGER} hasMore=true]`);
        const available = Math.max(0, MAX_EXPAND_CHARS - codePointLength(header) - statusReserve);
        const pageText = codePointSlice(targetText, offset, available);
        const returned = codePointLength(pageText);
        const nextOffset = offset + returned;
        const hasMore = nextOffset < total;
        let out = header + pageText;
        let from = at;
        let to = at;

        if (!hasMore && offset === 0) {
          const neighbors = [
            ...entries.slice(Math.max(0, at - (params.before ?? 2)), at).reverse(),
            ...entries.slice(at + 1, Math.min(entries.length, at + (params.after ?? 2) + 1)),
          ];
          for (const neighbor of neighbors) {
            const section = `\n${expandHeader(neighbor, false)}${entryText(neighbor)}`;
            if (codePointLength(out) + codePointLength(section) + statusReserve > MAX_EXPAND_CHARS) break;
            out += section;
            from = Math.min(from, entries.indexOf(neighbor));
            to = Math.max(to, entries.indexOf(neighbor));
          }
        }
        const pageInfo = `\n[page offset=${offset} returned=${returned} total=${total} nextOffset=${nextOffset} hasMore=${hasMore}]`;
        out += pageInfo;

        return {
          content: [{ type: "text" as const, text: out }],
          details: { from: entries[from].id, to: entries[to].id, offset, total, returned, nextOffset, hasMore },
        };
      }));
    },
  });
}
