import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundIndex } from '../benchmark/experimental/background-index.mjs';
import { buildLocator, buildRecallPage } from '../src/locator.ts';
import { initialBranch, extendedBranch, msg } from '../benchmark/experimental/corpus.mjs';

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
test('worker startup failure uses yielding fallback without missing tool arguments or leaking results',async()=>{
 let yields=0;
 const index=new BackgroundIndex({workerFactory:()=>{throw new Error('fixture startup failure');},yieldFn:async()=>{yields++;await new Promise(r=>setImmediate(r));}});
 const records=Array.from({length:100},(_,i)=>msg(`d${i}`,'quasar '+('text '.repeat(300))));
 const args=msg('args','');args.message.content=[{type:'toolCall',name:'bash',arguments:{command:'中文路径 quasar'}}];args.message.role='assistant';
 const result=msg('result','secretresultonly');result.message.role='toolResult';
 const branch=initialBranch([...records,args,result]);
 try{
  for(const query of ['中文路径','quasar','secretresultonly'])assert.equal(await index.query(query,branch),buildLocator(query,branch));
  assert.ok(yields>0);assert.equal(index.failed,true);
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
