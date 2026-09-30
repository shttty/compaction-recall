// Pure current-branch history helpers. No storage, hooks or model calls.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const MAX_HITS = 30;
export const SNIPPET = 160;
export const MAX_EXPAND_CHARS = 16000;

type ReadableMessage = { role?: unknown; content?: unknown };

/** Canonical JSON for tool inputs; no size truncation or invocation of custom toJSON methods. */
function argumentJSON(value: unknown): string {
  const ancestors = new Set<object>();
  const stable = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
    if (typeof input === "bigint") return String(input);
    if (typeof input !== "object") return `[Unsupported ${typeof input}]`;
    if (ancestors.has(input)) return "[Circular]";
    ancestors.add(input);
    let result: unknown;
    if (Array.isArray(input)) result = input.map(stable);
    else {
      const record: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(input).sort()) record[key] = stable((input as Record<string, unknown>)[key]);
      result = record;
    }
    ancestors.delete(input);
    return result;
  };
  try { return JSON.stringify(stable(value)); }
  catch { return "[Unserializable tool arguments]"; }
}

/** Readable expansion: text and assistant tool inputs; toolResult text remains readable here. */
export function messageText(m: ReadableMessage | null | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  const parts: string[] = [];
  for (const b of m.content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (m.role === "assistant" && b.type === "toolCall") {
      const name = typeof b.name === "string" ? b.name : "(unnamed)";
      parts.push(`Tool call ${JSON.stringify(name)}\nArguments ${argumentJSON(b.arguments)}`);
    }
  }
  return parts.join("\n");
}

/** Undefined marks an excluded record, distinct from an eligible empty-text message. */
export function searchableMessageText(m: ReadableMessage | null | undefined): string | undefined {
  if (!m || (m.role !== "user" && m.role !== "assistant")) return undefined;
  return messageText(m);
}

export function searchableEntryText(e: SessionEntry): string | undefined {
  return e.type === "message" ? searchableMessageText(e.message) : undefined;
}

export function entryText(e: SessionEntry): string {
  return e.type === "message" ? messageText(e.message) : "";
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

