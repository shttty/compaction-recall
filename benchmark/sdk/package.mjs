#!/usr/bin/env node
// Harness-only observers around native SDK loading. Package descriptors and hook results are unchanged.
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './session.mjs';
import { persistContextPayload } from './context-evidence.mjs';
import { STOP_AFTER_SERIALIZATION } from './tools-evidence.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const definition = tool => JSON.parse(JSON.stringify({ name: tool.name, description: tool.description,
  parameters: tool.parameters ?? tool.input_schema }));
const ordered = tools => tools.map(definition).sort((a, b) => a.name.localeCompare(b.name));
const errorText = error => error instanceof Error ? error.message : String(error);

function observerOptions(argv) {
  const options = {};
  for (const [flag, key] of [['--tool-evidence', 'evidencePath'], ['--expected-tools', 'expectedPath'],
    ['--append-system-prompt', 'appendSystemPromptPath']]) {
    const at = argv.indexOf(flag);
    if (at < 0) continue;
    const value = argv[at + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`);
    options[key] = resolve(value);
    argv.splice(at, 2);
  }
  const stopAt = argv.indexOf('--stop-after-serialization');
  options.stopAfterSerialization = stopAt >= 0;
  if (stopAt >= 0) argv.splice(stopAt, 1);
  const value = flag => { const at = argv.indexOf(flag); return at < 0 ? undefined : argv[at + 1]; };
  options.phaseName = value('--phase');
  options.packageRoots = argv.flatMap((flag, index) => flag === '--plugin-dir' ? [argv[index + 1]] : []);
  if ((options.evidencePath || options.expectedPath || options.appendSystemPromptPath || options.stopAfterSerialization)
    && options.phaseName !== 'answer') throw new Error('Package serialization flags are answer-only');
  if (!argv.includes('--help') && value('--arm') !== 'package') throw new Error('Package observer requires --arm package');
  return options;
}

export function createPackageObserver(options = {}) {
  const appendSystemPrompt = options.appendSystemPrompt ?? '';
  let observed;
  let identity;
  let rawQuestion = null;
  let request = 0;
  const wrappedTools = new WeakSet();
  const wrappedHooks = new WeakMap();
  const directory = () => dirname(observed.sessionPath);
  const save = (filename, record) => {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    writeFileSync(filename, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    chmodSync(filename, 0o600);
  };
  const persist = (name, record) => {
    const filename = join(directory(), name);
    appendFileSync(filename, JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
    chmodSync(filename, 0o600);
  };
  const registered = () => ordered(observed.extensions.extensions.flatMap(extension =>
    [...extension.tools.values()].map(tool => tool.definition)));
  const registration = () => save(join(directory(), 'sdk-registration.json'), { ...identity, tools: registered(),
    extensions: observed.extensions.extensions.map(extension => ({ path: extension.path,
      entrySha256: digest(readFileSync(extension.path)),
      hooks: [...extension.handlers].map(([name, handlers]) => ({ name, count: handlers.length })),
      tools: ordered([...extension.tools.values()].map(tool => tool.definition)) })) });

  function wrapTool(extension, tool) {
    const original = tool.definition.execute;
    if (typeof original !== 'function' || wrappedTools.has(original)) return;
    const wrapped = async function (...args) {
      const startedAt = new Date().toISOString();
      const start = performance.now();
      let result, error = null;
      try { result = await original.apply(this, args); return result; }
      catch (caught) { error = errorText(caught); throw caught; }
      finally { persist('tool-execution.jsonl', { extension: extension.path, name: tool.definition.name,
        callId: args[0], params: args[1], startedAt, endedAt: new Date().toISOString(),
        milliseconds: performance.now() - start, result: result ?? null, error }); }
    };
    wrappedTools.add(wrapped);
    tool.definition.execute = wrapped;
  }
  function wrapHook(extension, name, original) {
    let byEvent = wrappedHooks.get(original);
    if (!byEvent) { byEvent = new Map(); wrappedHooks.set(original, byEvent); }
    if (byEvent.has(name)) return byEvent.get(name);
    const wrapped = async function (...args) {
      const startedAt = new Date().toISOString();
      const start = performance.now();
      let result, error = null;
      try { result = await original.apply(this, args); return result; }
      catch (caught) { error = errorText(caught); throw caught; }
      finally {
        const record = { extension: extension.path, event: name, startedAt, endedAt: new Date().toISOString(),
          milliseconds: performance.now() - start, result: result ?? null, error };
        persist('extension-hooks.jsonl', record);
        if (name === 'session_start') registration();
        if (name === 'session_before_compact') persist('compaction-hooks.jsonl', { ...record,
          fromExtension: !!result?.compaction, compaction: result?.compaction ?? null,
          summaryLength: result?.compaction?.summary?.length ?? null,
          firstKeptEntryId: result?.compaction?.firstKeptEntryId ?? null,
          tokensBefore: result?.compaction?.tokensBefore ?? null, details: result?.compaction?.details ?? null });
        if (name === 'before_agent_start' && result) persist('resume-injection.jsonl', record);
      }
    };
    byEvent.set(name, wrapped);
    return wrapped;
  }

  async function observeExtensions(runtime) {
    observed = runtime;
    const products = (options.packageRoots ?? []).map(root => {
      const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      return { name: metadata.name ?? null, version: metadata.version ?? null,
        declaredExtensions: metadata.pi?.extensions ?? [], declaredSkills: metadata.pi?.skills ?? [] };
    });
    identity = { ...(products.length === 1 ? { product: products[0] } : { products }),
      home: runtime.home, sdkPath: runtime.sdkPath, phase: runtime.phaseName,
      configuredModel: { provider: runtime.phase.provider, model: runtime.phase.model, effort: runtime.phase.effort },
      skills: runtime.resourceLoader.getSkills().skills.map(skill => ({ name: skill.name, path: skill.filePath,
        sha256: digest(readFileSync(skill.filePath)) })), loader: 'SDK native jiti; no custom aliases or package shims' };
    for (const name of ['compaction-hooks.jsonl', 'compaction-events.jsonl', 'tool-execution.jsonl']) {
      const filename = join(directory(), name);
      if (!existsSync(filename)) writeFileSync(filename, '', { flag: 'wx', mode: 0o600 });
    }
    for (const extension of runtime.extensions.extensions) {
      // Intercept Map.set before registerTool calls refreshTools, including session_start registration.
      const setTool = extension.tools.set;
      extension.tools.set = function (name, tool) { wrapTool(extension, tool); return setTool.call(this, name, tool); };
      for (const tool of extension.tools.values()) wrapTool(extension, tool);
      // SDK snapshots handlers with slice(). Keep originals in-place so unsubscribe/order still work.
      const observeList = (name, handlers) => {
        handlers.slice = function (...args) { return Array.prototype.slice.apply(this, args)
          .map(handler => wrapHook(extension, name, handler)); };
        return handlers;
      };
      const setHandlers = extension.handlers.set;
      extension.handlers.set = function (name, handlers) { return setHandlers.call(this, name, observeList(name, handlers)); };
      for (const [name, handlers] of extension.handlers) observeList(name, handlers);
    }
    registration();
  }

  function observeSession(runtime) {
    observed = runtime;
    configureModelRuntime(runtime);
    const prompt = runtime.session.prompt;
    runtime.session.prompt = function (text, ...args) { rawQuestion = text; return prompt.call(this, text, ...args); };
    runtime.session.subscribe(event => {
      if (event.type === 'compaction_end' && !event.aborted && event.result) {
        const entry = runtime.session.sessionManager.getEntries().findLast(entry => entry.type === 'compaction');
        persist('compaction-events.jsonl', { event: 'session_compact', source: 'saved_session_entry',
          fromExtension: entry?.fromHook ?? false, compactionEntry: entry ?? null });
      }
    });
  }

  function configureModelRuntime(runtime) {
    observed = runtime;
    if (runtime.phaseName === 'compression') return; // session.mjs refuses every public completion method.
    const original = runtime.modelRuntime.streamSimple.bind(runtime.modelRuntime);
    runtime.modelRuntime.streamSimple = (model, context, callOptions = {}) => {
      const startedAt = new Date().toISOString();
      const start = performance.now();
      const returned = original(model, context, { ...callOptions, onPayload: async payload => {
        const changed = callOptions.onPayload ? await callOptions.onPayload(payload, model) : undefined;
        const actual = changed ?? payload;
        const serializedEffort = actual?.reasoning_effort ?? actual?.reasoning?.effort ?? null;
        const effort = serializedEffort ?? (runtime.phase.effort === 'off' ? 'off' : null);
        assert.equal(model.provider, runtime.phase.provider, 'Serialized provider differs');
        assert.equal(model.id, runtime.phase.model, 'Serialized model differs');
        assert.equal(effort, runtime.phase.effort, 'Serialized effort differs');
        assert.ok(actual.tools === undefined || Array.isArray(actual.tools), 'Serialized tools must be an array');
        const current = registered();
        const serialized = ordered((actual.tools ?? []).map(tool => tool.function ?? tool));
        assert.deepEqual(serialized, current, 'Registered/serialized package tool descriptors differ');
        const expected = options.expectedPath ? JSON.parse(readFileSync(options.expectedPath, 'utf8')) : undefined;
        if (expected) {
          assert.deepEqual(current, expected.registered, 'Registered tools differ from preflight');
          assert.deepEqual(serialized, expected.serialized, 'Serialized tools differ from preflight');
        }
        const evidencePath = options.evidencePath ?? join(directory(), 'tools.json');
        if (options.expectedPath) assert.notEqual(resolve(evidencePath), realpathSync(options.expectedPath), 'Evidence must not overwrite expected preflight');
        const output = runtime.output;
        const rel = relative(output, resolve(evidencePath));
        assert.ok(rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), 'Tool evidence must be inside output_dir');
        const parent = realpathSync(dirname(evidencePath));
        const parentRel = relative(output, parent);
        assert.ok(parent === output || (parentRel && parentRel !== '..' && !parentRel.startsWith('../') && !isAbsolute(parentRel)), 'Tool evidence parent escapes output_dir');
        if (existsSync(evidencePath)) assert.equal(realpathSync(evidencePath), resolve(evidencePath), 'Tool evidence cannot be a symlink');
        persistContextPayload(actual, { directory: directory(), toolsOnly: false, source: 'onPayload', runtime: { model, effort } });
        const systemMessages = context.messages.filter(message => message.role === 'system');
        const contextSystem = runtime.ai.getCurrentSystemPrompt(context.messages);
        const userMessages = context.messages.filter(message => message.role === 'user')
          .map(message => ({ sha256: digest(JSON.stringify(message.content)), content: message.content }));
        const bindings = { configuredSystemSha256: digest(runtime.config.system_prompt),
          appendSystemSha256: digest(appendSystemPrompt), actualContextSystemSha256: digest(contextSystem),
          rawQuestion, rawQuestionSha256: rawQuestion === null ? null : digest(rawQuestion), userMessages };
        save(evidencePath, { registered: current, serialized, source: 'before_provider_request', observationSource: 'onPayload',
          descriptionsPreserved: true, expectedMatched: expected ? true : null, ...bindings });
        registration();
        while (existsSync(join(directory(), `wire-payload-${String(request + 1).padStart(4, '0')}.json`))) request++;
        const suffix = String(++request).padStart(4, '0');
        const payloadFile = `wire-payload-${suffix}.json`;
        save(join(directory(), payloadFile), actual);
        save(join(directory(), `context-system-${suffix}.json`), { source: 'onPayload', systemPrompt: contextSystem, systemMessages, ...bindings });
        persist(options.stopAfterSerialization ? 'serialization-requests.jsonl' : 'wire-requests.jsonl', {
          phase: runtime.phaseName, provider: model.provider, model: model.id, effort, serializedEffort,
          maxOutputTokens: actual?.max_output_tokens ?? actual?.max_completion_tokens ?? actual?.max_tokens ?? null,
          contextWindow: model.contextWindow, modelMaxTokens: model.maxTokens, payloadFile, source: 'onPayload' });
        if (options.stopAfterSerialization) { process.stderr.write(`${STOP_AFTER_SERIALIZATION}\n`); process.exit(2); }
        return changed;
      } });
      void (async () => {
        const response = await (await returned).result();
        persist('wire-results.jsonl', { phase: runtime.phaseName, provider: response.provider, model: response.model,
          stopReason: response.stopReason, usage: response.usage ?? null, startedAt,
          endedAt: new Date().toISOString(), milliseconds: performance.now() - start });
      })().catch(() => { /* Missing observations stay unknown; no credentials/headers are copied. */ });
      return returned;
    };
  }
  return { observeExtensions, observeSession };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = observerOptions(process.argv);
    if (options.phaseName === 'compression' || options.stopAfterSerialization) await import('./no-network.mjs');
    const appendSystemPrompt = options.appendSystemPromptPath ? readFileSync(options.appendSystemPromptPath, 'utf8') : '';
    await main({ appendSystemPrompt, ...createPackageObserver({ ...options, appendSystemPrompt }) });
  } catch (error) { console.error(`package-sdk: ${error.message}`); process.exitCode = 1; }
}
