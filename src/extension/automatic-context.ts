import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SQLiteBackgroundIndex } from "../worker/sqlite-background-index.mjs";
import { HINT_ENTRY_TYPE, hintRecords, withHints, locatorText, formatLocatorRows } from "../history/locator.mjs";
import { recallTiming, measured } from "../observability/timing.mjs";
import { displayRows } from "../sqlite/sqlite-page.mjs";
import { branch, observe } from "./operations.ts";

const RECENT_USER_MESSAGES = 2;

export function registerAutomaticContext(pi: ExtensionAPI, index: SQLiteBackgroundIndex) {
  // Text sent by other sessions or extensions (input source "extension") is recorded without a hint.
  const extensionInputs = new Set<string>();
  pi.on("input", event => { if (event.source === "extension") extensionInputs.add(event.text); });
  pi.on("context", (event, ctx) => observe("auto_context_total", async () => {
    const entries = branch(ctx);
    const records = hintRecords(entries);
    const user = event.messages.findLastIndex(message => message.role === "user");
    const last = user >= 0 ? event.messages[user] : undefined;
    // Each user message is looked up once; its record replays the same bytes on every later request.
    if (last?.role === "user" && !records.has(last.timestamp)) {
      const query = measured(recallTiming, "query_text_extraction", () => locatorText(last));
      let content: string | null = null;
      if (!extensionInputs.delete(query)) {
        const recentUserTexts: string[] = [];
        for (let at = user - 1; at >= 0 && recentUserTexts.length < RECENT_USER_MESSAGES; at--) {
          if (event.messages[at].role === "user") recentUserTexts.push(locatorText(event.messages[at]));
        }
        const found = await index.queryRanked(query, entries, { mode: "auto", options: { limit: 5, recentUserTexts } });
        content = formatLocatorRows(displayRows(found.results)) ?? null;
      }
      pi.appendEntry(HINT_ENTRY_TYPE, { timestamp: last.timestamp, content });
      records.set(last.timestamp, content);
    }
    return { messages: withHints(event.messages, records) };
  }));
}
