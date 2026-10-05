#!/usr/bin/env node
import { constants, openSync, closeSync, writeSync, readFileSync, realpathSync, statSync, fstatSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { findPackageJSON } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const ARTIFACTS = '/home/rinne/.hermes/task-runs/recall-soft-match-20261003/research/structured-tool-query';
const START = { timestamp: new Date().toISOString(), clock: performance.now(), memory: process.memoryUsage(), maxRSSKiB: process.resourceUsage().maxRSS };
const SYSTEM = '请根据用户的请求，使用提供的检索工具执行一次搜索。不要回答检索之外的问题。';
const HELP = `Usage: node prototype/structured-tool-query/model-trial.mjs
  --profile PATH --output PATH --provider clp --model gpt-6-luna --effort high

       Add --describe to resolve identity/auth availability without model calls or writes;
       --output is not required in --describe mode.
All five values are required; authorized models are gpt-6-astra or gpt-6-luna, with high effort.
--profile is passed only to SDK read-only auth and model configuration loaders.
--output is an append-only JSONL file inside:
  ${ARTIFACTS}
Six fixed independent Chinese requests; one native Agent turn per request.
No retry, follow-up, judge, built-in tools, extensions, context files or history.
No profile writes, catalog network, command credentials or OAuth refresh.
--help imports no SDK, reads no profile, writes nothing and makes no requests.
`;

function inside(filename, directory) {
  const relative = path.relative(directory, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}
function fingerprint(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}
function isolate(home) {
  const keep = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ']);
  for (const name of Object.keys(process.env)) if (!keep.has(name)) delete process.env[name];
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'), TMPDIR: home, PI_OFFLINE: '1', DO_NOT_TRACK: '1',
  });
}
function forbidCommands(config) {
  const values = [config?.apiKey, ...Object.values(config?.headers ?? {})];
  for (const model of config?.models ?? []) values.push(...Object.values(model.headers ?? {}));
  for (const model of Object.values(config?.modelOverrides ?? {})) values.push(...Object.values(model.headers ?? {}));
  if (values.some(value => typeof value === 'string' && value.startsWith('!'))) {
    throw new Error('Command-based model credentials or headers are disabled');
  }
  if (config?.oauth === 'radius') throw new Error('Radius OAuth configuration is not supported by this read-only trial');
}
function safeError(error) {
  // Provider errors can echo headers/payloads. Do not persist their messages or stacks.
  return { name: error?.name === 'AbortError' ? 'AbortError' : 'Error', message: 'Operation failed; private SDK error text suppressed' };
}
function tokenSemantics(api) {
  const openai = ['openai-responses', 'openai-completions', 'openai-codex-responses', 'azure-openai-responses'].includes(api);
  return {
    fields: 'SDK normalized usage: input, output, cacheRead, cacheWrite, optional cacheWrite1h/reasoning, totalTokens; original SDK usage retained.',
    input: openai ? 'Uncached input: SDK subtracts cacheRead and cacheWrite from provider input/prompt tokens; do not subtract them again.' : 'SDK normalized input; provider-specific cache inclusion not inferred for this API.',
    reasoning: 'When reported, reasoning is a subset of output, not additional tokens.',
    totalTokens: 'SDK/provider total retained, not context length; failed attempts without observed usage have unknown consumption.',
    cost: 'usage.cost is SDK catalog arithmetic only, not verified billing. Actual prices and incurred cost are unknown; no pricing calculation is performed.',
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean' }, describe: { type: 'boolean' }, profile: { type: 'string' }, output: { type: 'string' },
    provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
  }, strict: true, allowPositionals: false });
  if (values.help) { process.stdout.write(HELP); return; }
  for (const name of ['profile', 'provider', 'model', 'effort']) required(values[name], `--${name}`);
  if (!values.describe) required(values.output, '--output');
  if (values.provider !== 'clp' || !['gpt-6-astra', 'gpt-6-luna'].includes(values.model) || values.effort !== 'high') {
    throw new Error('Requires explicit --provider clp --model gpt-6-astra|gpt-6-luna --effort high');
  }
  const profile = realpathSync(path.resolve(values.profile));
  if (!statSync(profile).isDirectory()) throw new Error('--profile must be a directory');
  const artifacts = realpathSync(ARTIFACTS);
  const output = values.output ? path.resolve(values.output) : undefined;
  if (output && (!inside(output, artifacts) || (!inside(realpathSync(path.dirname(output)), artifacts) && path.dirname(output) !== artifacts))) {
    throw new Error('--output must be inside the authorized artifact directory (existing parent required)');
  }
  if (profile === artifacts || inside(profile, artifacts) || inside(artifacts, profile)) {
    throw new Error('Profile and artifact directory must be disjoint');
  }
  for (const name of ['auth.json', 'models.json']) {
    if (!statSync(path.join(profile, name)).isFile()) throw new Error(`SDK profile requires ${name}`);
  }
  const requestsPath = path.join(HERE, 'model-requests.json');
  const requests = JSON.parse(readFileSync(requestsPath, 'utf8'));
  if (!Array.isArray(requests) || requests.length !== 6 || new Set(requests.map(item => item.id)).size !== 6 ||
      requests.some(item => Object.keys(item).sort().join(',') !== 'id,request' || typeof item.id !== 'string' || typeof item.request !== 'string' || !item.request.trim())) {
    throw new Error('Fixed requests must contain six unique id/request objects');
  }
  const fd = values.describe ? undefined : openSync(output, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  if (fd !== undefined && !fstatSync(fd).isFile()) { closeSync(fd); throw new Error('--output must be a regular file'); }
  const runId = randomUUID();
  const record = (type, data) => { if (fd !== undefined) writeSync(fd, `${JSON.stringify({ runId, type, recordedAt: new Date().toISOString(), ...data })}\n`); };
  let home, index, timer, stage = 'setup';
  let samples = 0;
  const maxima = { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 };
  function memory() {
    const current = process.memoryUsage();
    samples++;
    for (const key of Object.keys(maxima)) maxima[key] = Math.max(maxima[key], current[key]);
    return { ...current, maxRSSKiB: process.resourceUsage().maxRSS };
  }
  const totals = { modelCalls: 0, modelErrors: 0, toolCalls: 0, toolErrors: 0, cases: 0, peakActiveModelCalls: 0 };
  try {
    record('run_start', {
      identity: 'RSM-STRUCTURED-QUERY-PROTOTYPE-20261005', processStartedAt: START.timestamp,
      node: process.version, sqlite: process.versions.sqlite ?? null, platform: process.platform,
      requested: { provider: values.provider, model: values.model, effort: values.effort },
      requests, systemInstruction: SYSTEM,
      sourceSHA256: Object.fromEntries(['index.mjs', 'demo.mjs', 'model-trial.mjs', 'model-requests.json'].map(name => [name, fingerprint(path.join(HERE, name))])),
      memoryAtStart: START.memory, maxRSSAtStartKiB: START.maxRSSKiB,
      policy: { generationsPerCase: 1, retries: 0, concurrency: 1, finalJudge: false, finalAnswerScores: 'not applicable', price: null, memoryLimitBytes: null },
    });
    home = values.describe ? path.join(artifacts, `.structured-describe-${runId}`) : mkdtempSync(path.join(artifacts, '.structured-model-runtime-'));
    isolate(home);
    if (!values.describe) process.chdir(home);
    timer = setInterval(memory, 50);
    timer.unref();
    memory();
    const sdkEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const sdkDir = path.dirname(path.dirname(sdkEntry));
    if (!inside(realpathSync(sdkDir), realpathSync(path.join(ROOT, 'node_modules')))) throw new Error('SDK must be installed in this worktree');
    const sdkPackage = JSON.parse(readFileSync(path.join(sdkDir, 'package.json'), 'utf8'));
    if (sdkPackage.version !== '1.0.0') throw new Error('Requires installed Pi SDK 1.0.0');
    const agentPackage = findPackageJSON('@earendil-works/pi-agent-core', pathToFileURL(sdkEntry));
    const aiPackage = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(sdkEntry));
    const agentEntry = JSON.parse(readFileSync(agentPackage, 'utf8')).exports['.'].import;
    const compatEntry = JSON.parse(readFileSync(aiPackage, 'utf8')).exports['./compat'].import;
    const { ModelRuntime } = await import(pathToFileURL(sdkEntry).href);
    const { Agent } = await import(new URL(agentEntry, pathToFileURL(agentPackage)).href);
    const { getSupportedThinkingLevels } = await import(new URL(compatEntry, pathToFileURL(aiPackage)).href);
    const { ReadOnlyAuthStorage } = await import(pathToFileURL(path.join(sdkDir, 'dist/core/auth-storage.js')).href);
    const { InMemoryCodingAgentModelsStore } = await import(pathToFileURL(path.join(sdkDir, 'dist/core/models-store.js')).href);
    class TrialAuthStorage extends ReadOnlyAuthStorage {
      async read(providerId, options) {
        const credential = await super.read(providerId, options);
        if (credential?.type === 'api_key' && credential.key?.startsWith('!')) throw new Error('Command credentials disabled');
        if (credential?.type === 'oauth' && Date.now() + 5 * 60 * 1000 >= credential.expires) throw new Error('OAuth refresh disabled');
        return credential;
      }
    }
    stage = 'credentials_metadata';
    const credentials = new TrialAuthStorage(path.join(profile, 'auth.json'));
    await credentials.list(); // Metadata only; never log credential values.
    stage = 'model_runtime';
    const runtime = await ModelRuntime.create({ credentials, modelsPath: path.join(profile, 'models.json'),
      modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
    if (runtime.getError()) throw new Error('Invalid model profile');
    stage = 'provider_command_policy';
    forbidCommands(runtime.getRegisteredProviderConfig(values.provider));
    stage = 'exact_model_resolution';
    const model = runtime.getPhysicalModel(values.provider, values.model);
    if (!model || model.provider !== values.provider || model.id !== values.model) throw new Error('SDK cannot resolve exact physical provider/model');
    stage = 'effort_validation';
    if (!getSupportedThinkingLevels(model).includes(values.effort)) throw new Error('SDK model does not support requested effort');
    stage = 'auth_availability';
    if (!await runtime.checkAuth(model.provider)) throw new Error('SDK cannot resolve authorized credentials');
    if (values.describe) {
      process.stdout.write(`${JSON.stringify({ provider: model.provider, model: model.id, effort: values.effort, api: model.api, sdkVersion: sdkPackage.version, authAvailable: true })}\n`);
      return;
    }
    record('model_resolved', { provider: model.provider, model: model.id, effort: values.effort, api: model.api,
      sdkVersion: sdkPackage.version, contextWindow: model.contextWindow, maxTokens: model.maxTokens, tokenSemantics: tokenSemantics(model.api) });
    const { createIndex, createTool } = await import('./index.mjs');
    const { documents } = await import('./demo.mjs');
    const buildStart = performance.now(), beforeBuild = memory();
    index = createIndex(documents);
    const nativeTool = createTool(index);
    record('index_built', { corpusSize: documents.length, buildMs: performance.now() - buildStart, beforeBuild, afterBuild: memory(),
      tool: { name: nativeTool.name, description: nativeTool.description, parameters: nativeTool.parameters } });
    for (const request of requests) {
      stage = request.id;
      const startedAt = new Date().toISOString(), began = performance.now(), before = memory();
      const calls = [], responses = [], assistants = [], usageObservations = [];
      let modelCallCount = 0, failure = null, modelStartedAt = null, modelBegan = null;
      const tool = { ...nativeTool, async execute(toolCallId, params, ...rest) {
        const call = { toolCallId, arguments: structuredClone(params), startedAt: new Date().toISOString(), before: memory() };
        calls.push(call);
        const start = performance.now();
        try {
          const result = await nativeTool.execute(toolCallId, params, ...rest);
          call.output = result;
          return result;
        } catch (error) {
          call.error = safeError(error);
          throw error;
        } finally {
          call.durationMs = performance.now() - start;
          call.finishedAt = new Date().toISOString();
          call.after = memory();
        }
      } };
      const agent = new Agent({
        initialState: { model, thinkingLevel: values.effort, systemPrompt: SYSTEM, tools: [tool], messages: [] },
        toolExecution: 'sequential', finishTurn: () => ({ action: 'end' }),
        streamFn: (resolved, context, options) => {
          if (++modelCallCount !== 1) throw new Error('Single-generation guard violated');
          totals.modelCalls++;
          totals.peakActiveModelCalls = 1;
          modelStartedAt = new Date().toISOString();
          modelBegan = performance.now();
          return runtime.streamSimple(resolved, context, { ...options, maxRetries: 0, transport: 'sse', timeoutMs: 180000,
            onResponse: (response, actual) => responses.push({ status: response.status, provider: actual.provider, model: actual.id, at: new Date().toISOString() }),
            onProviderStreamEvent: data => {
              const usage = data?.usage ?? data?.response?.usage;
              if (usage) usageObservations.push(structuredClone(usage));
            },
          });
        },
      });
      const toolResults = [];
      agent.subscribe(event => {
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const message = event.message;
          assistants.push({ provider: message.provider, model: message.model, responseModel: message.responseModel ?? null,
            api: message.api, thinkingLevel: message.thinkingLevel ?? null, providerThinkingLevel: message.providerThinkingLevel ?? null,
            stopReason: message.stopReason, timestamp: message.timestamp, usage: message.usage,
            startedAt: modelStartedAt, finishedAt: new Date().toISOString(), durationMs: modelBegan === null ? null : performance.now() - modelBegan,
            content: message.content.filter(block => block.type !== 'thinking'), error: message.errorMessage ? safeError(null) : null });
        }
        if (event.type === 'tool_execution_end') toolResults.push({ toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError });
      });
      const timeout = setTimeout(() => agent.abort(), 180000);
      try { await agent.prompt(request.request); }
      catch (error) { failure = safeError(error); }
      finally { clearTimeout(timeout); }
      const failed = !!failure || assistants.some(message => ['error', 'aborted'].includes(message.stopReason));
      totals.modelErrors += failed ? 1 : 0;
      totals.toolCalls += toolResults.length;
      totals.toolErrors += toolResults.filter(result => result.isError).length;
      totals.cases++;
      record('case', { id: request.id, request: request.request, startedAt, finishedAt: new Date().toISOString(),
        durationMs: performance.now() - began, modelCallCount, assistants, providerUsageObservations: usageObservations,
        responses, calls, toolResults, failure, before, after: memory(),
        missingToolCall: !assistants.some(message => message.content.some(block => block.type === 'toolCall')),
      });
    }
    if (totals.modelErrors || totals.toolErrors) process.exitCode = 1;
  } catch (error) {
    record('run_error', { stage, error: safeError(error) });
    process.stderr.write(`model-trial: ${values.describe ? 'describe/preflight' : 'run'} failed at ${stage}; private SDK diagnostic suppressed.\n`);
    process.exitCode = 1;
  } finally {
    clearInterval(timer);
    index?.close();
    if (home && !values.describe) { process.chdir(ROOT); rmSync(home, { recursive: true, force: true }); }
    record('run_end', { finishedAt: new Date().toISOString(), durationMs: performance.now() - START.clock, totals,
      memoryAtEnd: memory(), sampledMaxBytes: maxima, memorySamples: samples,
      accounting: 'Wall time includes setup/SDK import/index/model/tool/cleanup after runner start. 50ms samples and boundary samples are not exact simultaneous peaks. maxRSSKiB is Linux OS process-lifetime high-water RSS, not incremental index memory. RSS/heap/external overlap and must not be summed. No forced GC. No worker/subprocess/cgroup/process-tree peak measured. Tool duration is native execute only, not SQL-only; native schema-validation failures have no execute duration. Model/tool failures without usage remain unknown consumption; provider usage observations may repeat and must not be summed. SDK cost is not actual billing. No final-answer/judge scores.',
    });
    if (fd !== undefined) closeSync(fd);
  }
  process.stdout.write(`${JSON.stringify({ runId, output, ...totals })}\n`);
}

main().catch(() => {
  // CLI/preflight paths may contain credential-adjacent SDK diagnostics: never print raw errors.
  process.stderr.write('model-trial: invalid CLI or inaccessible/unsafe paths; use --help. No private error text is printed.\n');
  process.exitCode = 1;
});
