import test from 'node:test';import assert from 'node:assert/strict';
import { PreindexCadence } from '../prototype/preindex-cadence.mjs';
test('5/10 conversational cycles ignore tool/model turns, aborts and repeated completions',()=>{
 for(const every of [5,10]){
  const cadence=new PreindexCadence(every);
  for(let i=1;i<=every;i++){
   assert.equal(cadence.end([{role:'assistant'}]),false);
   cadence.userMessage();cadence.userMessage();
   assert.equal(cadence.end([{role:'assistant',stopReason:'stop'},{role:'toolResult'},{role:'assistant',stopReason:'stop'}]),i===every);
  }
  cadence.scheduled();
  cadence.userMessage();assert.equal(cadence.end([{role:'assistant',stopReason:'aborted'}]),false);assert.equal(cadence.completed,0);
  cadence.userMessage();cadence.reset();assert.equal(cadence.end(),false);
 }
});

test('independent tool-round OR trigger counts parallel/error-result batches once and resets only when scheduled',()=>{
 const cadence=new PreindexCadence(5,3);
 const batch=(id,results=[{isError:false},{isError:false}])=>({messageEntryId:id,message:{role:'assistant',stopReason:'toolUse'},toolResults:results});
 cadence.userMessage();assert.equal(cadence.toolBatch(batch('a')),false);
 assert.equal(cadence.toolBatch(batch('a')),false);assert.equal(cadence.toolRounds,1);
 assert.equal(cadence.toolBatch(batch('empty',[])),false);
 assert.equal(cadence.toolBatch({...batch('interrupted'),outcome:'aborted'}),false);
 assert.equal(cadence.toolBatch({...batch('abort'),message:{role:'assistant',stopReason:'aborted'}}),false);
 assert.equal(cadence.toolBatch(batch('b',[{isError:true}])),false);
 assert.equal(cadence.toolBatch(batch('c')),true);
 assert.equal(cadence.toolRounds,3);assert.equal(cadence.completed,0);
 cadence.scheduled();assert.equal(cadence.toolRounds,0);
 assert.equal(cadence.toolBatch(batch('c')),false); // duplicate remains suppressed across scheduling
 assert.equal(cadence.end([{role:'assistant',stopReason:'stop'}]),false);
 assert.equal(cadence.completed,1); // only one user cycle, not three tool rounds
 cadence.reset();assert.equal(cadence.toolBatch(batch('a')),false);assert.equal(cadence.toolRounds,1);
});

test('either threshold atomically resets both counters on scheduling; later activity survives',()=>{
 for(const trigger of ['user','tool']){
  const cadence=new PreindexCadence();
  for(let i=0;i<9;i++){cadence.userMessage();cadence.end([{role:'assistant',stopReason:'stop'}]);cadence.toolBatch({messageEntryId:`b${i}`,message:{role:'assistant'},toolResults:[{}]});}
  if(trigger==='user'){cadence.userMessage();assert.equal(cadence.end([{role:'assistant'}]),true);}
  else assert.equal(cadence.toolBatch({messageEntryId:'b9',message:{role:'assistant'},toolResults:[{}]}),true);
  cadence.scheduled();assert.equal(cadence.completed,0);assert.equal(cadence.toolRounds,0);
  cadence.userMessage();assert.equal(cadence.end([{role:'assistant'}]),false);assert.equal(cadence.completed,1);
  assert.equal(cadence.toolBatch({messageEntryId:'after',message:{role:'assistant'},toolResults:[{}]}),false);assert.equal(cadence.toolRounds,1);
 }
});
