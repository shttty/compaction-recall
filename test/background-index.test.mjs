import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundIndex } from '../benchmark/archive/js-runtime/background-index.mjs'
import { buildLocator, buildRecallPage } from '../benchmark/archive/js-runtime/locator.mjs'
import { initialBranch, extendedBranch, msg } from './corpus.mjs';
import { StageTiming } from '../src/timing.mjs';
import { Worker } from 'node:worker_threads';

test('worker prewarm, incremental compaction, pagination and fork have exact scan parity',async()=>{
 const index=new BackgroundIndex();
 try{
  const records=Array.from({length:65},(_,i)=>msg(`id${i}`,`quasar 中文 command ${i}`));
  const branches=[initialBranch(records),extendedBranch(records,[msg('more','quasar 中文 new')]),initialBranch([msg('fork','quasar fork')]),[]];
  for(const branch of branches){
   await index.prepare(branch);
   for(const query of ['quasar','中文','absent','the and','']){
    assert.equal(await index.query(query,branch),buildLocator(query,branch));
    for(const offset of [0,50,100])assert.deepEqual(await index.query(query,branch,{mode:'manual',options:{offset}}),buildRecallPage(query,branch,{offset}));
   }
  }
 }finally{await index.dispose();}
});
test('session switch cancels stale builds/results and disposal rejects further requests',async()=>{
 const index=new BackgroundIndex();
 const old=initialBranch(Array.from({length:100},(_,i)=>msg(`old${i}`,'quasar '+'old '.repeat(1000))));
 const fresh=initialBranch([msg('fresh','nebula new session')]);
 const pending=index.query('quasar',old).catch(e=>e.name);
 index.reset();
 assert.equal(await index.query('nebula',fresh),buildLocator('nebula',fresh));
 assert.equal(await pending,'AbortError');
 assert.doesNotMatch(await index.query('nebula',fresh),/old/);
 await index.dispose();await assert.rejects(index.query('nebula',fresh),{name:'AbortError'});
});
test('worker startup failure uses exact synchronous scan without restarting',async()=>{
 let starts=0;
 const index=new BackgroundIndex({workerFactory:()=>{starts++;throw new Error('fixture startup failure');}});
 const records=Array.from({length:100},(_,i)=>msg(`d${i}`,'quasar '+('text '.repeat(300))));
 const args=msg('args','');args.message.content=[{type:'toolCall',name:'bash',arguments:{command:'中文路径 quasar'}}];args.message.role='assistant';
 const result=msg('result','secretresultonly');result.message.role='toolResult';
 const branch=initialBranch([...records,args,result]);
 try{
  for(const query of ['中文路径','quasar','secretresultonly'])assert.equal(await index.query(query,branch),buildLocator(query,branch));
  assert.equal(starts,1);assert.equal(index.failed,true);
 }finally{await index.dispose();}
});
test('duplicate ids, empty newest messages and very long Unicode transfers preserve exact output',async()=>{
 const index=new BackgroundIndex();
 const branch=initialBranch([msg('dup','quasar old'),msg('dup',''),msg('long','😀'.repeat(40000)+' quasar 中文 '+ 'tail '.repeat(20000))]);
 try{assert.equal(await index.query('quasar 中文',branch),buildLocator('quasar 中文',branch));}
 finally{await index.dispose();}
});

test('preindexed live text cannot affect candidates, corpus weights or pagination until compacted',async()=>{
 const index=new BackgroundIndex();
 const old=msg('old','quasar common');const live=Array.from({length:20},(_,i)=>msg(`live${i}`,'quasar secretlive'));
 const initial=initialBranch([old]);const branch=[...initial,...live];
 try{
  await index.prepare(branch,{preindexLive:true});
  for(const q of ['quasar','secretlive']){
   assert.equal(await index.query(q,branch),buildLocator(q,branch));
   assert.deepEqual(await index.query(q,branch,{mode:'manual'}),buildRecallPage(q,branch));
  }
  const compacted=extendedBranch([old],live);
  assert.equal(await index.query('quasar secretlive',compacted),buildLocator('quasar secretlive',compacted));
 }finally{await index.dispose();}
});

test('unexpected worker exit falls back correctly and never restarts each query',async()=>{
 const index=new BackgroundIndex(),branch=initialBranch([msg('a','quasar')]);
 try{
  await index.prepare(branch);await index.worker.terminate();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await index.query('quasar',branch),buildLocator('quasar',branch));
  assert.equal(index.worker,null);assert.equal(index.failed,true);
  assert.deepEqual(await index.query('quasar',branch,{mode:'manual'}),buildRecallPage('quasar',branch));
 }finally{await index.dispose();}
});

