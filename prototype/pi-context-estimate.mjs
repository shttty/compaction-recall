// Conservative SDK estimate, independent of synthetic historical usage fields.
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import { buildSessionContext } from '../../pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';
import { estimateTokens } from '../../pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
const start=performance.now(),raw=fs.readFileSync(process.argv[2],'utf8'),read=performance.now();
const entries=raw.trim().split('\n').map(JSON.parse),parsed=performance.now();
const context=buildSessionContext(entries),built=performance.now();
const estimatedTokens=context.messages.reduce((n,m)=>n+estimateTokens(m),0),end=performance.now();
console.log(JSON.stringify({estimatedTokens,messages:context.messages.length,timing:{readMs:read-start,parseMs:parsed-read,buildContextMs:built-parsed,estimateMs:end-built}}));
