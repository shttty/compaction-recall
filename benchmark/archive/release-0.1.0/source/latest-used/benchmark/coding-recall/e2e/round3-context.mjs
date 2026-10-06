import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCATOR_TYPE = 'compaction-recall:compacted-locators:v1';
const HEADER = 'Compacted-history locators (lexical hints only).';

// Benchmark observer only: never change messages, tools, or plugin hook results.
export function withContextEvidence(pi, { directory, toolsOnly }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let locators = [], request = 0;
  pi.on('before_provider_request', event => {
    try {
      const messages = event.payload?.input ?? event.payload?.messages;
      if (!Array.isArray(messages)) throw new Error('Missing serialized provider messages');
      // Recall tool results contain the same header; only user messages can be hints.
      const serializedLocators = messages.filter(message => message.role === 'user'
        && JSON.stringify(message.content).includes(HEADER));
      if (toolsOnly && (locators.length || serializedLocators.length)) throw new Error('Tools-only locator leak');
      if (locators.some(locator => !serializedLocators.some(message => JSON.stringify(message.content)
        .includes(JSON.stringify(locator.content).slice(1, -1))))) throw new Error('Locator serialization mismatch');
      const descriptor = openSync(join(directory, `context-${String(++request).padStart(4, '0')}.json`), 'wx', 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ source: 'before_provider_request', nativeLocators: locators,
          serializedLocatorCount: serializedLocators.length, messages }));
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
    } catch {
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
