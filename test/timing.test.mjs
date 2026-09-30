import test from 'node:test';
import assert from 'node:assert/strict';
import { StageTiming } from '../prototype/stage-timing.mjs';
import { registerStageEvents } from '../prototype/pi-stage-events.mjs';
import { CompactionIndex } from '../prototype/inverted-index.mjs';
import { buildRecallPage, buildLocator } from '../locator.ts';
import { initialBranch, extendedBranch, msg } from '../prototype/corpus.mjs';

test('timed index preserves response parity and distinguishes cold build, warm query and update',()=>{
 let t=0;const timing=new StageTiming(()=>++t),index=new CompactionIndex(timing);
 const records=[msg('a','quasar rare keyword'),msg('b','quasar other')],branch=initialBranch(records);
 assert.equal(index.query('quasar',branch),buildLocator('quasar',branch));
 assert.deepEqual(index.recall('quasar',branch),buildRecallPage('quasar',branch));
 const next=extendedBranch(records,[msg('c','quasar new')]);
 assert.equal(index.query('quasar',next),buildLocator('quasar',next));
 const stages=timing.events.map(x=>x.stage);
 for(const stage of ['index_build_tokenize_postings','index_update_tokenize_postings','query_tokenization','postings_search','candidate_materialization','deduplicate','mechanical_rank','manual_snippets_pagination_render','auto_render_budget'])assert.ok(stages.includes(stage),stage);
 assert.equal(stages.filter(x=>x==='index_build_tokenize_postings').length,1);
 assert.ok(timing.events.filter(x=>x.type==='span').every(x=>x.durationMs>=0));
 assert.ok(!JSON.stringify(timing.events).includes('rare keyword'));
});
test('nested spans retain inclusive parent relation without false parallel nesting',async()=>{
 const t=new StageTiming();
 await Promise.all([t.runAsync('toolA',async()=>{await Promise.resolve();t.run('innerA',()=>{});}),t.runAsync('toolB',async()=>{await Promise.resolve();t.run('innerB',()=>{});})]);
 const byStage=Object.fromEntries(t.events.map(e=>[e.stage,e]));
 assert.equal(byStage.toolA.parentId,null);assert.equal(byStage.toolB.parentId,null);
 assert.equal(byStage.innerA.parentId,byStage.toolA.id);assert.equal(byStage.innerB.parentId,byStage.toolB.id);
});
test('mock SDK event trace separates headers, thinking, visible text and model response end',()=>{
 let now=0;const t=new StageTiming(()=>now),hooks={};registerStageEvents({on:(name,fn)=>hooks[name]=fn},t);
 hooks.before_provider_request({payload:{secret:'DO_NOT_LOG'}});now=20;hooks.after_provider_response({headers:{secret:'DO_NOT_LOG'}});
 now=30;hooks.message_update({assistantMessageEvent:{type:'thinking_delta',delta:'DO_NOT_LOG'}});
 now=50;hooks.message_update({assistantMessageEvent:{type:'text_delta',delta:'DO_NOT_LOG'}});
 now=60;hooks.message_update({assistantMessageEvent:{type:'text_delta'}});
 now=80;hooks.message_end({message:{role:'assistant',content:'DO_NOT_LOG'}});
 assert.equal(t.events.filter(e=>e.stage==='first_visible_text_delta').length,1);
 assert.equal(t.events.find(e=>e.stage==='first_visible_text_delta').sinceRequestMs,50);
 assert.equal(t.events.find(e=>e.stage==='assistant_response_end').sinceRequestMs,80);
 assert.ok(!JSON.stringify(t.events).includes('DO_NOT_LOG'));
});
