#!/usr/bin/env node
// Generate native Pi compactions from a frozen, linear source history.
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findPackageJSON } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SDK_NAME = '@earendil-works/pi-coding-agent';
const SDK_VERSION = '1.4.0';
const ROOT_KEYS = ['sdk_path', 'output_dir', 'system_prompt', 'protocol', 'answer', 'judge'];
const HELP = `Usage: node benchmark/sdk/native-snapshot.mjs --config PATH --source PATH --session PATH --result PATH

Reads the configured answer model as Pi's native compaction model, then feeds
source.jsonl messages sequentially through the SDK's automatic threshold check.
The session, result, event JSONL, and request JSONL must be new files under
config.output_dir; the explicit profile must be outside that directory.
The pinned Pi SDK must be 1.4.0. No answer/evaluation prompt is submitted.

Importable offline-test seam: main({ argv, configureModelRuntime, configureSession }).
The callbacks are not CLI flags; production contextWindow must be 200000.
`;
const json = filename => JSON.parse(readFileSync(filename, 'utf8'));
const inside = (filename, directory) => {
 const rel = path.relative(directory, filename);
 return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
function object(value, label, keys) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
 if (keys && Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains unknown fields`);
 return value;
}
function text(value, label) {
 if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
 return value;
}
function targetPath(value, output, label) {
 const absolute = path.resolve(text(value, label));
 if (!inside(absolute, output)) throw new Error(`${label} must be inside config.output_dir`);
 return absolute;
}
function verifyTargetParent(filename, output) {
 mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
 const parent = realpathSync(path.dirname(filename));
 if (parent !== output && !inside(parent, output)) throw new Error('Output path resolves outside config.output_dir');
 if (existsSync(filename)) {
  if (lstatSync(filename).isSymbolicLink() || !inside(realpathSync(filename), output)) throw new Error('Output target must be a regular file inside config.output_dir');
  throw new Error('Output target already exists; unknown in-flight work is not replayed');
 }
}
function writePrivate(filename, content) {
 const fd = openSync(filename, 'wx', 0o600);
 try {
  writeFileSync(fd, content);
  fsyncSync(fd);
 } finally { closeSync(fd); }
 chmodSync(filename, 0o600);
}
function appendDurable(filename, record) {
 const fd = openSync(filename, 'a', 0o600);
 try {
  writeFileSync(fd, `${JSON.stringify(record)}\n`);
  fsyncSync(fd);
 } finally { closeSync(fd); }
 chmodSync(filename, 0o600);
}
function isolatedEnvironment(home) {
 const keep = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ']);
 for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
 Object.assign(process.env, {
  HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'),
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
  XDG_DATA_HOME: path.join(home, 'data'), TMPDIR: home, PI_OFFLINE: '1', DO_NOT_TRACK: '1',
 });
 const guard = globalThis[Symbol.for('benchmark.noNetworkPreload')];
 if (guard) process.env.NODE_OPTIONS = `--import=${guard}`;
}
function safeUsage(usage) {
 if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
 const result = {};
 for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
  if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) result[key] = usage[key];
 }
 if (usage.cost && typeof usage.cost === 'object' && !Array.isArray(usage.cost)) {
  const cost = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
   if (typeof usage.cost[key] === 'number' && Number.isFinite(usage.cost[key]) && usage.cost[key] >= 0) cost[key] = usage.cost[key];
  }
  if (Object.keys(cost).length) result.cost = cost;
 }
 return Object.keys(result).length ? result : null;
}
function safeStopReason(value) {
 return ['stop', 'length', 'error', 'aborted', 'toolUse'].includes(value) ? value : null;
}
function sourceProjection(row) {
 return [row.id, row.message.role, row.message.content, row.message.timestamp];
}
function readSource(filename, headerVersion, phase) {
 const rows = readFileSync(filename, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
 const header = rows[0];
 if (!header || header.type !== 'session' || header.version !== headerVersion || typeof header.cwd !== 'string') {
  throw new Error('Source must start with the pinned SDK session header');
 }
 const messages = rows.slice(1);
 if (!messages.length) throw new Error('Source has no corpus messages');
 let parentId = null;
 const ids = new Set();
 for (const row of messages) {
  if (row.type !== 'message' || !/^[0-9a-f]{8}$/.test(row.id) || ids.has(row.id) || row.parentId !== parentId) {
   throw new Error('Source messages must be unique, eight-hex, and linear');
  }
  const message = row.message;
  if (!message || !['user', 'assistant'].includes(message.role) || !Array.isArray(message.content) ||
      message.content.length !== 1 || message.content[0]?.type !== 'text' || typeof message.content[0].text !== 'string' ||
      !Number.isSafeInteger(message.timestamp) || Date.parse(row.timestamp) !== message.timestamp) {
   throw new Error('Source message differs from corpus projection format');
  }
  if (message.role === 'assistant') {
   const usage = message.usage;
   if (message.provider !== phase.provider || message.model !== phase.model || message.stopReason !== 'stop' ||
       !usage || ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].some(key => usage[key] !== 0)) {
    throw new Error('Source assistant usage must remain unknown and match the configured model');
   }
  }
  ids.add(row.id);
  parentId = row.id;
 }
 return { header, messages };
}
function profileFields(config, configPath, output) {
 const phase = object(config.answer, 'answer', ['provider', 'model', 'effort', 'profile']);
 for (const key of ['provider', 'model', 'effort', 'profile']) text(phase[key], `answer.${key}`);
 const profile = realpathSync(path.resolve(path.dirname(configPath), phase.profile));
 if (profile === output || inside(profile, output) || inside(output, profile)) throw new Error('Profile and output_dir must be disjoint');
 const protocol = object(config.protocol, 'protocol', ['reserve_tokens', 'overhead_tokens']);
 for (const key of ['reserve_tokens', 'overhead_tokens']) {
  if (!Number.isSafeInteger(protocol[key]) || protocol[key] < 0) throw new Error(`Invalid protocol.${key}`);
 }
 if (typeof config.system_prompt !== 'string') throw new Error('system_prompt must be a string');
 return { phase, profile, protocol };
}

export async function main({ argv = process.argv.slice(2), configureModelRuntime, configureSession } = {}) {
 const { values } = parseArgs({
  args: argv,
  options: { help: { type: 'boolean' }, config: { type: 'string' }, source: { type: 'string' }, session: { type: 'string' }, result: { type: 'string' } },
  strict: true, allowPositionals: false,
 });
 if (values.help) { process.stdout.write(HELP); return; }
 if (configureModelRuntime !== undefined && typeof configureModelRuntime !== 'function') throw new Error('Model runtime test seam must be a function');
 if (configureSession !== undefined && typeof configureSession !== 'function') throw new Error('Session test seam must be a function');
 const configPath = path.resolve(text(values.config, '--config'));
 const config = object(json(configPath), 'config', ROOT_KEYS);
 const resolveConfigPath = key => path.resolve(path.dirname(configPath), text(config[key], key));
 const sdkPath = realpathSync(resolveConfigPath('sdk_path'));
 const output = realpathSync(resolveConfigPath('output_dir'));
 const { phase, profile, protocol } = profileFields(config, configPath, output);
 const sourcePath = realpathSync(targetPath(values.source, output, '--source'));
 if (!inside(sourcePath, output) || !statSync(sourcePath).isFile()) throw new Error('Source must be a file inside config.output_dir');
 const sessionPath = targetPath(values.session, output, '--session');
 const resultPath = targetPath(values.result, output, '--result');
 const eventPath = path.join(path.dirname(sessionPath), 'native-compaction-events.jsonl');
 const requestPath = path.join(path.dirname(sessionPath), 'native-model-requests.jsonl');
 const targets = [sessionPath, resultPath, eventPath, requestPath];
 if (new Set(targets).size !== targets.length || targets.some(target => target === sourcePath)) throw new Error('Source and output files must be distinct');
 for (const target of targets) verifyTargetParent(target, output);
 const sdkPackage = json(path.join(sdkPath, 'package.json'));
 if (sdkPackage.name !== SDK_NAME || sdkPackage.version !== SDK_VERSION) throw new Error(`Expected ${SDK_NAME} ${SDK_VERSION}`);
 const { header, messages } = readSource(sourcePath, 3, phase);
 const modelsPath = path.join(profile, 'models.json');
 const authPath = path.join(profile, 'auth.json');
 const configuredModels = json(modelsPath);
 object(json(authPath), 'auth.json');
 if (!configuredModels.providers?.[phase.provider]?.models?.some(model => model.id === phase.model)) {
  throw new Error('Selected provider/model must be explicitly declared in profile/models.json');
 }

 for (const target of targets) verifyTargetParent(target, output);
 const home = mkdtempSync(path.join(output, '.native-runtime-'));
 process.on('exit', () => rmSync(home, { recursive: true, force: true }));
 isolatedEnvironment(home);
 const cwd = path.join(home, 'cwd');
 const agentDir = path.join(home, 'agent');
 for (const directory of [cwd, agentDir, path.join(home, 'config'), path.join(home, 'cache'), path.join(home, 'data')]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
 }
 process.chdir(cwd);
 const load = relative => import(pathToFileURL(path.join(sdkPath, relative)).href);
 const sdk = await load('dist/index.js');
 if (sdk.CURRENT_SESSION_VERSION !== 3) throw new Error('Unsupported SDK session format');
 const { ReadOnlyAuthStorage } = await load('dist/core/auth-storage.js');
 const { InMemoryCodingAgentModelsStore } = await load('dist/core/models-store.js');
 const aiPackage = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(path.join(sdkPath, 'package.json')));
 const aiManifest = json(aiPackage);
 const compatPath = aiManifest.exports['./compat'].import;
 const { getSupportedThinkingLevels } = await import(new URL(compatPath, pathToFileURL(aiPackage)).href);
 const { estimateProjectedContextTokens } = await import(pathToFileURL(path.join(sdkPath, 'dist/core/compaction/compaction.js')).href);
 const credentials = new ReadOnlyAuthStorage(authPath);
 await credentials.list();
 const modelRuntime = await sdk.ModelRuntime.create({
  credentials, modelsPath, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false, refreshOnCreate: false,
 });
 if (modelRuntime.getError()) throw new Error('Invalid configured model profile');
 const observations = { sdk, sdkPath, sdkVersion: sdkPackage.version, config, output, phase, phaseName: 'answer', modelRuntime, home };
 if (configureModelRuntime) await configureModelRuntime(observations);
 const model = modelRuntime.getModel(phase.provider, phase.model);
 if (!model || model.provider !== phase.provider || model.id !== phase.model) throw new Error('SDK did not resolve the configured provider/model');
 if (!getSupportedThinkingLevels(model).includes(phase.effort)) throw new Error('Configured effort is unsupported by the selected model');
 if (!configureModelRuntime && !configureSession && model.contextWindow !== 200000) {
  throw new Error('Production compaction model contextWindow must be 200000');
 }

 const settingsManager = sdk.SettingsManager.inMemory({
  compaction: { enabled: true, reserveTokens: protocol.reserve_tokens },
  cacheWarming: 'off', retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, packages: [],
 });
 if (configureSession) await configureSession({ sdk, settingsManager, model, phase, output, sessionPath });
 const configuredCompaction = settingsManager.getCompactionSettings(model);
 if (!configuredCompaction.enabled || configuredCompaction.reserveTokens !== protocol.reserve_tokens) {
  throw new Error('Native compaction must be enabled with the configured reserveTokens');
 }

 writePrivate(sessionPath, `${JSON.stringify(header)}\n`);
 makeEmptyLog(eventPath);
 makeEmptyLog(requestPath);
 const resourceLoader = new sdk.DefaultResourceLoader({
  cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
  noThemes: true, noContextFiles: true, systemPrompt: '', appendSystemPrompt: [],
  systemPromptOverride: () => config.system_prompt,
 });
 await resourceLoader.reload();
 const extensions = resourceLoader.getExtensions();
 if (extensions.errors.length || extensions.extensions.length) throw new Error('Isolated native session must have no extensions');
 const sessionManager = sdk.SessionManager.open(sessionPath, path.dirname(sessionPath), cwd);
 const created = await sdk.createAgentSession({
  cwd, agentDir, sessionManager, settingsManager, modelRuntime, resourceLoader, model,
  thinkingLevel: phase.effort, scopedModels: [{ model, thinkingLevel: phase.effort }], noTools: 'all',
 });
 const session = created.session;
 if (created.modelFallbackMessage || session.model?.provider !== phase.provider || session.model?.id !== phase.model ||
     session.thinkingLevel !== phase.effort || session.autoCompactionEnabled !== true) {
  throw new Error('SDK changed model, effort, or native auto-compaction settings');
 }
 if (typeof session._compactBeforeNextAssistantResponse !== 'function' || typeof session._runAutoCompaction !== 'function' ||
     typeof sessionManager._appendEntry !== 'function') {
  throw new Error('Pinned SDK native threshold/session append seam is unavailable');
 }

 const compactions = [];
 let activeCompaction;
 let requestId = 0;
 const originalStreamSimple = modelRuntime.streamSimple.bind(modelRuntime);
 const writeRequest = record => appendDurable(requestPath, { timestamp: new Date().toISOString(), ...record });
 modelRuntime.streamSimple = (requestModel, context, options = {}) => {
  const id = ++requestId;
  const effort = options.reasoning ?? (phase.effort === 'off' ? 'off' : null);
  const record = { requestId: id, provider: requestModel.provider, model: requestModel.id, effort, startedAt: performance.now() };
  activeCompaction?.requests.push(record);
  writeRequest({ type: 'request_start', requestId: id, provider: requestModel.provider, model: requestModel.id, effort });
  const finish = (outcome, response) => {
   if (record.finished) return;
   record.finished = true;
   const elapsedSeconds = (performance.now() - record.startedAt) / 1000;
   record.usage = safeUsage(response?.usage);
   record.outcome = outcome;
   writeRequest({ type: 'request_end', requestId: id, provider: requestModel.provider, model: requestModel.id, effort,
    outcome, failure: outcome === 'failed' ? 'native_summarizer_request_failed' : undefined,
    stopReason: safeStopReason(response?.stopReason), usage: record.usage, elapsedSeconds });
  };
  if (!activeCompaction || requestModel.provider !== phase.provider || requestModel.id !== phase.model || effort !== phase.effort) {
   finish('failed');
   throw new Error('Unexpected native summarizer provider/model/effort');
  }
  let stream;
  try {
   stream = originalStreamSimple(requestModel, context, options);
   if (!stream || typeof stream.result !== 'function') throw new Error('Invalid provider stream');
  } catch {
   finish('failed');
   throw new Error('Native summarizer request failed');
  }
  return new Proxy(stream, { get(target, property, receiver) {
   if (property === 'result') return async (...args) => {
    try {
     const response = await Reflect.get(target, property, target).apply(target, args);
     finish('completed', response);
     return response;
    } catch (error) {
     finish('failed');
     throw error;
    }
   };
   const value = Reflect.get(target, property, target);
   return typeof value === 'function' ? value.bind(target) : value;
  } });
 };

 const originalRunAutoCompaction = session._runAutoCompaction.bind(session);
 session.subscribe(event => {
  if (activeCompaction && (event.type === 'compaction_start' || event.type === 'compaction_end')) activeCompaction.events.push(event);
 });
 let sourceMessageCount = 0;
 session._runAutoCompaction = async (reason, willRetry) => {
  const attempt = { reason, willRetry, startedAt: performance.now(), events: [], requests: [],
   compactionCountBefore: sessionManager.getEntries().filter(entry => entry.type === 'compaction').length };
  if (activeCompaction) throw new Error('Nested native compaction is unsupported');
  activeCompaction = attempt;
  let returnValue;
  let thrown = false;
  try {
   if (reason !== 'threshold' || willRetry !== false) throw new Error('Unexpected automatic compaction reason');
   attempt.inputEstimate = estimateProjectedContextTokens(sessionManager.buildSessionProjection(), sessionManager.getBranch()).tokens;
   returnValue = await originalRunAutoCompaction(reason, willRetry);
  } catch {
   thrown = true;
  } finally {
   activeCompaction = undefined;
  }
  const elapsedSeconds = (performance.now() - attempt.startedAt) / 1000;
  const endEvent = attempt.events.findLast(event => event.type === 'compaction_end');
  const entries = sessionManager.getEntries().filter(entry => entry.type === 'compaction');
  const entry = entries.length > attempt.compactionCountBefore ? entries.at(-1) : undefined;
  const eventResult = endEvent?.result;
  const valid = !thrown && attempt.reason === 'threshold' && attempt.willRetry === false &&
   attempt.events.some(event => event.type === 'compaction_start' && event.reason === 'threshold') &&
   endEvent?.reason === 'threshold' && endEvent.aborted === false && eventResult &&
   typeof eventResult.summary === 'string' && eventResult.summary.trim() && entry && entry.id &&
   entry.fromHook === false && entry.summary === eventResult.summary && attempt.requests.length > 0 &&
   attempt.requests.every(request => request.outcome === 'completed') && Number.isSafeInteger(attempt.inputEstimate) &&
   Number.isSafeInteger(eventResult.tokensBefore) && Number.isSafeInteger(eventResult.estimatedTokensAfter);
  const eventRecord = {
   sdkEvents: attempt.events.map(event => event.type === 'compaction_start'
    ? { type: event.type, reason: event.reason }
    : { type: event.type, reason: event.reason, aborted: event.aborted, willRetry: event.willRetry,
     hasResult: Boolean(event.result), tokensBefore: Number.isSafeInteger(event.result?.tokensBefore) ? event.result.tokensBefore : null,
     contextAfter: Number.isSafeInteger(event.result?.estimatedTokensAfter) ? event.result.estimatedTokensAfter : null,
     usage: safeUsage(event.result?.usage) }),
   type: 'compaction_end', reason: attempt.reason, aborted: endEvent?.aborted ?? false, hasResult: Boolean(eventResult),
   inputEstimate: Number.isSafeInteger(attempt.inputEstimate) ? attempt.inputEstimate : null,
   tokensBefore: Number.isSafeInteger(eventResult?.tokensBefore) ? eventResult.tokensBefore : null,
   contextAfter: Number.isSafeInteger(eventResult?.estimatedTokensAfter) ? eventResult.estimatedTokensAfter : null,
   elapsedSeconds, entryId: entry?.id ?? null, fromHook: entry?.fromHook ?? null,
   summaryLength: typeof entry?.summary === 'string' ? entry.summary.trim().length : 0,
   summarySha256: typeof entry?.summary === 'string' ? createHash('sha256').update(entry.summary).digest('hex') : null,
   usage: safeUsage(eventResult?.usage), requestCount: attempt.requests.length,
   requests: attempt.requests.map(request => ({ requestId: request.requestId, provider: request.provider,
    model: request.model, effort: request.effort, outcome: request.outcome ?? 'in_flight', usage: request.usage ?? null })),
   failure: valid ? undefined : 'native_compaction_failed',
  };
  appendDurable(eventPath, eventRecord);
  if (!valid) throw new Error('Native automatic compaction failed');
  compactions.push({ cut: sourceMessageCount, reason: attempt.reason, entryId: entry.id,
   inputEstimate: attempt.inputEstimate, tokensBefore: eventResult.tokensBefore,
   contextAfter: eventResult.estimatedTokensAfter, elapsedSeconds,
   summaryLength: eventRecord.summaryLength, summarySha256: eventRecord.summarySha256,
   fromHook: false, usage: safeUsage(eventResult.usage), requestCount: attempt.requests.length });
  return returnValue;
 };

 const expectedMessageProjections = messages.map(row => createHash('sha256').update(JSON.stringify(sourceProjection(row))).digest('hex'));
 const startedAt = performance.now();
 for (const sourceRow of messages) {
  if (sessionManager.getEntry(sourceRow.id)) throw new Error('Source message id collides with an SDK session entry');
  const entry = { ...sourceRow, parentId: sessionManager.getLeafId() };
  sessionManager._appendEntry(entry);
  sourceMessageCount++;
  // This is the SDK's native request-projection threshold path; unlike _checkCompaction,
  // it does not reject historical corpus timestamps older than a new compaction boundary.
  await session._compactBeforeNextAssistantResponse({ messages: [] });
 }
 const persistedMessages = sessionManager.getEntries().filter(entry => entry.type === 'message');
 if (persistedMessages.length !== messages.length || persistedMessages.some((row, index) =>
  createHash('sha256').update(JSON.stringify(sourceProjection(row))).digest('hex') !== expectedMessageProjections[index])) {
  throw new Error('Native worker changed source message identity, content, timestamp, or order');
 }
 const persistedCompactions = sessionManager.getEntries().filter(entry => entry.type === 'compaction');
 if (persistedCompactions.length !== compactions.length || compactions.some((row, index) =>
  row.entryId !== persistedCompactions[index].id || persistedCompactions[index].fromHook !== false)) {
  throw new Error('Native compaction events do not match persisted entries');
 }
 chmodSync(sessionPath, 0o600);
 const result = {
  compactions, elapsedSeconds: (performance.now() - startedAt) / 1000,
  sdkVersion: sdkPackage.version, messageCount: sourceMessageCount,
  provider: phase.provider, model: phase.model, effort: phase.effort,
  eventLog: path.basename(eventPath), requestLog: path.basename(requestPath),
 };
 writePrivate(resultPath, `${JSON.stringify(result, null, 2)}\n`);
 return result;
}

function makeEmptyLog(filename) { writePrivate(filename, ''); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 main().catch(() => { console.error('native-snapshot: failed; inspect private worker evidence'); process.exitCode = 1; });
}
