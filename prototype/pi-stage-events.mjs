// Forward-only event measurements. No prompts, text, arguments, headers or credentials logged.
import { benchmarkTiming as timer, flushTiming } from './stage-timing.mjs';
export function registerStageEvents(pi, timing = timer) {
  if (!timing) return;
  let request=null,sequence=0;
  pi.on('session_start',()=>{timing.mark('session_start',{nodeProcessUptimeMs:process.uptime()*1000});flushTiming();});
  pi.on('before_provider_request',()=>{
    request={id:++sequence,start:timing.clock(),seen:new Set()};
    timing.mark('provider_request_prepared',{requestId:request.id});
  });
  pi.on('after_provider_response',()=>{
    if(request)timing.mark('provider_response_headers',{requestId:request.id,sinceRequestMs:timing.clock()-request.start});
  });
  pi.on('message_update',event=>{
    if(!request)return;
    const kind=event.assistantMessageEvent?.type;
    const stage=kind==='text_delta'?'first_visible_text_delta':kind==='thinking_delta'?'first_thinking_delta':kind==='toolcall_delta'?'first_toolcall_delta':null;
    if(stage&&!request.seen.has(stage)){
      request.seen.add(stage);timing.mark(stage,{requestId:request.id,sinceRequestMs:timing.clock()-request.start});
    }
  });
  pi.on('message_end',event=>{
    if(request&&event.message?.role==='assistant'){
      timing.mark('assistant_response_end',{requestId:request.id,sinceRequestMs:timing.clock()-request.start});request=null;flushTiming();
    }
  });
  pi.on('session_shutdown',()=>flushTiming());
}
export default function(pi){registerStageEvents(pi);}
