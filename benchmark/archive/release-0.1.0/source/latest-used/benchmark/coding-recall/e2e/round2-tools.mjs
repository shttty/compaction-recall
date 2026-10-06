import { isDeepStrictEqual } from 'node:util';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const STOP_AFTER_SERIALIZATION = 'ROUND2_STOP_AFTER_SERIALIZATION';
const TOOL_NAMES = ['history_expand', 'history_grep', 'history_recall'];
const ORACLE_FIELD = /^(?:.*oracle.*|gold(?:_.*)?|reference_answer|expected_answer|model_answer|has_answer|answer_session_ids|judge(?:_.*)?)$/i;

function definition(tool) {
  return JSON.parse(JSON.stringify({ name: tool.name, description: tool.description,
    parameters: tool.parameters ?? tool.input_schema }));
}

function ordered(tools, expectedTools = TOOL_NAMES) {
  const sorted = tools.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!isDeepStrictEqual(sorted.map(tool => tool.name), expectedTools)) {
    throw new Error(isDeepStrictEqual(expectedTools, TOOL_NAMES)
      ? 'Round2 requires exactly the three native recall tools' : 'Round2 requires exactly the expected native recall tools');
  }
  for (const tool of sorted) {
    if (typeof tool.description !== 'string' || !tool.parameters || typeof tool.parameters !== 'object') {
      throw new Error(`Round2 incomplete tool definition: ${tool.name}`);
    }
    noOracleFields(tool);
  }
  return sorted;
}

function noOracleFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (ORACLE_FIELD.test(key)) throw new Error('Round2 oracle field in tool definition');
    noOracleFields(item);
  }
}

function descriptionsSurvive(registered, serialized, path) {
  if (!registered || typeof registered !== 'object') return;
  for (const [key, value] of Object.entries(registered)) {
    const next = `${path}.${key}`;
    if (key === 'description' && !isDeepStrictEqual(value, serialized?.[key])) {
      throw new Error(`Round2 native description changed during serialization: ${next}`);
    }
    if (value && typeof value === 'object') descriptionsSurvive(value, serialized?.[key], next);
  }
}

function canonicalPath(path) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return resolve(realpathSync(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
  }
}

export function withToolEvidence(pi, { evidencePath, expectedPath, stopAfterSerialization = false, expectedTools = TOOL_NAMES }) {
  if (typeof evidencePath !== 'string' || !evidencePath || typeof stopAfterSerialization !== 'boolean') {
    throw new Error('Round2 tool evidence requires a path and boolean stopAfterSerialization');
  }
  if (!Array.isArray(expectedTools) || !expectedTools.length
    || expectedTools.some(name => !TOOL_NAMES.includes(name)) || new Set(expectedTools).size !== expectedTools.length) {
    throw new Error('Round2 requires distinct native expected tool names');
  }
  expectedTools = expectedTools.slice().sort();
  mkdirSync(dirname(resolve(evidencePath)), { recursive: true });
  if (expectedPath && canonicalPath(evidencePath) === canonicalPath(expectedPath)) {
    throw new Error('Round2 tool evidence must not overwrite its expected preflight file');
  }
  const expected = expectedPath ? JSON.parse(readFileSync(expectedPath, 'utf8')) : undefined;
  const registered = [];
  let persisted = false;
  pi.on('before_provider_request', event => {
    try {
      // Read only provider-serialized tool definitions, never request messages or headers.
      if (!Array.isArray(event.payload?.tools)) throw new Error('Round2 serialized tools are missing');
      const serialized = ordered(event.payload.tools.map(tool => {
        noOracleFields(tool);
        return definition(tool.function ?? tool);
      }), expectedTools);
      const native = ordered(registered, expectedTools);
      for (let index = 0; index < native.length; index++) {
        descriptionsSurvive(native[index], serialized[index], native[index].name);
      }
      if (expected && (!isDeepStrictEqual(native, expected.registered)
        || !isDeepStrictEqual(serialized, expected.serialized))) {
        throw new Error('Round2 registered/serialized tools differ from preflight');
      }
      if (!persisted) {
        const descriptor = openSync(evidencePath, 'w', 0o600);
        try {
          writeFileSync(descriptor, JSON.stringify({ registered: native, serialized,
            source: 'before_provider_request', descriptionsPreserved: true,
            expectedMatched: expected ? true : null }));
          fsyncSync(descriptor);
        } finally { closeSync(descriptor); }
        persisted = true;
      }
    } catch {
      // SDK extension runners swallow throws; exiting is the fail-closed boundary.
      process.stderr.write('ROUND2_TOOL_EVIDENCE_VALIDATION_FAILED\n');
      process.exit(2);
    }
    if (stopAfterSerialization) {
      process.stderr.write(`${STOP_AFTER_SERIALIZATION}\n`);
      process.exit(2);
    }
  });
  return new Proxy(pi, {
    get(target, property) {
      if (property === 'registerTool') return tool => {
        registered.push(definition(tool));
        return target.registerTool(tool);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
