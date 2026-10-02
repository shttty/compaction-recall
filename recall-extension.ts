// pi-recall tool registration; retained as the historical lme-bench entry point.
import { Type } from "typebox";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { MAX_HITS, SNIPPET, MAX_EXPAND_CHARS, entryText, searchableEntryText, compactedEntries, toRegExp } from "./history.ts";

import { buildRecallPage, withLocators } from "./locator.ts";

function codePointLength(text: string): number {
  let length = 0;
  for (const _point of text) length++;
  return length;
}

function codePointSlice(text: string, offset: number, limit: number): string {
  if (limit <= 0) return "";
  let start = 0;
  let end = 0;
  let index = 0;
  for (const point of text) {
    if (index === offset) start = end;
    end += point.length;
    index++;
    if (index === offset + limit) break;
  }
  if (offset >= index) start = end;
  return text.slice(start, end);
}


function grepSnippet(text: string, start: number, end: number, total: number, budget: number): { text: string; visible: { start: number; end: number }[] } {
  let context = SNIPPET;
  let before = codePointSlice(text, Math.max(0, start - context), Math.min(context, start));
  let after = codePointSlice(text, end, Math.min(context, total - end));
  if (end - start + codePointLength(before) + codePointLength(after) <= budget) {
    return {
      text: (before + codePointSlice(text, start, end - start) + after).replace(/\s+/g, " "),
      visible: [{ start: Math.max(0, start - context), end: Math.min(total, end + context) }],
    };
  }

  context = 32;
  before = codePointSlice(text, Math.max(0, start - context), Math.min(context, start));
  after = codePointSlice(text, end, Math.min(context, total - end));
  const marker = "[snippet clipped]";
  const matchBudget = Math.max(0, budget - codePointLength(before) - codePointLength(after) - codePointLength(marker) - 4);
  const first = Math.ceil(matchBudget / 2);
  const last = Math.floor(matchBudget / 2);
  const tailStart = Math.max(start, end - last);
  return {
    text: `${before}…${codePointSlice(text, start, first)}${marker}${codePointSlice(text, tailStart, last)}…${after}`.replace(/\s+/g, " "),
    visible: [
      { start: Math.max(0, start - context), end: Math.min(total, start + first) },
      { start: tailStart, end: Math.min(total, end + context) },
    ],
  };
}

function expandHeader(e: SessionEntry, requested: boolean): string {
  const role = e.type === "message" ? e.message.role : e.type;
  return `--- [${e.id}] ${e.timestamp} ${role}${requested ? " (requested)" : ""}\n`;
}

