// Offline timing smoke on one saved real history; no provider/credentials accessed.
import fs from 'node:fs';
import { StageTiming } from './stage-timing.mjs';
import { CompactionIndex } from './inverted-index.mjs';
const timer=new StageTiming();
const branch=timer.run('read_parse_session',()=>fs.readFileSync(new URL('../../lme-bench/runs/pi-subscription-dev8-six-20260930/577d4d32/snapshot.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse));
const index=new CompactionIndex(timer),query='What time do I stop checking work emails and messages?';
const cold=timer.run('cold_auto_total',()=>index.query(query,branch));
const warm=timer.run('warm_auto_total',()=>index.query(query,branch));
if(cold!==warm)throw new Error('Cold/warm output mismatch');
timer.run('warm_manual_total',()=>index.recall(query,branch));
const boundaries=branch.flatMap((entry,i)=>entry.type==='compaction'?[i]:[]);
const growing=new CompactionIndex(timer);
timer.run('first_boundary_build_total',()=>growing.query(query,branch.slice(0,boundaries[0]+1)));
timer.run('next_boundary_update_total',()=>growing.query(query,branch.slice(0,boundaries[1]+1)));
const artifact={kind:'single offline local timing smoke, not a benchmark distribution',questionId:'577d4d32',units:'milliseconds',clock:'performance.now monotonic',execution:'synchronous main thread; no background worker',events:timer.events};
fs.writeFileSync(new URL('./timing-smoke-results.json',import.meta.url),JSON.stringify(artifact,null,2)+'\n');
console.log(JSON.stringify(timer.events.filter(e=>e.parentId===null).map(({stage,durationMs})=>({stage,durationMs}))));
