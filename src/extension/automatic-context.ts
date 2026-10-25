import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SQLiteBackgroundIndex } from "../worker/sqlite-background-index.mjs";
import { withLocators, locatorText, formatLocatorRows } from "../history/locator.mjs";
import { recallTiming, measured } from "../observability/timing.mjs";
import { displayRows } from "../search/sqlite-page.mjs";
import { branch, observe } from "./operations.ts";

const RECENT_USER_MESSAGES = 2;

export function registerAutomaticContext(pi: ExtensionAPI, index: SQLiteBackgroundIndex) {
  pi.on("context", (event, ctx) => observe("auto_context_total", async () => {
    const entries = branch(ctx);
    const user = event.messages.findLastIndex(message => message.role === "user");
    const query = user >= 0 ? measured(recallTiming, "query_text_extraction", () => locatorText(event.messages[user])) : "";
    const recentUserTexts: string[] = [];
    for (let at = user - 1; at >= 0 && recentUserTexts.length < RECENT_USER_MESSAGES; at--) {
      if (event.messages[at].role === "user") recentUserTexts.push(locatorText(event.messages[at]));
    }
    const found = user >= 0 ? await index.queryRanked(query, entries, { mode: "auto", options: { limit: 5, recentUserTexts } }) : { results: [] };
    const content = formatLocatorRows(displayRows(found.results));
    return { messages: withLocators(event.messages, entries, () => content) };
  }));
}
