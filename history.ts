// Pure current-branch history helpers. No storage, hooks or model calls.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const MAX_HITS = 30;
export const SNIPPET = 160;
export const MAX_EXPAND_CHARS = 16000;

export function entryText(e: SessionEntry): string {
  if (e.type !== "message") return "";
  const m = e.message;
  if (!("content" in m)) return "";
  if (typeof m.content === "string") return m.content;
  const parts: string[] = [];
  for (const b of m.content) if ("text" in b && typeof b.text === "string") parts.push(b.text);
  return parts.join("\n");
}

/** Message entries that the latest compaction moved out of the live context (oldest first). */
export function compactedEntries(branch: SessionEntry[]): SessionEntry[] {
  let latest = -1;
  for (let i = branch.length - 1; i >= 0; i--) if (branch[i].type === "compaction") { latest = i; break; }
  if (latest < 0) return [];
  const c = branch[latest];
  const kept = c.type === "compaction" ? branch.findIndex((e) => e.id === c.firstKeptEntryId) : -1;
  return branch.slice(0, kept < 0 ? latest : kept).filter((e) => e.type === "message");
}

export function toRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "gi");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }
}

