import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
export const PREINDEX_DEFAULTS = Object.freeze({ userCycles: 10, toolRounds: 10 });
const valid = value => Number.isInteger(value) && value >= 1 && value <= 100;
/**
 * Extension-owned config, read once per session_start; never a Pi-core setting.
 * @param {string} cwd
 * @param {{env?: NodeJS.ProcessEnv, warn?: (message: string) => void}} options
 * @returns {{userCycles: number, toolRounds: number}}
 */
export function loadPreindexConfig(cwd, { env = process.env, warn = () => { } } = {}) {
 const path = join(cwd, '.pi', 'pi-recall.json'); let file = {};
 try {
  if (statSync(path).size > 65536) throw new Error('Oversized configuration');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid configuration object');
  if (parsed.preindex !== undefined && (!parsed.preindex || typeof parsed.preindex !== 'object' || Array.isArray(parsed.preindex))) throw new Error('Invalid preindex object');
  file = parsed.preindex ?? {};
  if (Object.keys(parsed).some(key => key !== 'preindex') || Object.keys(file).some(key => !['userCycles', 'toolRounds'].includes(key))) warn('pi-recall: unknown config fields ignored');
 } catch (error) { if (error.code !== 'ENOENT') warn('pi-recall: unreadable or malformed .pi/pi-recall.json; using environment/default values'); }
 const result = { ...PREINDEX_DEFAULTS };
 for (const [field, key] of [['userCycles', 'PI_RECALL_PREINDEX_TURNS'], ['toolRounds', 'PI_RECALL_PREINDEX_TOOL_ROUNDS']]) {
  if (file[field] !== undefined) { if (valid(file[field])) result[field] = file[field]; else warn(`pi-recall: invalid preindex.${field}; expected integer 1–100, using default`); }
  if (env[key] !== undefined) {
   const raw = env[key], value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
   if (valid(value)) result[field] = value; else warn(`pi-recall: invalid ${key}; expected integer 1–100, using file/default`);
  }
 }
 return result;
}
