import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recallTiming, flushTiming, measured } from "../observability/timing.mjs";

export const branch = (ctx: ExtensionContext) => measured(recallTiming, "branch_copy", () => ctx.sessionManager.getBranch());
export const observe = async <T>(stage: string, work: () => T | Promise<T>): Promise<T> => {
  try { return recallTiming ? await recallTiming.runAsync(stage, work) : await work(); }
  finally { flushTiming(); }
};
