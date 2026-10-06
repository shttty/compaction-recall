import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SQLiteBackgroundIndex } from "../worker/sqlite-background-index.mjs";
import { withLocators, locatorText, formatLocatorRows } from "../history/locator.mjs";
import { recallTiming, measured } from "../observability/timing.mjs";
import { displayRows, SQLITE_LOCATOR_HEADER } from "../search/sqlite-page.mjs";
import { branch, observe } from "./operations.ts";

export function registerAutomaticContext(pi: ExtensionAPI, index: SQLiteBackgroundIndex) {
  pi.on("context", (event, ctx) => observe("auto_context_total", async () => {
    const entries = branch(ctx);
    const user = event.messages.findLast(message => message.role === "user");
    const query = user ? measured(recallTiming, "query_text_extraction", () => locatorText(user)) : "";
    const found = user ? await index.queryRanked(query, entries, { mode: "auto", options: { limit: 5 } }) : { results: [] };
    const content = formatLocatorRows(displayRows(found.results), SQLITE_LOCATOR_HEADER);
    return { messages: withLocators(event.messages, entries, () => content) };
  }));
}
