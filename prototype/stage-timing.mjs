import { isMainThread } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
/** Inclusive spans; parent IDs prevent summing parent and child durations twice. */
export class StageTiming {
  constructor(clock = () => performance.now()) { this.clock=clock; this.origin=clock(); this.timerId=randomUUID(); this.events=[]; this.dropped=0; this.context=new AsyncLocalStorage(); this.sequence=0; }
  start(stage) {
    const span={type:'span',execution:isMainThread?'synchronous_main_thread':'worker_thread',stage,id:++this.sequence,parentId:this.context.getStore()??null,startMs:this.clock()-this.origin};
    return span;
  }
  end(span, outcome='ok') {
    if(this.events.length<10000)this.events.push({...span,durationMs:Math.max(0,this.clock()-this.origin-span.startMs),outcome});else this.dropped++;
  }
  run(stage,work) { const span=this.start(stage);try {const result=this.context.run(span.id,work);this.end(span);return result;}catch(error){this.end(span,'error');throw error;} }
  async runAsync(stage,work) { const span=this.start(stage);span.execution='awaited_walltime';try {const result=await this.context.run(span.id,work);this.end(span);return result;}catch(error){this.end(span,'error');throw error;} }
  mark(stage,fields={}) { if(this.events.length<10000)this.events.push({type:'mark',stage,atMs:this.clock()-this.origin,...fields});else this.dropped++; }
  flush(path) {
    if(!path||!this.events.length)return;
    const events=this.events.splice(0);
    if(this.dropped){events.push({type:'mark',stage:'dropped_timing_events',count:this.dropped});this.dropped=0;}
    try {appendFileSync(path,events.map(e=>JSON.stringify({processId:process.pid,timerId:this.timerId,clockOriginMs:this.origin,...e})).join('\n')+'\n',{mode:0o600});} catch { /* Measurements must never alter responses. */ }
  }
}
export const benchmarkTiming = process.env.PI_RECALL_TIMING_FILE ? new StageTiming() : undefined;
export function flushTiming() { benchmarkTiming?.flush(process.env.PI_RECALL_TIMING_FILE); }