export default function(pi: ExtensionAPI) {
  pi.on("context", (event, ctx) => ({
    messages: withLocators(event.messages, ctx.sessionManager.getBranch()),
  }));
  pi.registerTool({
    name: "history_recall",
    label: "History recall",
    description:
      "Primary keyword lookup of compacted conversation history on the current branch. " +
      "Honors the latest branch-local context edits: omitted entries are unavailable and replacements hide original content. " +
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
      "Search branch-effective user/assistant text and assistant tool-call names/arguments on the current compacted branch, honoring context edits; exclude toolResult bodies, thinking and images. No matches do not prove absence. " +
      "`pattern` is a case-insensitive JavaScript regular expression (not SQL LIKE); use " +
      "alternation for synonyms, e.g. `5K|5 km|personal best`. Results are bounded to 16000 Unicode codepoints and show up to 30 representative snippets, at most 3 per entry; all regex matches are counted, including matches already visible in another snippet. Clipped-out text is not covered. " +
      "Read full text with history_expand or use a narrower pattern to find matching context not shown.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Case-insensitive JavaScript regular expression" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rx = toRegExp(params.pattern);
      const lines: string[] = [];
      let metadataSkipped = false;
      let total = 0;
      let coveredMatches = 0;
      let omitted = 0;
      for (const e of compactedEntries(ctx.sessionManager.getBranch())) {
        const text = searchableEntryText(e);
        if (text === undefined) continue;
        const totalPoints = codePointLength(text);
        let shown = 0;
        const visible: { start: number; end: number }[] = [];
        let scanUtf16 = 0;
        let scanPoints = 0;
        const pointOffset = (target: number, roundUp = false) => {
          while (scanUtf16 < target) {
            const code = text.charCodeAt(scanUtf16);
            const paired = code >= 0xd800 && code <= 0xdbff && scanUtf16 + 1 < text.length &&
              text.charCodeAt(scanUtf16 + 1) >= 0xdc00 && text.charCodeAt(scanUtf16 + 1) <= 0xdfff;
            if (paired && scanUtf16 + 1 >= target) return scanPoints + Number(roundUp);
            scanUtf16 += paired ? 2 : 1;
            scanPoints++;
          }
          return scanPoints;
        };
        for (const m of text.matchAll(rx)) {
          total += 1;
          const i = m.index ?? 0;
          const start = pointOffset(i);
          const end = pointOffset(i + m[0].length, true);
          const alreadyVisible = visible.some((range) => start === end
            ? start >= range.start && start <= range.end
            : start >= range.start && end <= range.end);
          if (alreadyVisible) {
            coveredMatches += 1;
            continue;
          }
          if (lines.length >= MAX_HITS || shown >= 3) {
            omitted += 1;
            continue;
          }
          const role = e.type === "message" ? e.message.role : e.type;
          const prefix = `[${e.id}] ${e.timestamp.slice(0, 10)} ${role}: `;
          if (codePointLength(prefix) > 140) {
            metadataSkipped = true;
            omitted += 1;
            continue;
          }
          const snippet = grepSnippet(text, start, end, totalPoints, 500 - codePointLength(prefix));
          lines.push(prefix + snippet.text);
          visible.push(...snippet.visible);
          shown += 1;
        }
      }
      const head = total === 0
        ? "No matches in compacted history."
        : `${total} matches; ${lines.length} representative snippets shown (${coveredMatches} matches already visible in those snippets${omitted ? `, ${omitted} other matches not shown` : ""}).${omitted ? " Some matching context may be unseen; use a narrower pattern or history_expand to read full text." : " Use history_expand to read full text."}${metadataSkipped ? " Entries with oversized metadata were skipped." : ""}`;
      return { content: [{ type: "text", text: [head, ...lines].join("\n") }], details: { total, snippets: lines.length, covered: coveredMatches, omitted } };
    },
  });

  pi.registerTool({
    name: "history_expand",
    label: "History expand",
    description:
      "Read branch-effective text (honoring context edits) of a compacted history entry by id (from automatic locators, history_recall or history_grep). The requested entry is shown first; output is bounded to 16000 Unicode codepoints. " +
      "Use offset (default 0), in Unicode codepoints of the requested entry, to continue a long entry; when hasMore is true, pass nextOffset with the same id and before/after values. Neighbor entries (before/after default 2, maximum 20) are included only when the full target is shown and each full neighbor fits. " +
      "Includes tool-call names/arguments and readable toolResult text; excludes thinking and images. Only the current compacted branch is readable.",
    parameters: Type.Object({
      id: Type.String({ description: "Entry id from automatic locators, history_recall or history_grep" }),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries before (default 2)" })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries after (default 2)" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Unicode codepoint offset within the requested entry (default 0); use nextOffset to continue" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const entries = compactedEntries(ctx.sessionManager.getBranch());
      const at = entries.findIndex((e) => e.id === params.id);
      if (at < 0) return { content: [{ type: "text", text: `No compacted entry with id ${params.id}.` }], details: {} };

      const target = entries[at];
      const targetText = entryText(target);
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
        content: [{ type: "text", text: out }],
        details: { from: entries[from].id, to: entries[to].id, offset, total, returned, nextOffset, hasMore },
      };
    },
  });
}
