import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCATOR_TYPE = 'compaction-recall:compacted-locators:v1';
const HEADER = 'Compacted-history locators (lexical hints only).';

export function persistContextPayload(payload, { directory, toolsOnly, nativeLocators = [], source = 'before_provider_request', runtime }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const messages = payload?.input ?? payload?.messages;
  if (!Array.isArray(messages)) throw new Error('Missing serialized provider messages');
  // Recall tool results contain the same header; only user messages can be hints.
  const serializedLocators = messages.filter(message => message.role === 'user'
    && JSON.stringify(message.content).includes(HEADER));
  if (toolsOnly && (nativeLocators.length || serializedLocators.length)) throw new Error('Tools-only locator leak');
  if (nativeLocators.some(locator => !serializedLocators.some(message => JSON.stringify(message.content)
    .includes(JSON.stringify(locator.content).slice(1, -1))))) throw new Error('Locator serialization mismatch');
  let request = 1;
  while (existsSync(join(directory, `context-${String(request).padStart(4, '0')}.json`))) request++;
  const suffix = String(request).padStart(4, '0');
  for (const [name, value] of [[`payload-${suffix}.json`, payload], [`context-${suffix}.json`, {
    source, nativeLocators, serializedLocatorCount: serializedLocators.length, messages,
  }], [`request-runtime-${suffix}.json`, { source, provider: runtime?.model?.provider ?? null,
    model: payload?.model ?? runtime?.model?.id ?? null,
    effort: payload?.reasoning_effort ?? payload?.reasoning?.effort ?? runtime?.effort ?? null,
    maxOutputTokens: payload?.max_output_tokens ?? payload?.max_completion_tokens ?? payload?.max_tokens ?? null,
    contextWindow: runtime?.model?.contextWindow ?? null, modelMaxTokens: runtime?.model?.maxTokens ?? null }]]) {
    const descriptor = openSync(join(directory, name), 'wx', 0o600);
    try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
  }
}

// Benchmark observer only: never change messages, tools, or plugin hook results.
// Compose withToolEvidence(withContextEvidence(pi, ...), ...) so context is saved before a preflight stop.
export function withContextEvidence(pi, { directory, toolsOnly }) {
  let locators = [];
  pi.on('before_provider_request', (event, ctx) => {
    try { persistContextPayload(event.payload, { directory, toolsOnly, nativeLocators: locators,
      runtime: { model: ctx?.model, effort: pi.getThinkingLevel?.() } }); }
    catch {
      process.stderr.write('ROUND3_CONTEXT_EVIDENCE_FAILED\n');
      process.exit(2);
    }
  });
  return new Proxy(pi, {
    get(target, property) {
      if (property === 'on') return (name, handler) => target.on(name, name === 'context'
        ? async (event, ctx) => {
          const result = await handler(event, ctx);
          locators = (result?.messages ?? event.messages).filter(message => message.role === 'custom'
            && message.customType === LOCATOR_TYPE);
          return result;
        } : handler);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
