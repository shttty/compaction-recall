// Import before production registration so tests never read a personal Pi profile.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'compaction-recall-test-agent-'));
process.env.PI_CODING_AGENT_DIR = directory;
for (const key of ['COMPACTION_RECALL_MODE', 'COMPACTION_RECALL_PREINDEX_TURNS', 'COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS', 'COMPACTION_RECALL_TIMING_FILE']) delete process.env[key];
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
