import { Type } from "typebox";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { MAX_HITS, MAX_EXPAND_CHARS, searchableEntryText, compactedEntries, toRegExp } from "../history/history.mjs";
import { recallTiming, measured } from "../observability/timing.mjs";
import { branch, observe } from "../extension/operations.ts";
import { codePointLength } from "./unicode.ts";
import { grepSnippet, unchangedSourceRanges } from "./grep-snippets.ts";

export function registerGrep(pi: ExtensionAPI, mode: "full" | "lite") {
  pi.registerTool({
    name: "history_grep",
    label: "History grep",
    description:
      mode === "full" ? "Supplementary text-search fallback when automatic locators, history_recall and expanded entries leave insufficient evidence. Search branch-effective user/assistant text and assistant tool-call names/arguments on the current compacted branch, honoring context edits; exclude toolResult bodies, thinking and images. No matches do not prove absence. `pattern` is a case-insensitive JavaScript regular expression (not SQL LIKE); invalid patterns fall back to literal search. Pages matching entries in branch order: limit defaults to 30 (maximum 50), offset defaults to 0. Use nextOffset with the same pattern and unchanged branch; returned counts entries consumed, including explicitly skipped oversized metadata. total counts raw regex matches, totalEntries matching entries; covered counts other matches visible in this page's snippets, omitted counts raw matches not shown anywhere in this response. Each page shows up to 30 representative snippets overall and at most 3 per entry; full output stays within 16000 Unicode codepoints. Clipped-out text is not covered. Read full text with history_expand or use a narrower pattern to find matching context not shown." :
      "Search compacted conversation history when you need earlier evidence; use history_expand to verify matching entry ids. " +
      "Search branch-effective user/assistant text and assistant tool-call names/arguments on the current compacted branch, honoring context edits; exclude toolResult bodies, thinking and images. No matches do not prove absence. " +
      "`pattern` is a case-insensitive JavaScript regular expression (not SQL LIKE); invalid patterns fall back to literal search. " +
      "Pages matching entries in branch order: limit defaults to 30 (maximum 50), offset defaults to 0. Use nextOffset with the same pattern and unchanged branch; returned counts entries consumed, including explicitly skipped oversized metadata. total counts raw regex matches, totalEntries matching entries; covered counts other matches visible in this page's snippets, omitted counts raw matches not shown anywhere in this response. " +
      "Each page shows up to 30 representative snippets overall and at most 3 per entry; full output stays within 16000 Unicode codepoints. Clipped-out text is not covered. " +
      "Read full text with history_expand or use a narrower pattern to find matching context not shown.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Case-insensitive JavaScript regular expression" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum matching entries on this page (default 30)" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Matching-entry offset (default 0); use nextOffset to continue" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return observe("tool_history_grep_total", () => {
        const branchEntries = measured(recallTiming, "branch_selection_projection", () => compactedEntries(branch(ctx)));
        const rx = toRegExp(params.pattern);
        const matching: { entry: SessionEntry; text: string; count: number }[] = [];
        let total = 0;
        measured(recallTiming, "grep_scan", () => {
          for (const entry of branchEntries) {
            const source = measured(recallTiming, "text_extraction", () => searchableEntryText(entry));
            if (source === undefined) continue;
            let count = 0;
            for (const _match of source.matchAll(rx)) count++;
            if (count) {
              matching.push({ entry, text: source, count });
              total += count;
            }
          }
        });
        return measured(recallTiming, "grep_pagination_render", () => {

          const limit = params.limit ?? 30;
          const offset = Math.min(params.offset ?? 0, matching.length);
          const requested = matching.slice(offset, offset + limit);
          const rendered: { prefix: string; text: string; matches: { occurrence: number; start: number; end: number }[]; visible: { start: number; end: number; includeStart: boolean; includeEnd: boolean }[]; displayed: { occurrence: number; start: number; end: number }[]; shown: number }[] = [];
          let metadataSkipped = false;
          for (const item of requested) {
            const { entry, text: source } = item;
            const role = entry.type === "message" ? entry.message.role : entry.type;
            const prefix = `[${entry.id}] ${entry.timestamp.slice(0, 10)} ${role}: `;
            if (codePointLength(prefix) > 140) {
              rendered.push({ prefix: "", text: "", matches: [], visible: [], displayed: [], shown: 0 });
              continue;
            }
            const matches: { occurrence: number; start: number; end: number }[] = [];
            let occurrence = 0;
            let scanUtf16 = 0;
            let scanPoints = 0;
            const pointOffset = (target: number, roundUp = false) => {
              while (scanUtf16 < target) {
                const code = source.charCodeAt(scanUtf16);
                const paired = code >= 0xd800 && code <= 0xdbff && scanUtf16 + 1 < source.length &&
                  source.charCodeAt(scanUtf16 + 1) >= 0xdc00 && source.charCodeAt(scanUtf16 + 1) <= 0xdfff;
                if (paired && scanUtf16 + 1 >= target) return scanPoints + Number(roundUp);
                scanUtf16 += paired ? 2 : 1;
                scanPoints++;
              }
              return scanPoints;
            };
            for (const match of source.matchAll(toRegExp(params.pattern))) {
              const at = match.index ?? 0;
              matches.push({ occurrence: occurrence++, start: pointOffset(at), end: pointOffset(at + match[0].length, true) });
            }
            rendered.push({ prefix, text: source, matches, visible: [], displayed: [], shown: 0 });
          }

          const lines: string[] = [];
          let consumed = 0;
          let snippets = 0;
          let outputBlocked = false;
          const status = (next: number | null, more: boolean) => `[page offset=${offset} returned=${consumed} total=${total} totalEntries=${matching.length} limit=${limit} nextOffset=${next ?? "null"} hasMore=${more}]`;
          let covered = total;
          let omitted = total;
          const headFor = (next: number | null, more: boolean) => total === 0
            ? `No matches in compacted history. ${status(next, more)}`
            : `${total} matches in ${matching.length} entries; ${consumed} entries consumed, ${snippets} representative snippets shown. Matches covered by this page's snippets: ${covered}; raw matches not shown anywhere in this response: ${omitted}. ${metadataSkipped ? "Entries with oversized metadata were skipped. " : ""}Use nextOffset to continue; history_expand reads full text. ${status(next, more)}`;
          const append = (line: string, onAppend: () => void): boolean => {
            const moreIfAppended = offset + consumed < matching.length;
            const proposed = [headFor(moreIfAppended ? offset + consumed : null, moreIfAppended), ...lines, line].join("\n");
            if (codePointLength(proposed) > MAX_EXPAND_CHARS) return false;
            lines.push(line);
            onAppend();
            return true;
          };
          for (let i = 0; i < rendered.length; i++) {
            if (snippets >= MAX_HITS) break;
            const item = rendered[i];
            if (!item.prefix) {
              metadataSkipped = true;
              consumed++;
              continue;
            }
            const match = item.matches.find((candidate) => !item.visible.some((range) => candidate.start === candidate.end
              ? (candidate.start > range.start && candidate.start < range.end) ||
              (candidate.start === range.start && range.includeStart) || (candidate.start === range.end && range.includeEnd)
              : candidate.start >= range.start && candidate.end <= range.end));
            if (!match) {
              consumed++;
              continue;
            }
            const snippet = grepSnippet(item.text, match.start, match.end, codePointLength(item.text), 500 - codePointLength(item.prefix));
            if (!append(item.prefix + snippet.text, () => {
              item.visible.push(...unchangedSourceRanges(item.text, snippet.visible));
              item.displayed.push(match);
              item.shown++;
              snippets++;
            })) {
              outputBlocked = true;
              break;
            }
            consumed++;
          }
          if (!outputBlocked) {
            for (const item of rendered.slice(0, consumed)) {
              if (!item.prefix) continue;
              for (const match of item.matches) {
                if (item.displayed.some((shown) => shown.occurrence === match.occurrence)) continue;
                if (item.shown >= 3 || snippets >= MAX_HITS) break;
                const covered = item.visible.some((range) => match.start === match.end
                  ? (match.start > range.start && match.start < range.end) ||
                  (match.start === range.start && range.includeStart) || (match.start === range.end && range.includeEnd)
                  : match.start >= range.start && match.end <= range.end);
                if (covered) continue;
                const snippet = grepSnippet(item.text, match.start, match.end, codePointLength(item.text), 500 - codePointLength(item.prefix));
                if (!append(item.prefix + snippet.text, () => {
                  item.visible.push(...unchangedSourceRanges(item.text, snippet.visible));
                  item.displayed.push(match);
                  item.shown++;
                  snippets++;
                })) break;
              }
            }
          }
          let pageCovered = 0;
          for (let i = 0; i < consumed; i++) {
            const item = rendered[i];
            if (!item.prefix) continue;
            for (const match of item.matches) {
              const representative = item.displayed.some((shown) => shown.occurrence === match.occurrence);
              const visible = item.visible.some((range) => match.start === match.end
                ? (match.start > range.start && match.start < range.end) ||
                (match.start === range.start && range.includeStart) || (match.start === range.end && range.includeEnd)
                : match.start >= range.start && match.end <= range.end);
              if (!representative && visible) pageCovered++;
            }
          }
          covered = pageCovered;
          omitted = total - snippets - covered;
          const nextOffset = offset + consumed < matching.length ? offset + consumed : null;
          const hasMore = nextOffset !== null;
          const head = headFor(nextOffset, hasMore);
          return {
            content: [{ type: "text" as const, text: [head, ...lines].join("\n") }], details: {
              total, totalEntries: matching.length, offset, limit, returned: consumed, nextOffset, hasMore,
              snippets, covered, omitted, metadataSkipped,
            }
          };
        });
      });
    },
  });
}
