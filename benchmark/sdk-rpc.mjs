#!/usr/bin/env node
// Native Pi sessions; this bridge selects resources, not provider transports or RPC semantics.
import { readFileSync, statSync, realpathSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { findPackageJSON } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HELP = `Usage: node benchmark/sdk-rpc.mjs --config PATH --phase compression|answer|judge --describe
       node benchmark/sdk-rpc.mjs --config PATH --phase PHASE --session PATH
         [--arm native|grep|production] [--plugin-dir PATH --wrapper PATH]
         [--recall-config PATH --timing-file PATH --retrieval-input PATH] (answer only)

Uses the explicitly configured Pi SDK and read-only phase profile. No default model,
provider, effort, personal configuration, or model-catalog network access.
Supported SDK: @earendil-works/pi-coding-agent 1.0.0 (native runtime-host RPC API).
`;
const PHASES = ['compression', 'answer', 'judge'];
const ROOT_KEYS = ['sdk_path', 'helper_path', 'data_path', 'output_dir', 'candidate_repo', 'system_prompt', 'protocol', ...PHASES];
function object(value, label, keys) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
 if (keys && Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains unknown fields`);
 return value;
}
function text(value, label) {
 if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
 return value;
}
function json(filename) { return JSON.parse(readFileSync(filename, 'utf8')); }
function inside(filename, directory) {
 const rel = path.relative(directory, filename);
 return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function immutableFile(filename) {
 if (!statSync(filename).isFile() || (statSync(filename).mode & 0o222)) throw new Error(`Pinned resource must be a read-only file: ${filename}`);
 return realpathSync(filename);
}
function containedTarget(filename, output) {
 const absolute = path.resolve(filename);
 // Resolve the existing parent too: a symlink must not redirect session writes outside output.
 if (!inside(absolute, output) || !inside(realpathSync(path.dirname(absolute)), output)) {
  if (path.dirname(absolute) !== output) throw new Error('Session must be inside configured output_dir');
 }
 try {
  if (!inside(realpathSync(absolute), output)) throw new Error('Session resolves outside output_dir');
 } catch (error) { if (error.code !== 'ENOENT') throw error; }
 return absolute;
}
function isolatedEnvironment(home) {
 const keep = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ']);
 for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
 Object.assign(process.env, {
  HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'),
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
  XDG_DATA_HOME: path.join(home, 'data'), TMPDIR: home,
  PI_OFFLINE: '1', DO_NOT_TRACK: '1',
 });
}

async function main() {
 const { values } = parseArgs({
  options: {
   help: { type: 'boolean' }, config: { type: 'string' }, phase: { type: 'string' },
   describe: { type: 'boolean' }, session: { type: 'string' }, arm: { type: 'string' },
   'plugin-dir': { type: 'string' }, wrapper: { type: 'string' },
   'recall-config': { type: 'string' }, 'timing-file': { type: 'string' },
   'retrieval-input': { type: 'string' },
  }, strict: true, allowPositionals: false
 });
 if (values.help) { process.stdout.write(HELP); return; }
 const configPath = path.resolve(text(values.config, '--config'));
 if (!PHASES.includes(values.phase)) throw new Error('--phase must be compression, answer, or judge');
 const config = object(json(configPath), 'config', ROOT_KEYS);
 const base = path.dirname(configPath);
 const resolveConfigPath = key => path.resolve(base, text(config[key], key));
 const sdkPath = realpathSync(resolveConfigPath('sdk_path'));
 const output = realpathSync(resolveConfigPath('output_dir'));
 for (const key of ['helper_path', 'data_path', 'candidate_repo']) statSync(resolveConfigPath(key));
 if (typeof config.system_prompt !== 'string') throw new Error('system_prompt must be a string');
 const protocol = object(config.protocol, 'protocol', ['segments', 'reserve_tokens', 'overhead_tokens']);
 for (const key of ['segments', 'reserve_tokens', 'overhead_tokens']) {
  if (!Number.isSafeInteger(protocol[key]) || protocol[key] < (key === 'segments' ? 1 : 0)) throw new Error(`Invalid protocol.${key}`);
 }
 for (const name of PHASES) {
  const phase = object(config[name], name, ['provider', 'model', 'effort', 'profile']);
  for (const key of ['provider', 'model', 'effort', 'profile']) text(phase[key], `${name}.${key}`);
 }
 const phase = config[values.phase];
 const profile = realpathSync(path.resolve(base, phase.profile));
 if (inside(output, profile) || output === profile || inside(profile, output)) throw new Error('Profile and output_dir must be disjoint');
 const modelsPath = path.join(profile, 'models.json');
 const authPath = path.join(profile, 'auth.json');
 const configuredModels = json(modelsPath);
 object(json(authPath), 'auth.json');
 const provider = configuredModels.providers?.[phase.provider];
 if (!provider?.models?.some(model => model.id === phase.model)) throw new Error('Selected provider/model must be explicitly declared in profile/models.json');
 const sdkPackage = json(path.join(sdkPath, 'package.json'));
 if (sdkPackage.name !== '@earendil-works/pi-coding-agent' || sdkPackage.version !== '1.0.0') {
  throw new Error('Unsupported SDK: requires @earendil-works/pi-coding-agent 1.0.0');
 }
 const arm = values.arm ?? 'native';
 if (!['native', 'grep', 'production'].includes(arm)) throw new Error('Unknown --arm');
 if (values.phase !== 'answer' && (arm !== 'native' || values['plugin-dir'] || values.wrapper)) throw new Error('Compression and judge cannot load extensions');
 if (values.phase !== 'answer' && (values['recall-config'] || values['timing-file'] || values['retrieval-input'])) throw new Error('Recall config, timing file and retrieval input are answer-only');
 const recallConfig = values['recall-config'] ? realpathSync(values['recall-config']) : undefined;
 if (recallConfig && !statSync(recallConfig).isFile()) throw new Error('Recall config must be a file');
 const timingFile = values['timing-file'] ? containedTarget(values['timing-file'], output) : undefined;
 const retrievalInput = values['retrieval-input'] ? immutableFile(values['retrieval-input']) : undefined;
 if (!values.describe && values.phase === 'answer' && !values.arm) throw new Error('Answer requires explicit --arm');
 if (arm === 'native' && (values['plugin-dir'] || values.wrapper)) throw new Error('Native arm cannot load extensions');
 if (arm === 'production' && values.wrapper) throw new Error('Production arm cannot load a grep wrapper');
 const extensionPaths = [];
 let recallExtension;
 if (!values.describe && arm !== 'native') {
  const plugin = realpathSync(text(values['plugin-dir'], '--plugin-dir'));
  const entries = json(path.join(plugin, 'package.json')).pi?.extensions;
  if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0] !== 'string') throw new Error('Pinned package must declare exactly one pi.extensions entry');
  const entry = immutableFile(path.resolve(plugin, entries[0]));
  if (!inside(entry, plugin)) throw new Error('Pinned extension escapes package');
  if (arm === 'production') extensionPaths.push(entry);
  else {
   recallExtension = immutableFile(path.join(path.dirname(entry), 'recall-extension.ts'));
   if (!inside(recallExtension, plugin)) throw new Error('Recall extension escapes package');
   extensionPaths.push(immutableFile(text(values.wrapper, '--wrapper')));
  }
 }
 const sessionPath = values.describe ? undefined : containedTarget(text(values.session, '--session'), output);
 // No temporary directory or SDK import is needed by --help. Describe is read-only.
 const home = values.describe ? path.join(output, '.sdk-describe-home') : mkdtempSync(path.join(output, '.sdk-runtime-'));
 if (!values.describe) process.on('exit', () => rmSync(home, { recursive: true, force: true }));
 isolatedEnvironment(home);
 if (timingFile) process.env.COMPACTION_RECALL_TIMING_FILE = timingFile;
 if (retrievalInput) process.env.PI_RETRIEVAL_INPUT_FILE = retrievalInput;
 if (recallExtension) process.env.PI_RECALL_EXTENSION = recallExtension;
 const load = relative => import(pathToFileURL(path.join(sdkPath, relative)).href);
 const sdk = await load('dist/index.js');
 const { ReadOnlyAuthStorage } = await load('dist/core/auth-storage.js');
 const { InMemoryCodingAgentModelsStore } = await load('dist/core/models-store.js');
 const aiPackage = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(path.join(sdkPath, 'package.json')));
 const compatEntry = json(aiPackage).exports['./compat'].import;
 const { getSupportedThinkingLevels } = await import(new URL(compatEntry, pathToFileURL(aiPackage)).href);
 const credentials = new ReadOnlyAuthStorage(authPath);
 await credentials.list(); // Validate credentials without refresh, command execution, or requests.
 const modelRuntime = await sdk.ModelRuntime.create({
  credentials, modelsPath, modelsStore: new InMemoryCodingAgentModelsStore(),
  allowModelNetwork: false, refreshOnCreate: false,
 });
 if (modelRuntime.getError()) throw new Error(`Invalid model profile: ${modelRuntime.getError()}`);
 const model = modelRuntime.getModel(phase.provider, phase.model);
 if (!model || model.provider !== phase.provider || model.id !== phase.model) throw new Error('SDK did not resolve exact configured provider/model');
 if (!getSupportedThinkingLevels(model).includes(phase.effort)) throw new Error(`Unsupported effort ${phase.effort} for selected model`);
 if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) throw new Error('SDK model has no valid contextWindow/maxTokens');
 if (values.describe) {
  process.stdout.write(`${JSON.stringify({
   provider: model.provider, model: model.id, effort: phase.effort,
   contextWindow: model.contextWindow, maxTokens: model.maxTokens, sdk_version: sdkPackage.version
  })}\n`);
  return;
 }
 const cwd = path.join(home, 'cwd');
 const agentDir = path.join(home, 'agent');
 mkdirSync(cwd); mkdirSync(agentDir);
 if (recallConfig) {
  const extensionsDir = path.join(agentDir, 'extensions');
  mkdirSync(extensionsDir, { mode: 0o700 });
  const target = path.join(extensionsDir, 'compaction-recall.json');
  copyFileSync(recallConfig, target); chmodSync(target, 0o600);
 }
 process.chdir(cwd);
 const settingsManager = sdk.SettingsManager.inMemory({
  compaction: { enabled: false, reserveTokens: protocol.reserve_tokens },
  cacheWarming: 'off', retry: { enabled: false }, packages: [],
 });
 const resourceLoader = new sdk.DefaultResourceLoader({
  cwd, agentDir, settingsManager, additionalExtensionPaths: extensionPaths,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  noContextFiles: true, systemPrompt: '', appendSystemPrompt: [],
  systemPromptOverride: () => config.system_prompt,
 });
 await resourceLoader.reload();
 const extensions = resourceLoader.getExtensions();
 if (extensions.errors.length) throw new Error(`Cannot load pinned extension: ${extensions.errors.map(error => error.error).join('; ')}`);
 const services = { cwd, agentDir, settingsManager, modelRuntime, resourceLoader, diagnostics: [] };
 const sessionManager = sdk.SessionManager.open(sessionPath, path.dirname(sessionPath), cwd);
 const result = await sdk.createAgentSession({
  ...services, sessionManager, model, thinkingLevel: phase.effort,
  scopedModels: [{ model, thinkingLevel: phase.effort }],
  noTools: arm === 'native' ? 'all' : 'builtin',
 });
 if (result.modelFallbackMessage || result.session.model?.id !== model.id || result.session.thinkingLevel !== phase.effort) throw new Error('SDK changed configured model or effort');
 // Benchmark RPC uses get_state/compact/prompt on this one explicit session. Refuse
 // runtime replacement rather than letting RPC new/switch escape its output target.
 const runtime = new sdk.AgentSessionRuntime(result.session, services, async () => {
  throw new Error('Benchmark runtime replacement is not supported; start a new explicit session');
 });
 await sdk.runRpcMode(runtime);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 main().catch(error => { console.error(`sdk-rpc: ${error.message}`); process.exitCode = 1; });
}
