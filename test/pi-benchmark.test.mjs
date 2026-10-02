import assert from 'node:assert/strict';
import test from 'node:test';
import { registerBenchmarkArm } from '../benchmark/pi-benchmark-adapter.mjs';
import { CompactionIndex } from '../src/inverted-index.mjs';
import { buildRecallPage, withLocators } from '../src/locator.mjs';
import { initialBranch, msg } from './corpus.mjs';

test('indexed manual pagination preserves scan output across pages, no hits, forks and resets', () => {
  const index = new CompactionIndex();
  for (const branch of [initialBranch(Array.from({length:65},(_,i)=>msg(`id${i}`,`quasar unique ${i}`))), initialBranch([msg('fork','quasar new')]), []]) {
    for (const query of ['quasar','absent','the and','']) for (const offset of [0,50,100]) {
      assert.deepEqual(index.recall(query,branch,{offset}),buildRecallPage(query,branch,{offset}));
    }
  }
});
test('benchmark arms have exact tool/context isolation and indexed auto/manual parity', async () => {
  const branch=initialBranch([msg('a','quasar 中文路径')]);
  const ctx={sessionManager:{getBranch:()=>branch}};
  for (const arm of ['native','grep','indexed']) {
    const tools=[],hooks=[];
    registerBenchmarkArm({registerTool:t=>tools.push(t),on:(name,fn)=>hooks.push({name,fn})},arm);
    assert.deepEqual(tools.map(t=>t.name),arm==='native'?[]:arm==='grep'?['history_grep','history_expand']:['history_recall','history_grep','history_expand']);
    if (arm==='grep') assert.ok(tools.every(t=>!t.description.includes('history_recall')));
    if (arm==='indexed') {
      const messages=[{role:'user',content:'quasar',timestamp:1}];
      assert.deepEqual((await hooks.find(h=>h.name==='context').fn({messages},ctx)).messages,withLocators(messages,branch));
      const result=await tools[0].execute('call',{query:'quasar'},undefined,undefined,ctx);
      assert.equal(result.content[0].text,buildRecallPage('quasar',branch).text);
      await hooks.find(h=>h.name==='session_shutdown').fn();
    }
  }
});

test('unchanged agent-end performs no history scan and queued prewarm is cancelled on shutdown',async()=>{
 const hooks={};let reads=0;
 registerBenchmarkArm({registerTool:()=>{},on:(name,fn)=>hooks[name]=fn},'indexed');
 const ctx={sessionManager:{getBranch:()=>{reads++;return [];}}};
 hooks.agent_end({},ctx);hooks.agent_end({},ctx);assert.equal(reads,0);
 hooks.session_start({},ctx);hooks.session_compact({},ctx);hooks.agent_end({},ctx);
 await hooks.session_shutdown();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reads,0);
});

test('ten completed user cycles schedule exactly one preindex batch, no per-tool-round scan',async()=>{
 const hooks={};let reads=0;
 registerBenchmarkArm({registerTool:()=>{},on:(name,fn)=>hooks[name]=fn},'indexed');
 const ctx={sessionManager:{getBranch:()=>{reads++;return [];}}};
 for(let n=1;n<=10;n++){
  hooks.message_end({message:{role:'user'}});
  for(let i=0;i<4;i++)hooks.message_end({message:{role:'assistant'}});
  hooks.agent_end({messages:[{role:'assistant',stopReason:'stop'}]},ctx);
  if(n<10)assert.equal(reads,0);
 }
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
 await hooks.session_shutdown();
});

test('ten completed tool batches schedule within one long task before agent-end; parallel calls coalesce',async()=>{
 const hooks={};let reads=0;
 registerBenchmarkArm({registerTool:()=>{},on:(name,fn)=>hooks[name]=fn},'indexed');
 const ctx={sessionManager:{getBranch:()=>{reads++;return [];}}};
 hooks.message_end({message:{role:'user'}});
 for(let i=0;i<10;i++){
  hooks.turn_end({messageEntryId:`batch${i}`,message:{role:'assistant',stopReason:'toolUse'},toolResults:[{isError:false},{isError:false}]},ctx);
  if(i<9)assert.equal(reads,0);
 }
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
 hooks.agent_end({messages:[{role:'assistant',stopReason:'stop'}]},ctx);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
 await hooks.session_shutdown();
});

test('activity while an update is queued is preserved for the next OR-trigger batch',async()=>{
 const hooks={};let reads=0;
 registerBenchmarkArm({registerTool:()=>{},on:(name,fn)=>hooks[name]=fn},'indexed');
 const ctx={sessionManager:{getBranch:()=>{reads++;return [];}}};
 for(let i=0;i<10;i++)hooks.turn_end({messageEntryId:`queue${i}`,message:{role:'assistant'},toolResults:[{}]},ctx);
 for(let i=0;i<9;i++){hooks.message_end({message:{role:'user'}});hooks.agent_end({messages:[{role:'assistant'}]},ctx);}
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
 hooks.message_end({message:{role:'user'}});hooks.agent_end({messages:[{role:'assistant'}]},ctx);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,2);
 await hooks.session_shutdown();
});

test('project configuration is cached for the session and reloaded on session_start',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const cwd=mkdtempSync(join(tmpdir(),'pi-cadence-session-'));mkdirSync(join(cwd,'.pi'));
 const config=join(cwd,'.pi','pi-recall.json');writeFileSync(config,JSON.stringify({preindex:{userCycles:2}}));
 const hooks={};let reads=0;registerBenchmarkArm({registerTool:()=>{},on:(name,fn)=>hooks[name]=fn},'indexed');
 const ctx={cwd,sessionManager:{getBranch:()=>{reads++;return [];}}};
 const finish=()=>{hooks.message_end({message:{role:'user'}});hooks.agent_end({messages:[{role:'assistant'}]},ctx);};
 try{
  hooks.session_start({},ctx);await new Promise(r=>setImmediate(r));assert.equal(reads,1);
  writeFileSync(config,JSON.stringify({preindex:{userCycles:1}}));finish();await new Promise(r=>setImmediate(r));assert.equal(reads,1);
  finish();await new Promise(r=>setImmediate(r));assert.equal(reads,2);
  hooks.session_start({},ctx);await new Promise(r=>setImmediate(r));assert.equal(reads,3);
  finish();await new Promise(r=>setImmediate(r));assert.equal(reads,4);
 }finally{await hooks.session_shutdown();rmSync(cwd,{recursive:true,force:true});}
});
