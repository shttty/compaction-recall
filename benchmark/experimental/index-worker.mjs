import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { lex, locatorText } from '../../src/locator.ts';
import { StageTiming } from './stage-timing.mjs';
import { CompactionIndex } from './inverted-index.mjs';
class CachedIndex extends CompactionIndex {
 add(entry,recency){
  if(!entry.tokens)return super.add(entry,recency);
  if(this.seen.has(entry.id))return;this.seen.add(entry.id);
  if(!locatorText(entry.message))return;
  this.documents.set(recency,entry);
  for(const [term,position] of entry.tokens){let posting=this.postings.get(term);if(!posting)this.postings.set(term,posting=new Map());posting.set(recency,position);}
  delete entry.tokens;this.indexed++;
 }
}
const tokenize=entry=>{const tokens=new Map();let order=0;for(const {term,offset} of lex(entry.message.content)){if(!tokens.has(term))tokens.set(term,{offset,order});order++;}return {...entry,tokens};};
const timing=new StageTiming();
const index=new CachedIndex(timing);
let active=[],staging=[],generation=0,partial=null,eligibleCount=0;
const branch=entries=>{
 const ids=new Set(entries.map(e=>e.id));let kept='worker-kept';while(ids.has(kept))kept+='-';
 return [...entries,{type:'compaction',id:'worker-boundary',firstKeptEntryId:kept,summary:'',timestamp:'2000-01-01'},
 {type:'message',id:kept,timestamp:'2000-01-01',message:{role:'user',content:''}}];
};
parentPort.on('message',message=>{
 const start=performance.now();
 try {
  let result;
  if(message.type==='begin'){
   generation=message.generation;eligibleCount=message.eligibleCount;staging=message.append?active.slice():[];partial=null;
  } else {
   if(message.generation!==generation)throw new Error('Obsolete generation');
   if(message.type==='batch')staging.push(...timing.run("live_or_eligible_tokenization",()=>message.entries.map(tokenize)));
   else if(message.type==='large_start')partial={entry:message.entry,chunks:[]};
   else if(message.type==='large_chunk')partial.chunks.push(message.text);
   else if(message.type==='large_end'){
    partial.entry.message.content=partial.chunks.join('');staging.push(timing.run("live_or_eligible_tokenization",()=>tokenize(partial.entry)));partial=null;
   } else if(message.type==='commit'){
    active=staging;index.sync(branch(active.filter(e=>e.sourcePosition<eligibleCount)));result={documents:index.documents.size,heapUsed:process.memoryUsage().heapUsed};
   } else if(message.type==='query')result=message.mode==='manual'?index.recall(message.query,branch(active.filter(e=>e.sourcePosition<eligibleCount)),message.options):index.query(message.query,branch(active.filter(e=>e.sourcePosition<eligibleCount)));
   else throw new Error('Unknown worker command');
  }
  parentPort.postMessage({requestId:message.requestId,generation:message.generation,result,workerMs:performance.now()-start,stages:timing.events.splice(0)});
 } catch {parentPort.postMessage({requestId:message.requestId,generation:message.generation,error:'Index worker operation failed'});}
});
