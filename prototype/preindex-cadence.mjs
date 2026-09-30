/** Independent completed-user-cycle and completed-model/tool-batch triggers. */
export class PreindexCadence {
 constructor(every=10,toolEvery=10){
  for(const value of [every,toolEvery])if(!Number.isInteger(value)||value<1||value>100)throw new Error('Preindex thresholds must be integers from 1 to 100');
  this.every=every;this.toolEvery=toolEvery;this.reset();
 }
 reset(){this.pendingUser=false;this.completed=0;this.toolRounds=0;this.seenBatches=new Set();}
 scheduled(){this.completed=0;this.toolRounds=0;}
 due(){return this.completed>=this.every||this.toolRounds>=this.toolEvery;}
 userMessage(){this.pendingUser=true;}
 end(messages=[]){
  const pending=this.pendingUser;this.pendingUser=false;
  const last=messages.findLast(m=>m.role==='assistant');
  if(!pending||!last||['error','aborted'].includes(last.stopReason))return false;
  this.completed++;return this.due();
 }
 toolBatch(event){
  if(['error','aborted'].includes(event.outcome)||event.message?.role!=='assistant'||['error','aborted'].includes(event.message.stopReason)||!Array.isArray(event.toolResults)||!event.toolResults.length)return false;
  const id=event.messageEntryId;
  if(typeof id!=='string'||this.seenBatches.has(id))return false;
  this.seenBatches.add(id);if(this.seenBatches.size>128)this.seenBatches.delete(this.seenBatches.values().next().value);
  // Completed error results still represent a completed tool batch. Parallel calls count once.
  this.toolRounds++;return this.due();
 }
}
