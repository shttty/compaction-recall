// Native SDK/RPC; persist only serialized tier and newly observed response usage.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../sdk-rpc.mjs';

const phase = process.argv[process.argv.indexOf('--phase') + 1];
const sessionAt = process.argv.indexOf('--session');
const sessionPath = sessionAt < 0 ? null : process.argv[sessionAt + 1];
const appendAt = process.argv.indexOf('--append-system-prompt');
let appendSystemPrompt = '';
if (appendAt >= 0) {
  appendSystemPrompt = readFileSync(process.argv[appendAt + 1], 'utf8');
  process.argv.splice(appendAt, 2);
}
const persist = (name, value) => {
  if (!sessionPath) throw new Error('Wire evidence requires a session');
  appendFileSync(join(dirname(sessionPath), name), JSON.stringify(value) + '\n', { mode: 0o600 });
};

export function observeNativeRuntime({ modelRuntime, phase: selected }) {
  const original = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (model, context, options = {}) => {
    const returned = original(model, context, {
      ...options,
      onPayload: async payload => {
        const changed = options.onPayload ? await options.onPayload(payload, model) : undefined;
        const actual = changed ?? payload;
        const effort = actual?.reasoning_effort ?? actual?.reasoning?.effort;
        if (effort !== selected.effort || model.provider !== selected.provider || model.id !== selected.model) {
          throw new Error('Serialized native provider/model/effort differs');
        }
        persist('wire-requests.jsonl', { phase, provider: model.provider, model: model.id, effort,
          maxOutputTokens: actual?.max_output_tokens ?? actual?.max_tokens ?? null, source: 'onPayload' });
        return changed;
      },
    });
    void (async () => {
      const stream = await returned;
      const response = await stream.result();
      persist('wire-results.jsonl', { phase, provider: response.provider, model: response.model,
        stopReason: response.stopReason, usage: response.usage ?? null });
    })().catch(() => { /* Missing observations remain unknown; no payload/error text is copied. */ });
    return returned;
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main({ appendSystemPrompt, configureModelRuntime: observeNativeRuntime });
}
