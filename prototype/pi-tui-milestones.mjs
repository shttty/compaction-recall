// Metadata only: identify conversational phases without logging prompt/response content.
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
export default function(pi) {
 const file=process.env.PI_RECALL_TUI_EVENTS;
 if(!file)return;
 let cycle=0;
 const mark=(event,extra={})=>fs.appendFileSync(file,JSON.stringify({event,cycle,monotonicMs:performance.now(),epochMs:performance.timeOrigin+performance.now(),...extra})+'\n');
 pi.on('session_start',()=>mark('ready'));
 pi.on('input',event=>{cycle++;mark('input',{source:event.source});return {action:'continue'};});
 pi.on('agent_end',event=>{
  const final=event.messages.findLast(m=>m.role==='assistant');
  mark('completed',{stopReason:final?.stopReason??null});
 });
 pi.on('session_shutdown',()=>mark('shutdown'));
}
