// Benchmark-only peer loading; descriptions and schemas remain plugin-owned.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';


export async function registerPinned(pi, { entry, sdkPath, sqlite, autoGate = 280 }) {
  const require = createRequire(pathToFileURL(entry));
  const { createJiti } = require(join(sdkPath, 'node_modules/jiti/lib/jiti.cjs'));
  const jiti = createJiti(entry, {
    tryNative: false, moduleCache: false,
    alias: { typebox: join(sdkPath, '../../typebox/build/index.mjs'), '@earendil-works/pi-coding-agent': join(sdkPath, 'dist/config.js') },
  });
  const register = await jiti.import(entry, { default: true });
  if (sqlite) {
    process.env.COMPACTION_RECALL_SQLITE_ARM = 'porter-jieba';
    process.env.COMPACTION_RECALL_AUTO_GATE = String(autoGate);
  }
  process.env.COMPACTION_RECALL_MODE = 'full';
  await register(pi);
}
