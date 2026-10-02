import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { branchMessageEntries, compactedEntries } from '../../src/history.ts';
import { locatorText } from '../../src/locator.ts';
import { CompactionIndex } from './inverted-index.mjs';
const cancelled=()=>Object.assign(new Error('Index generation cancelled'),{name:'AbortError'});
export class BackgroundIndex {
 constructor({timer,workerFactory=()=>new Worker(new URL('./index-worker.mjs',import.meta.url)),yieldFn=yieldImmediate}={}){
  Object.assign(this,{timer,workerFactory,yieldFn});this.generation=0;this.nextRequest=0;this.pending=new Map();this.entries=[];this.eligibleCount=0;this.ready=false;this.disposed=false;this.failed=false;this.worker=null;this.preparation=null;this.fallback=null;
 }
 branch=null;
 fullEntries=[];
 compacted=[];
 event(stage,fields={}){this.timer?.mark(stage,fields);}
 async yield(){await this.yieldFn();}
 stopWorker(){const worker=this.worker;this.worker=null;for(const {reject} of this.pending.values())reject(cancelled());this.pending.clear();if(worker)this.termination=worker.terminate();return this.termination;}
 reset(){this.generation++;this.stopWorker();this.branch=null;this.fullEntries=[];this.compacted=[];this.entries=[];this.eligibleCount=0;this.ready=false;this.serveWhilePreparing=false;this.failed=false;this.preparation=null;this.fallback=null;}
 async dispose(){this.disposed=true;this.generation++;await this.stopWorker();this.branch=null;this.fullEntries=[];this.compacted=[];this.entries=[];this.preparation=null;this.fallback=null;}
 startWorker(){
  if(this.worker)return;
  const started=performance.now(),worker=this.workerFactory();this.worker=worker;
  worker.on('online',()=>this.event('worker_online',{elapsedMs:performance.now()-started,execution:'worker_startup'}));
  worker.on('message',message=>{
   if(this.worker!==worker)return;const pending=this.pending.get(message.requestId);if(!pending)return;
   this.pending.delete(message.requestId);
   if(message.generation!==this.generation)pending.reject(cancelled());
   else if(message.error)pending.reject(new Error(message.error));
   else {this.event('worker_operation',{operation:pending.type,workerMs:message.workerMs,stages:message.stages,roundtripMs:performance.now()-pending.start,execution:'background_worker'});pending.resolve(message.result);}
  });
  const fail=()=>{if(this.worker!==worker)return;this.failed=true;this.ready=false;this.stopWorker();this.event('worker_failed');};
  worker.on('error',fail);worker.on('exit',()=>{if(this.worker===worker)fail();});
 }
 rpc(type,payload,generation){
  return new Promise((resolve,reject)=>{
   if(generation!==this.generation||this.disposed)return reject(cancelled());
   const requestId=++this.nextRequest,start=performance.now();this.pending.set(requestId,{resolve,reject,type,start});
   try {this.worker.postMessage({type,requestId,generation,...payload});this.event('worker_post_message',{operation:type,mainThreadMs:performance.now()-start,execution:'synchronous_transfer'});}
   catch(error){this.pending.delete(requestId);reject(error);}
  });
 }
 prepare(branch,{preindexLive=false}={}){
  if(this.disposed)return Promise.reject(cancelled());
  const select=performance.now();
  // Cache one immutable raw branch snapshot, not the freshly cloned replacements.
  // Any branch change reprojects edits, including edits appended after compaction.
  if(!this.branch||branch.length!==this.branch.length||branch.some((entry,i)=>entry!==this.branch[i])){
   this.branch=branch.slice();this.fullEntries=branchMessageEntries(branch);
   this.compacted=this.fullEntries.slice(0,compactedEntries(branch).length);
  }
  const eligible=this.compacted,full=this.fullEntries;
  const preserve=this.entries.length>=eligible.length&&this.entries.every((e,i)=>e===full[i]);
  const next=preindexLive?full:preserve?this.entries:eligible;this.event('main_branch_selection',{mainThreadMs:performance.now()-select});
  const same=next.length===this.entries.length&&next.every((e,i)=>e===this.entries[i]);
  if(same&&this.eligibleCount===eligible.length&&this.preparation)return this.preparation;
  let append=this.ready&&next.length>=this.entries.length&&this.entries.every((e,i)=>e===next[i]);
  const seen=new Set(this.entries.filter(e=>['user','assistant'].includes(e.message.role)).map(e=>e.id));
  for(const entry of next.slice(this.entries.length))if(['user','assistant'].includes(entry.message.role)){if(seen.has(entry.id))append=false;seen.add(entry.id);}
  const from=append?this.entries.length:0;
  const serveOld=append&&this.eligibleCount===eligible.length;
  if(!append&&this.worker)this.stopWorker();
  const generation=++this.generation;this.entries=next;this.eligibleCount=eligible.length;this.serveWhilePreparing=serveOld;this.ready=false;this.fallback=null;
  this.preparation=this.build(next,from,append,generation).catch(error=>{
   if(generation!==this.generation||this.disposed)throw cancelled();
   this.failed=true;this.stopWorker();this.event('fallback_required');
   // An unchanged failed generation never starts an unbounded retry loop.
  });
  return this.preparation;
 }
 async build(next,from,append,generation){
  if(this.failed)return;
  const start=performance.now();await this.termination;if(generation!==this.generation||this.disposed)throw cancelled();this.startWorker();await this.rpc('begin',{append,eligibleCount:this.eligibleCount},generation);
  let batch=[],chars=0,sliceStart=performance.now(),extractMs=0;
  const flush=async()=>{if(batch.length){await this.rpc('batch',{entries:batch},generation);batch=[];chars=0;}await this.yield();sliceStart=performance.now();};
  for(let i=from;i<next.length;i++){
   if(generation!==this.generation||this.disposed)throw cancelled();
   const original=next[i];if(!['user','assistant'].includes(original.message.role))continue;
   const before=performance.now(),text=locatorText(original.message);extractMs+=performance.now()-before;
   const entry={type:'message',sourcePosition:i,id:original.id,timestamp:original.timestamp,message:{role:original.message.role,content:text}};
   if(text.length>65536){
    await flush();await this.rpc('large_start',{entry:{...entry,message:{...entry.message,content:''}}},generation);
    for(let at=0;at<text.length;at+=65536){await this.rpc('large_chunk',{text:text.slice(at,at+65536)},generation);await this.yield();}
    await this.rpc('large_end',{},generation);
   } else {if(chars+text.length>65536)await flush();batch.push(entry);chars+=text.length;}
   if(batch.length>=32||chars>=65536||performance.now()-sliceStart>=4)await flush();
  }
  await flush();const result=await this.rpc('commit',{},generation);
  if(generation!==this.generation)throw cancelled();this.ready=true;
  this.event('background_index_ready',{kind:append?'incremental_update':'build_or_rebuild',wallMs:performance.now()-start,mainExtractionMs:extractMs,workerHeapBytes:result.heapUsed,execution:'background_worker_with_main_thread_extraction'});
 }
 async cooperativeFallback(generation){
  if(this.fallback)return this.fallback;
  this.fallback=(async()=>{
   const index=new CompactionIndex();let slice=performance.now();
   for(let i=this.eligibleCount-1;i>=0;i--){
    if(generation!==this.generation||this.disposed)throw cancelled();index.add(this.entries[i],i);
    if(performance.now()-slice>=4){await this.yield();slice=performance.now();}
   }
   index.entries=this.entries.slice(0,this.eligibleCount);index.branch=this.branch;index.builds=1;return index;
  })();return this.fallback;
 }
 async query(query,branch,{mode='auto',options={}}={}){
  const start=performance.now(),preparation=this.prepare(branch),generation=this.generation;
  if(!this.serveWhilePreparing)await preparation;if(generation!==this.generation||this.disposed)throw cancelled();
  this.event('critical_path_index_wait',{wallMs:performance.now()-start,execution:'awaited_readiness'});
  if(this.failed){
   const index=await this.cooperativeFallback(generation);
   if(generation!==this.generation)throw cancelled();
   return mode==='manual'?index.recall(query,branch,options):index.query(query,branch);
  }
  try{return await this.rpc('query',{query,mode,options},generation);}
  catch(error){
   if(generation!==this.generation||this.disposed)throw cancelled();this.failed=true;this.stopWorker();
   const index=await this.cooperativeFallback(generation);if(generation!==this.generation||this.disposed)throw cancelled();return mode==='manual'?index.recall(query,branch,options):index.query(query,branch);
  }
 }
}
