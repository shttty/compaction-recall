import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
export const PREINDEX_DEFAULTS = Object.freeze({ userCycles: 10, toolRounds: 10 });
const valid = value => Number.isInteger(value) && value >= 1 && value <= 100;
/**
 * Optional agent-wide configuration, read once when the extension loads.
 * @param {{env?: NodeJS.ProcessEnv, warn?: (message: string) => void}} options
 * @returns {{mode: 'lite' | 'full', userCycles: number, toolRounds: number}}
 */
export function loadRecallConfig({ env = process.env, warn = () => { } } = {}) {
 const path = join(getAgentDir(), 'extensions', 'compaction-recall.json'); let file = {}, fileMode;
 try {
  if (statSync(path).size > 65536) throw new Error('Oversized configuration');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid configuration object');
  if (parsed.preindex !== undefined && (!parsed.preindex || typeof parsed.preindex !== 'object' || Array.isArray(parsed.preindex))) throw new Error('Invalid preindex object');
  file = parsed.preindex ?? {};
  fileMode = parsed.mode;
  if (Object.keys(parsed).some(key => !['mode', 'preindex'].includes(key)) || Object.keys(file).some(key => !['userCycles', 'toolRounds'].includes(key))) warn('compaction-recall: unknown config fields ignored');
 } catch (error) { if (error.code !== 'ENOENT') warn('compaction-recall: unreadable or malformed agent compaction-recall.json; using environment/default values'); }
 /** @type {'lite' | 'full'} */
 let mode = 'full';
 if (fileMode !== undefined) {
  if (fileMode === 'lite' || fileMode === 'full') mode = fileMode;
  else warn('compaction-recall: invalid mode; expected lite or full, using full');
 }
 if (env.COMPACTION_RECALL_MODE !== undefined) {
  if (env.COMPACTION_RECALL_MODE === 'lite' || env.COMPACTION_RECALL_MODE === 'full') mode = env.COMPACTION_RECALL_MODE;
  else { mode = 'full'; warn('compaction-recall: invalid COMPACTION_RECALL_MODE; expected lite or full, using full'); }
 }
 const result = { mode, ...PREINDEX_DEFAULTS };
 for (const [field, key] of [['userCycles', 'COMPACTION_RECALL_PREINDEX_TURNS'], ['toolRounds', 'COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS']]) {
  if (file[field] !== undefined) { if (valid(file[field])) result[field] = file[field]; else warn(`compaction-recall: invalid preindex.${field}; expected integer 1–100, using default`); }
  if (env[key] !== undefined) {
   const raw = env[key], value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
   if (valid(value)) result[field] = value; else warn(`compaction-recall: invalid ${key}; expected integer 1–100, using file/default`);
  }
 }
 return result;
}
