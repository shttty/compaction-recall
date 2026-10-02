// Explicit benchmark-only adapter. Never loaded by the production entrypoint.
import { measured } from '../src/timing.ts';
import { benchmarkTiming, flushTiming } from './experimental/stage-timing.mjs';
import register from '../src/recall-extension.ts';
import { withLocators, locatorText } from '../src/locator.ts';
import { loadPreindexConfig } from './experimental/preindex-config.mjs';
import { PreindexCadence } from './experimental/preindex-cadence.mjs';
import { BackgroundIndex } from './experimental/background-index.mjs';

export function registerBenchmarkArm(pi, arm) {
  if (!['native', 'grep', 'indexed'].includes(arm)) throw new Error('Unknown benchmark arm');
  if (arm === 'native') return;
  const index = new BackgroundIndex({timer:benchmarkTiming}); // One extension instance / fresh question session.
  let cadence=new PreindexCadence();
  let scheduled=null,dirty=false;
  const prewarm = (_event,ctx) => {
    dirty=true;if(scheduled)return;
    benchmarkTiming?.mark('preindex_scheduled',{trigger:_event?.type??'lifecycle',userCounter:cadence.completed,toolCounter:cadence.toolRounds});
    cadence.scheduled();
    scheduled=setImmediate(()=>{scheduled=null;if(!dirty)return;dirty=false;index.prepare(ctx.sessionManager.getBranch(),{preindexLive:true}).catch(()=>{});});
  };
  if (arm === 'indexed') {
    pi.on('session_start',(event,ctx)=>{
      const warn=message=>{if(ctx.hasUI&&ctx.ui?.notify)ctx.ui.notify(message,'warning');else process.stderr.write(message+'\n');};
      const config=loadPreindexConfig(ctx.cwd??ctx.sessionManager.getCwd?.()??process.cwd(),{warn});
      benchmarkTiming?.mark('preindex_config',config);cadence=new PreindexCadence(config.userCycles,config.toolRounds);index.reset();prewarm(event,ctx);
    });
    pi.on('session_compact',prewarm);
    pi.on('session_tree',(event,ctx)=>{index.reset();cadence.reset();prewarm(event,ctx);});
    pi.on('message_end',event=>{if(event.message?.role==='user')cadence.userMessage();});
    pi.on('turn_end',(event,ctx)=>{if(cadence.toolBatch(event))prewarm(event,ctx);});
    pi.on('agent_end',(event,ctx)=>{if(cadence.end(event.messages)||dirty)prewarm(event,ctx);});
    pi.on('session_shutdown',()=>{dirty=false;if(scheduled)clearImmediate(scheduled);scheduled=null;return index.dispose();});
  }
  const addTool = tool => pi.registerTool({ ...tool, async execute(...args) {
    try { return benchmarkTiming ? await benchmarkTiming.runAsync(`tool_${tool.name}_total`, () => tool.execute(...args)) : await tool.execute(...args); }
    finally { flushTiming(); }
  }});
  register({
    on(event, handler) {
      if (event !== 'context') throw new Error('Unexpected extension event');
      if (arm === 'indexed') pi.on(event, async (event, ctx) => {
        const work=async()=>{
          const branch=measured(benchmarkTiming,'branch_copy',()=>ctx.sessionManager.getBranch());
          const user=event.messages.findLast(m=>m.role==='user');
          const content=user?await index.query(locatorText(user),branch):undefined;
          return {messages:withLocators(event.messages,branch,()=>content)};
        };
        try{return benchmarkTiming?await benchmarkTiming.runAsync('auto_context_total',work):await work();}
        finally{flushTiming();}
      });
    },
    registerTool(tool) {
      if (tool.name === 'history_recall') {
        if (arm !== 'indexed') return;
        addTool({ ...tool, async execute(_id, params, _signal, _onUpdate, ctx) {
          const page = await index.query(params.query, measured(benchmarkTiming, 'branch_copy', () => ctx.sessionManager.getBranch()), {mode:'manual',options:params});
          return { content: [{ type: 'text', text: page.text }], details: page.details };
        }});
      } else if (arm === 'grep') {
        // Do not instruct the baseline to call tools that are absent in this arm.
        addTool({ ...tool, description: tool.name === 'history_grep'
          ? 'Search original compacted history with a case-insensitive JavaScript regular expression. Returns entry ids and snippets. Use history_expand to verify details. Searches user/assistant text and tool-call names/arguments, excluding toolResult bodies, thinking and images. No matches do not prove absence.'
          : 'Read original compacted history by entry id from history_grep, with neighbouring entries. Output capped at 16000 UTF-16 code units; before/after default 2, maximum 20.' });
      } else addTool(tool);
    },
  });
}
export default function(pi) {
  registerBenchmarkArm(pi, process.env.PI_RECALL_BENCH_ARM);
}
