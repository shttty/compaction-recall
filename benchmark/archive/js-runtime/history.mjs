// @ts-check
// Pure current-branch history helpers. No storage, hooks or model calls.
/** @typedef {import("@earendil-works/pi-coding-agent").ContextEditEntry} ContextEditEntry */
/** @typedef {import("@earendil-works/pi-coding-agent").SessionEntry} SessionEntry */

export const MAX_HITS = 30;
export const SNIPPET = 160;
export const MAX_EXPAND_CHARS = 16000;

/** @typedef {{ role?: unknown; content?: unknown }} ReadableMessage */

/**
 * Canonical JSON for tool inputs; no size truncation or invocation of custom toJSON methods.
 * @param {unknown} value
 * @returns {string}
 */
function argumentJSON(value) {
  /** @type {Set<object>} */
  const ancestors = new Set();
  /** @param {unknown} input @returns {unknown} */
  const stable = (input) => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
    if (typeof input === "bigint") return String(input);
    if (typeof input !== "object") return `[Unsupported ${typeof input}]`;
    if (ancestors.has(input)) return "[Circular]";
    ancestors.add(input);
    /** @type {unknown} */
    let result;
    if (Array.isArray(input)) result = input.map(stable);
    else {
      /** @type {Record<string, unknown>} */
      const record = Object.create(null);
      for (const key of Object.keys(input).sort()) record[key] = stable(/** @type {Record<string, unknown>} */ (input)[key]);
      result = record;
    }
    ancestors.delete(input);
    return result;
  };
  try { return JSON.stringify(stable(value)); }
  catch { return "[Unserializable tool arguments]"; }
}

/**
 * Readable expansion: text and assistant tool inputs; toolResult text remains readable here.
 * @param {ReadableMessage | null | undefined} m
 * @returns {string}
 */
export function messageText(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  /** @type {string[]} */
  const parts = [];
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

/**
 * Undefined marks an excluded record, distinct from an eligible empty-text message.
 * @param {ReadableMessage | null | undefined} m
 * @returns {string | undefined}
 */
export function searchableMessageText(m) {
  if (!m || (m.role !== "user" && m.role !== "assistant")) return undefined;
  return messageText(m);
}

/** @param {SessionEntry} e @returns {string | undefined} */
export function searchableEntryText(e) {
  return e.type === "message" ? searchableMessageText(e.message) : undefined;
}

/** @param {SessionEntry} e @returns {string} */
export function entryText(e) {
  return e.type === "message" ? messageText(e.message) : "";
}

/**
 * Apply the latest branch-local edits, including edits after the requested raw-entry boundary.
 * @param {SessionEntry[]} branch
 * @param {number} [end]
 * @returns {SessionEntry[]}
 */
export function branchMessageEntries(branch, end = branch.length) {
  /** @type {Map<string, ContextEditEntry["replacement"]>} */
  const edits = new Map();
  for (const entry of branch) {
    if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
  }
  /** @type {SessionEntry[]} */
  const entries = [];
  for (let i = 0; i < end; i++) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const replacement = edits.get(entry.id);
    if (replacement === null) continue;
    const { message } = entry;
    if (replacement === undefined ||
      (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult")) {
      entries.push(entry);
      continue;
    }
    // Match Pi 1.0 projectContextEntry, without its compaction-aware history exclusion.
    const content = message.role !== "user" && typeof replacement.content === "string"
      ? [{ type: /** @type {const} */ ("text"), text: replacement.content }]
      : replacement.content;
    entries.push({ ...entry, message: /** @type {typeof message} */ ({ ...message, content }) });
  }
  return entries;
}

/**
 * Message entries that the latest compaction moved out of the live context (oldest first).
 * @param {SessionEntry[]} branch
 * @returns {SessionEntry[]}
 */
export function compactedEntries(branch) {
  let latest = -1;
  for (let i = branch.length - 1; i >= 0; i--) if (branch[i].type === "compaction") { latest = i; break; }
  if (latest < 0) return [];
  const c = branch[latest];
  const kept = c.type === "compaction" ? branch.findIndex((e) => e.id === c.firstKeptEntryId) : -1;
  // Resolve the boundary on raw entries: omitting firstKeptEntryId must not widen history.
  return branchMessageEntries(branch, kept < 0 ? latest : kept);
}

/** @param {string} pattern @returns {RegExp} */
export function toRegExp(pattern) {
  try {
    return new RegExp(pattern, "gi");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }
}

