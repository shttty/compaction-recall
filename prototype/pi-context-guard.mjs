// Common safety-only hook for all arms, including native; adds no tools or hints.
import { estimateTokens } from '../../pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
export function checkContext(messages) {
  const estimate = messages.reduce((total, message) => total + estimateTokens(message), 0) + 5000;
  if (estimate > 340000) throw new Error(`Benchmark context safety ceiling exceeded: ${estimate} > 340000`);
  return estimate;
}
export default function(pi) {
  pi.on('context_with_system', event => {
    try { checkContext(event.messages); }
    catch {
      // Pi reports and swallows hook exceptions, so a throw alone is not a guard.
      process.stderr.write('Benchmark context safety ceiling exceeded; request blocked.\n');
      process.exit(74);
    }
  });
}
