import test from 'node:test';
import assert from 'node:assert/strict';
import register from '../src/index.ts';
import { buildLocator, buildRecallPage } from '../src/locator.ts';
import { searchableEntryText, entryText } from '../src/history.ts';
import { CompactionIndex } from '../benchmark/experimental/inverted-index.mjs';
const msg=(id,content,role='assistant')=>({type:'message',id,parentId:null,timestamp:'2026-09-30T00:00:00.000Z',message:{role,content,timestamp:0}});
const branch=old=>[...old,msg('live','tail','user'),{type:'compaction',id:'c',timestamp:'2026-09-30T00:00:00.000Z',firstKeptEntryId:'live'}];
const tools=b=>{const t=new Map();register({registerTool:x=>t.set(x.name,x),on(){}});return(name,params)=>t.get(name).execute('scope',params,undefined,undefined,{sessionManager:{getBranch:()=>b}});};
const rows=text=>text?.split('\n').filter(line=>line.startsWith('{')).map(JSON.parse)??[];

test('name, command/path and Chinese input-only terms are searchable through all entrypoints',async()=>{
 const call=msg('call',[{type:'text',text:'Ordinary prose.'},{type:'toolCall',name:'search_archive',arguments:{z:3,command:'cat /project/数据库/session_store.json',query:'压缩边界'}}]);
 const b=branch([call]),run=tools(b),index=new CompactionIndex();
 for(const query of ['search_archive','session_store','数据库','压缩边界']){
  assert.deepEqual(rows(buildLocator(query,b)).map(r=>r.id),['call']);
  assert.deepEqual(rows(buildRecallPage(query,b).text).map(r=>r.id),['call']);
  assert.ok((await run('history_grep',{pattern:query})).details.total>0);
  assert.equal(index.query(query,b),buildLocator(query,b));
 }
 const expanded=(await run('history_expand',{id:'call',before:0,after:0})).content[0].text;
 assert.match(expanded,/Ordinary prose/);assert.match(expanded,/search_archive/);assert.match(expanded,/session_store.json/);assert.match(expanded,/压缩边界/);
 assert.match(searchableEntryText(call),/"command":.*"query":.*"z":3/);
});

test('toolResult-only text is absent from auto/recall/grep, including empty regex, but expands by id',async()=>{
 const result=msg('result',[{type:'text',text:'exclusiveResultMarker'}],'toolResult');
 const b=branch([result]),run=tools(b),index=new CompactionIndex();
 assert.equal(buildLocator('exclusiveResultMarker',b),undefined);
 assert.equal(buildRecallPage('exclusiveResultMarker',b).details.total,0);
 assert.equal(index.query('exclusiveResultMarker',b),undefined);
 assert.equal((await run('history_grep',{pattern:'exclusiveResultMarker'})).details.total,0);
 assert.equal((await run('history_grep',{pattern:''})).details.total,0);
 assert.equal(searchableEntryText(result),undefined);
 assert.equal(entryText(result),'exclusiveResultMarker');
 assert.match((await run('history_expand',{id:'result',before:0,after:0})).content[0].text,/exclusiveResultMarker/);
});

test('thinking, image data and stray text fields on calls stay excluded without losing body or inputs',async()=>{
 const e=msg('mixed',[null,{type:'text',text:'visibleBody'},
  {type:'thinking',thinking:'hiddenThoughtMarker',text:'hiddenThoughtMarker'},
  {type:'image',data:'hiddenImageMarker',text:'hiddenImageMarker'},
  {type:'toolCall',name:'visibleTool',arguments:{input:'visibleInput'},text:'strayMarker'}]);
 const b=branch([e]),run=tools(b);
 for(const query of ['hiddenThoughtMarker','hiddenImageMarker','strayMarker']){
  assert.equal(buildLocator(query,b),undefined);
  assert.equal(buildRecallPage(query,b).details.total,0);
  assert.equal((await run('history_grep',{pattern:query})).details.total,0);
  assert.doesNotMatch(entryText(e),new RegExp(query));
 }
 for(const query of ['visibleBody','visibleTool','visibleInput']) assert.ok(buildLocator(query,b));
});

test('tool argument serialization is deterministic, untruncated, null/cycle safe and nonmutating',()=>{
 const args={z:null,a:{y:'tailMarker'+'x'.repeat(20000),b:'中文路径'}};
 const before=JSON.stringify(args);
 const e=msg('args',[{type:'toolCall',name:'read_file',arguments:args}]);
 const text=searchableEntryText(e);
 assert.equal(JSON.stringify(args),before);
 assert.equal(text,searchableEntryText(msg('other',[{type:'toolCall',name:'read_file',arguments:{a:{b:'中文路径',y:args.a.y},z:null}}])));
 assert.ok(text.includes(args.a.y));
 assert.match(searchableEntryText(msg('null',[{type:'toolCall',name:'noop',arguments:null}])),/Arguments null/);
 const cycle={keyword:'cycleMarker'};cycle.self=cycle;
 assert.match(searchableEntryText(msg('cycle',[{type:'toolCall',name:'noop',arguments:cycle}])),/Circular/);
 assert.equal(cycle.self,cycle);
 assert.match(searchableEntryText(msg('cycle',[{type:'toolCall',name:'noop',arguments:cycle}])),/cycleMarker/);
});
