import { closeSync, fchmodSync, openSync, writeSync } from 'node:fs';

const snapshot = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const key = (sessionId, toolCallId) => JSON.stringify([sessionId, toolCallId]);

/** Content-bearing diagnostics, deliberately separate from the timing allowlist.
 * SDK 1.0.0: MessageEndEvent.message is AgentMessage; assistant content contains
 * TextContent and ToolCall {id, name, arguments}. ToolCallEvent.input is mutable;
 * parentToolCallId identifies nested calls (extensions/types.d.ts).
 * @param {{enabled?: boolean, path?: string, warn?: (message: string) => void, inputFields?: string[]}} options
 */
export function createRecallTrace({ enabled = false, path = process.env.COMPACTION_RECALL_TIMING_FILE, warn = () => {}, inputFields } = {}) {
  if (!enabled) return undefined;
  if (!path) {
    warn('compaction-recall: trace enabled without COMPACTION_RECALL_TIMING_FILE; trace disabled');
    return undefined;
  }
  const models = new Map(), parents = new Map(), counts = new Map(), failedModels = new Set();
  const selectInput = params => Object.fromEntries(inputFields.map(field => [field, params?.[field]]));
  const pending = new Set();
  return {
    messageEnd(sessionId, message) {
      if (message.role !== 'assistant') return;
      const textBlocks = message.content.filter(block => block.type === 'text').map(block => block.text);
      for (const block of message.content) {
        if (block.type === 'toolCall' && block.name === 'history_recall') {
          const id = key(sessionId, block.id);
          try { models.set(id, { arguments: snapshot(block.arguments), textBlocks }); }
          catch { failedModels.add(id); /* Unserializable diagnostics must not affect execution. */ }
        }
      }
    },
    toolCall(sessionId, event) {
      if (event.toolName === 'history_recall' && event.parentToolCallId) {
        parents.set(key(sessionId, event.toolCallId), event.parentToolCallId);
      }
    },
    begin(sessionId, toolCallId, params) {
      const callIndex = (counts.get(sessionId) ?? 0) + 1;
      counts.set(sessionId, callIndex);
      try {
        const token = {
          type: 'history_recall_trace', sessionId, callIndex, toolCallId,
          parentToolCallId: null, model: null,
          execute: inputFields ? { params: snapshot(params), input: snapshot(selectInput(params)) }
            : { params: snapshot(params), query: snapshot(params.query) },
          ...(inputFields ? { input_identical: null } : { query_identical: null }), result: null, error: null,
        };
        pending.add(token);
        return token;
      } catch { return undefined; /* Drop this event, not the tool call. */ }
    },
    complete(token, result) {
      if (!token) return;
      try { token.result = snapshot(result); } catch { pending.delete(token); }
    },
    fail(token, error) {
      if (!token) return;
      try {
        token.error = inputFields
          ? snapshot({ name: error instanceof Error ? error.name : 'Error', code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) })
          : error instanceof Error ? error.message : String(error);
      }
      catch { pending.delete(token); }
    },
    // agent_end/shutdown are correlation boundaries, not tool completion: message_end
    // can arrive after execute. Do not infer missing model arguments from params.
    flush() {
      const events = [...pending].filter(event => !failedModels.has(key(event.sessionId, event.toolCallId)));
      pending.clear();
      for (const event of events) {
        const id = key(event.sessionId, event.toolCallId);
        event.parentToolCallId = parents.get(id) ?? event.toolCallId.match(/^(.*)\/\d+$/)?.[1] ?? null;
        event.model = event.parentToolCallId ? null : models.get(id) ?? null;
        if (inputFields) {
          event.input_identical = event.model === null ? null
            : JSON.stringify(snapshot(selectInput(event.model.arguments))) === JSON.stringify(event.execute.input);
        } else {
          const modelQuery = event.model?.arguments?.query;
          event.query_identical = event.model === null ? null
            : typeof modelQuery === 'string' && typeof event.execute.query === 'string'
              ? modelQuery === event.execute.query
              : JSON.stringify(modelQuery) === JSON.stringify(event.execute.query);
        }
      }
      models.clear();
      parents.clear();
      failedModels.clear();
      if (!events.length) return;
      let fd;
      try {
        fd = openSync(path, 'a', 0o600);
        fchmodSync(fd, 0o600);
        for (const event of events) writeSync(fd, JSON.stringify(event) + '\n');
      } catch { /* Diagnostics must not change tool results or errors. */ }
      finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Output-neutral. */ } } }
    },
  };
}