test('live-only background batch does not delay querying unchanged eligible index',async()=>{
 let hold=false,release,entered;const enteredPromise=new Promise(r=>entered=r);
 const gate=new Promise(r=>release=r);
 const index=new BackgroundIndex({yieldFn:async()=>{if(hold){entered();await gate;}else await new Promise(r=>setImmediate(r));}});
 const initial=initialBranch([msg('old','quasar eligible')]);
 try{
  await index.prepare(initial);hold=true;
  const live=[...initial,...Array.from({length:40},(_,i)=>msg(`live${i}`,'liveword'))];
  const updating=index.prepare(live,{preindexLive:true});await enteredPromise;
  let timeout;
  const output=await Promise.race([index.query('quasar',live),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Query waited for irrelevant live batch')),1000);})]);
  clearTimeout(timeout);assert.equal(output,buildLocator('quasar',live));release();await updating;
 }finally{release();await index.dispose();}
});

test('context edits after compaction and live duplicate ids retain scan parity', async () => {
 const index = new BackgroundIndex();
 const initial = initialBranch([msg('old', 'quasar original'), msg('other', 'nebula old')]);
 const edit = (id, targetId, replacement) => ({type:'context_edit',id,targetId,replacement,timestamp:'2026-01-01T00:00:00Z'});
 const live = [...initial, msg('old', 'secretlive duplicate')];
 const edited = [...live, edit('edit', 'mother', {content:'quasar replacement'})];
 const deleted = [...edited, edit('delete', 'mold', null)];
 try {
  for (const branch of [live, edited, deleted, initial]) {
   await index.prepare(branch, {preindexLive:true});
   for (const query of ['quasar', 'nebula', 'secretlive', 'replacement']) {
    assert.equal(await index.query(query,branch),buildLocator(query,branch));
    assert.deepEqual(await index.query(query,branch,{mode:'manual',options:{limit:1,offset:1}}),buildRecallPage(query,branch,{limit:1,offset:1}));
   }
  }
 } finally { await index.dispose(); }
});

test('reset after disposal creates a fresh worker only after previous termination', async () => {
 const index = new BackgroundIndex();
 const branch = initialBranch([msg('a','quasar')]);
 await index.prepare(branch);
 const oldWorker = index.worker;
 await index.dispose();
 assert.equal(oldWorker.threadId,-1);
 await index.reset();
 try {
  assert.equal(await index.query('quasar',branch),buildLocator('quasar',branch));
  assert.notEqual(index.worker,oldWorker);
 } finally { await index.dispose(); }
});

test('worker timing connects actual execution spans to main thread roundtrips', async () => {
 const timer = new StageTiming();
 const index = new BackgroundIndex({timer});
 const branch = initialBranch([msg('a','quasar private fixture')]);
 try {
  assert.equal(await timer.runAsync('lookup',()=>index.query('quasar',branch)),buildLocator('quasar',branch));
  const byId = new Map(timer.events.filter(event=>event.type==='span').map(event=>[event.id,event]));
  for (const stage of ['worker_batch','worker_commit','worker_query']) {
   const span = timer.events.find(event=>event.type==='span'&&event.stage===stage);
   assert.equal(span?.execution,'worker_thread');
   const parent = byId.get(span.parentId);
   assert.equal(parent.stage,`worker_roundtrip_${stage.slice(7)}`);
   assert.equal(parent.execution,'awaited_walltime');
  }
  assert.equal(timer.events.some(event=>event.stage==='worker_maintenance'&&event.kind==='pretokenize'&&event.entries===1&&event.execution==='worker_thread'),true);
  assert.doesNotMatch(JSON.stringify(timer.events),/private fixture|quasar/);
 } finally { await index.dispose(); }
});

test('disabled timing performs no performance clock reads inside the actual worker', async () => {
 const workerURL = new URL('../benchmark/archive/js-runtime/index-worker.mjs',import.meta.url).href;
 const index = new BackgroundIndex({workerFactory:()=>new Worker(
  `const {performance}=require('node:perf_hooks'); performance.now=()=>{throw new Error('Unexpected timing clock read');}; import(${JSON.stringify(workerURL)});`,
  {eval:true},
 )});
 const branch = initialBranch([msg('a','quasar eligible')]);
 try {
  assert.equal(await index.query('quasar',branch),buildLocator('quasar',branch));
  assert.equal(index.failed,false);
  assert.equal(index.ready,true);
  assert.ok(index.worker.threadId>0);
 } finally { await index.dispose(); }
});

test('live prewarm cannot cancel an in-flight cold foreground lookup', async () => {
 let release, entered;
 const gate = new Promise(resolve=>release=resolve);
 const reached = new Promise(resolve=>entered=resolve);
 let pause = true;
 const index = new BackgroundIndex({yieldFn:async()=>{if(pause){entered();await gate;}}});
 const branch = initialBranch([msg('old','quasar eligible')]);
 const lookup = index.query('quasar',branch);
 await reached;
 const prewarm = index.prepare(branch,{preindexLive:true});
 pause = false; release();
 try {
  assert.equal(await lookup,buildLocator('quasar',branch));
  await prewarm;
  assert.equal(index.entries.length,2);
  assert.equal(index.failed,false);
 } finally { release(); await index.dispose(); }
});

test('compaction activates live token caches without retokenizing or widening the earlier corpus', async () => {
 const timer = new StageTiming(), documents = [];
 const index = new BackgroundIndex({timer,workerFactory:()=>{
  const worker = new Worker(new URL('../benchmark/archive/js-runtime/index-worker.mjs',import.meta.url));
  worker.on('message',message=>{if(message.result?.documents!==undefined)documents.push(message.result.documents);});
  return worker;
 }});
 const initial = initialBranch([msg('old','olderterm'),msg('newer','newerterm')]);
 const live = [...initial,...Array.from({length:20},(_,i)=>msg(`cached${i}`,`newerterm secretlive ${i}`))];
 try {
  await index.prepare(live,{preindexLive:true});
  assert.deepEqual(documents,[2]);
  assert.equal(await index.query('olderterm newerterm',live),buildLocator('olderterm newerterm',live));
  assert.equal(await index.query('secretlive',live),undefined);
  timer.events.splice(0);
  const kept = msg('kept','new live');
  const compacted = [...live,kept,{type:'compaction',id:'next-compaction',firstKeptEntryId:kept.id,summary:'',timestamp:kept.timestamp}];
  assert.equal(await index.query('olderterm newerterm secretlive',compacted),buildLocator('olderterm newerterm secretlive',compacted));
  assert.deepEqual(documents,[2,23]);
  assert.equal(timer.events.some(event=>event.stage==='live_or_eligible_tokenization'),false);
  assert.equal(timer.events.some(event=>event.stage==='index_update_tokenize_postings'),true);
 } finally { await index.dispose(); }
});
