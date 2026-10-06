// Native SDK/RPC: observe provider bodies only, never transport headers or credentials.
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../sdk-rpc.mjs';
import { saveNativeToolEvidence, STOP_AFTER_SERIALIZATION } from './round2-tools.mjs';
import { persistContextPayload } from './round3-context.mjs';

function observerOptions(argv) {
  const options = {};
  for (const [flag, key] of [['--tool-evidence', 'evidencePath'], ['--expected-tools', 'expectedPath'],
    ['--append-system-prompt', 'appendSystemPromptPath']]) {
    const at = argv.indexOf(flag);
    if (at < 0) continue;
    const value = argv[at + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`);
    options[key] = value;
    argv.splice(at, 2);
  }
  const stopAt = argv.indexOf('--stop-after-serialization');
  options.stopAfterSerialization = stopAt >= 0;
  if (stopAt >= 0) argv.splice(stopAt, 1);
  const value = flag => { const at = argv.indexOf(flag); return at < 0 ? undefined : argv[at + 1]; };
  options.sessionPath = value('--session');
  options.phaseName = value('--phase');
  options.native = value('--arm') === 'native';
  if ((options.evidencePath || options.expectedPath || options.stopAfterSerialization) && !options.native) {
    throw new Error('Native serialization evidence requires --arm native');
  }
  if ((options.expectedPath || options.stopAfterSerialization) && !options.evidencePath) {
    throw new Error('Native serialization preflight requires --tool-evidence');
  }
  return options;
}

export function observeNativeRuntime({ modelRuntime, phase: selected }, options) {
  const { sessionPath, phaseName, native, evidencePath, expectedPath, stopAfterSerialization = false } = options;
  const directory = sessionPath && dirname(sessionPath);
  const persist = (name, value) => {
    if (!directory) throw new Error('Wire evidence requires a session');
    const filename = join(directory, name);
    appendFileSync(filename, JSON.stringify(value) + '\n', { mode: 0o600 });
    chmodSync(filename, 0o600);
  };
  const original = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (model, context, options = {}) => {
    const returned = original(model, context, {
      ...options,
      onPayload: async payload => {
        const changed = options.onPayload ? await options.onPayload(payload, model) : undefined;
        const actual = changed ?? payload;
        const serializedEffort = actual?.reasoning_effort ?? actual?.reasoning?.effort ?? null;
        const effort = serializedEffort ?? (selected.effort === 'off' ? 'off' : null);
        if (effort !== selected.effort || model.provider !== selected.provider || model.id !== selected.model) {
          throw new Error('Serialized native provider/model/effort differs');
        }
        if (!directory) throw new Error('Wire evidence requires a session');
        if (native && evidencePath) {
          persistContextPayload(actual, { directory, toolsOnly: true, source: 'onPayload', runtime: { model, effort } });
          saveNativeToolEvidence(actual, { evidencePath, expectedPath });
        }
        let request = 1;
        while (existsSync(join(directory, `wire-payload-${String(request).padStart(4, '0')}.json`))) request++;
        const payloadFile = `wire-payload-${String(request).padStart(4, '0')}.json`;
        writeFileSync(join(directory, payloadFile), JSON.stringify(actual), { flag: 'wx', mode: 0o600 });
        persist('wire-requests.jsonl', { phase: phaseName, provider: model.provider, model: model.id, effort,
          serializedEffort, maxOutputTokens: actual?.max_output_tokens ?? actual?.max_completion_tokens ?? actual?.max_tokens ?? null,
          contextWindow: model.contextWindow, modelMaxTokens: model.maxTokens, payloadFile, source: 'onPayload' });
        if (stopAfterSerialization) {
          process.stderr.write(`${STOP_AFTER_SERIALIZATION}\n`);
          process.exit(2);
        }
        return changed;
      },
    });
    void (async () => {
      const stream = await returned;
      const response = await stream.result();
      persist('wire-results.jsonl', { phase: phaseName, provider: response.provider, model: response.model,
        stopReason: response.stopReason, usage: response.usage ?? null });
    })().catch(() => { /* Missing observations remain unknown; no payload/error text is copied. */ });
    return returned;
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = observerOptions(process.argv);
  const appendSystemPrompt = options.appendSystemPromptPath ? readFileSync(options.appendSystemPromptPath, 'utf8') : '';
  await main({ appendSystemPrompt, configureModelRuntime: runtime => observeNativeRuntime(runtime, options) });
}
