// Benchmark-only peer loading; descriptions and schemas remain plugin-owned.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';


export async function registerPinned(pi, { entry, sdkPath, sqlite, autoGate = 280, mode = 'full', runtimeEvidencePath }) {
  if (mode !== null && !['full', 'lite'].includes(mode)) throw new Error('Invalid pinned mode override');
  const require = createRequire(pathToFileURL(entry));
  const { createJiti } = require(join(sdkPath, 'node_modules/jiti/lib/jiti.cjs'));
  const jiti = createJiti(entry, {
    tryNative: false, moduleCache: false,
    alias: { typebox: join(sdkPath, '../../typebox/build/index.mjs'), '@earendil-works/pi-coding-agent': join(sdkPath, 'dist/index.js') },
  });
  const register = await jiti.import(entry, { default: true });
  if (sqlite) {
    process.env.COMPACTION_RECALL_SQLITE_ARM = 'porter-jieba';
    process.env.COMPACTION_RECALL_AUTO_GATE = String(autoGate);
  }
  if (mode === null) delete process.env.COMPACTION_RECALL_MODE;
  else process.env.COMPACTION_RECALL_MODE = mode;
  const hooks = [], tools = [];
  const observed = runtimeEvidencePath ? new Proxy(pi, {
    get(target, property) {
      if (property === 'on') return (name, handler) => { hooks.push(name); return target.on(name, handler); };
      if (property === 'registerTool') return tool => { tools.push(tool.name); return target.registerTool(tool); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) : pi;
  await register(observed);
  if (runtimeEvidencePath) {
    mkdirSync(dirname(runtimeEvidencePath), { recursive: true, mode: 0o700 });
    writeFileSync(runtimeEvidencePath, JSON.stringify({ entry,
      entrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
      modeOverride: mode, registeredHooks: hooks, registeredTools: tools.sort() }), { mode: 0o600 });
    chmodSync(runtimeEvidencePath, 0o600);
  }
}
