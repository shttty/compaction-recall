// Generated evaluation model definitions contain no auth/header/baseUrl values.
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { main } from '../../sdk-rpc.mjs';

const configPath = resolve(process.argv[process.argv.indexOf('--config') + 1]);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const output = resolve(dirname(configPath), config.output_dir);
const sessionAt = process.argv.indexOf('--session');
const sessionPath = sessionAt < 0 ? null : resolve(process.argv[sessionAt + 1]);
if (sessionPath && !sessionPath.startsWith(output + '/')) throw new Error('Judge session must stay in configured output');

export async function configureJudgeModel({ modelRuntime, phase }) {
  if (phase.model === 'gpt-6-luna' && phase.effort === 'xhigh') {
    const existing = modelRuntime.getModel(phase.provider, phase.model);
    if (!existing) throw new Error('Configured Luna model missing');
    // Only public, noncredential definition fields. Provider auth remains host-owned.
    const definition = Object.fromEntries(['id', 'name', 'api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens'].map(key => [key, existing[key]]));
    definition.thinkingLevelMap = { xhigh: 'xhigh' };
    const ownModels = { providers: { [phase.provider]: { models: [definition] } } };
    const filename = join(output, 'models-override.json');
    const text = JSON.stringify(ownModels, null, 2) + '\n';
    if (existsSync(filename) && readFileSync(filename, 'utf8') !== text) throw new Error('Generated model override changed');
    if (!existsSync(filename)) writeFileSync(filename, text, { mode: 0o600 });
    modelRuntime.registerProvider(phase.provider, { models: ownModels.providers[phase.provider].models });
    if (modelRuntime.getError()) throw new Error('Generated Luna definition rejected');
  }
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (model, context, options = {}) => streamSimple(model, context, {
    ...options,
    onPayload: async payload => {
      const observer = options.onPayload;
      const changed = observer ? await observer(payload, model) : undefined;
      const serialized = changed ?? payload;
      const effort = serialized?.reasoning_effort ?? serialized?.reasoning?.effort;
      if (effort !== phase.effort || model.provider !== phase.provider || model.id !== phase.model) {
        throw new Error('Serialized judge provider/model/effort differs from requested selection');
      }
      if (!sessionPath) throw new Error('Provider request requires explicit judge session');
      const directory = dirname(sessionPath);
      let request = 1;
      while (existsSync(join(directory, `wire-payload-${String(request).padStart(4, '0')}.json`))) request++;
      const payloadFile = `wire-payload-${String(request).padStart(4, '0')}.json`;
      // onPayload is the provider JSON body, not headers or credential-bearing request options.
      writeFileSync(join(directory, payloadFile), JSON.stringify(serialized), { flag: 'wx', mode: 0o600 });
      const wireFile = join(directory, 'wire-requests.jsonl');
      appendFileSync(wireFile, JSON.stringify({ phase: 'judge', provider: model.provider, model: model.id,
        api: model.api, effort, contextWindow: model.contextWindow, modelMaxTokens: model.maxTokens,
        maxOutputTokens: serialized?.max_output_tokens ?? serialized?.max_completion_tokens ?? serialized?.max_tokens ?? null,
        payloadFile, source: 'onPayload' }) + '\n', { mode: 0o600 });
      chmodSync(wireFile, 0o600);
      const effortFile = join(directory, 'effort-evidence.json');
      writeFileSync(effortFile, JSON.stringify({ effort, source: 'onPayload' }), { mode: 0o600 });
      chmodSync(effortFile, 0o600);
      return changed;
    },
  });
}

await main({ configureModelRuntime: configureJudgeModel });
