// Conservative SDK estimate, independent of synthetic historical usage fields.
import fs from 'node:fs';
import { buildSessionContext } from '../../pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';
import { estimateTokens } from '../../pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
const entries=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse);
const context=buildSessionContext(entries);
console.log(JSON.stringify({estimatedTokens:context.messages.reduce((n,m)=>n+estimateTokens(m),0),messages:context.messages.length}));
