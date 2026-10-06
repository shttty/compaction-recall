// Explicit benchmark arm selection; production owns indexing and lifecycle.
import register from './archive/js-runtime/recall-extension.ts'

export function registerBenchmarkArm(pi, arm) {
  if (!['native', 'grep', 'indexed'].includes(arm)) throw new Error('Unknown benchmark arm');
  if (arm === 'native') return;
  if (arm === 'indexed') return register(pi);
  register({
    // The grep-only baseline never starts a worker or injects context.
    on() {},
    registerTool(tool) {
      if (tool.name === 'history_recall') return;
      pi.registerTool({ ...tool, description: tool.name === 'history_grep'
        ? 'Search original compacted history with a case-insensitive JavaScript regular expression. Returns entry ids and snippets. Use history_expand to verify details. Searches user/assistant text and tool-call names/arguments, excluding toolResult bodies, thinking and images. No matches do not prove absence.'
        : 'Read original compacted history by entry id from history_grep, with neighbouring entries. Output capped at 16000 Unicode codepoints; before/after default 2, maximum 20.' });
    },
  });
}

export default function(pi) {
  registerBenchmarkArm(pi, process.env.PI_RECALL_BENCH_ARM);
}
