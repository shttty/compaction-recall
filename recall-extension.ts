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

function codePointOffset(text: string, utf16Offset: number, roundUp = false): number {
  let points = 0;
  for (let i = 0; i < utf16Offset; points++) {
    const code = text.charCodeAt(i);
    const paired = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff;
    if (paired && i + 1 >= utf16Offset) return points + Number(roundUp);
    i += paired ? 2 : 1;
  }
  return points;
}

function grepSnippet(text: string, start: number, end: number, budget: number): string {
  const total = codePointLength(text);
  let context = SNIPPET;
  let before = codePointSlice(text, Math.max(0, start - context), Math.min(context, start));
  let after = codePointSlice(text, end, Math.min(context, total - end));
  if (end - start + codePointLength(before) + codePointLength(after) <= budget) {
    return (before + codePointSlice(text, start, end - start) + after).replace(/\s+/g, " ");
  }

  context = 32;
  before = codePointSlice(text, Math.max(0, start - context), Math.min(context, start));
  after = codePointSlice(text, end, Math.min(context, total - end));
  const marker = "[snippet clipped]";
  const matchBudget = Math.max(0, budget - codePointLength(before) - codePointLength(after) - codePointLength(marker) - 4);
  const first = Math.ceil(matchBudget / 2);
  const last = Math.floor(matchBudget / 2);
  return `${before}…${codePointSlice(text, start, first)}${marker}${codePointSlice(text, Math.max(start, end - last), last)}…${after}`.replace(/\s+/g, " ");
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
      "alternation for synonyms, e.g. `5K|5 km|personal best`. Results are bounded to 16000 Unicode codepoints; snippets may be clipped and matches omitted from display. " +
      "Read full text with history_expand or use a narrower pattern to find remaining matches.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Case-insensitive JavaScript regular expression" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rx = toRegExp(params.pattern);
      const lines: string[] = [];
      let metadataSkipped = false;
      let total = 0;
      for (const e of compactedEntries(ctx.sessionManager.getBranch())) {
        const text = searchableEntryText(e);
        if (text === undefined) continue;
        let shown = 0;
        for (const m of text.matchAll(rx)) {
          total += 1;
          if (lines.length >= MAX_HITS || shown >= 3) continue;
          shown += 1;
          const role = e.type === "message" ? e.message.role : e.type;
          const prefix = `[${e.id}] ${e.timestamp.slice(0, 10)} ${role}: `;
          if (codePointLength(prefix) > 140) {
            metadataSkipped = true;
            continue;
          }
          const lineBudget = 500 - codePointLength(prefix);
          const i = m.index ?? 0;
          const start = codePointOffset(text, i);
          const end = codePointOffset(text, i + m[0].length, true);
          lines.push(prefix + grepSnippet(text, start, end, lineBudget));
        }
      }
      const head = total === 0
        ? "No matches in compacted history."
        : `${total} matches (showing ${lines.length}).${total > lines.length ? " Some matches omitted from display; use a narrower pattern for remaining matches." : ""}${metadataSkipped ? " Entries with oversized metadata were skipped." : ""} Use history_expand for full text.`;
      return { content: [{ type: "text", text: [head, ...lines].join("\n") }], details: { total } };
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
