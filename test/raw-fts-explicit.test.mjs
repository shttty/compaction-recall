import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex, weightedLength } from '../archive/prototype/soft-match-sqlite/index.mjs';
import { SQLiteBackgroundIndex as BackgroundIndex } from '../archive/benchmark/sqlite-background-index.mjs';
import { LOCATOR_TYPE } from '../src/locator.mjs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
const docs = [
  {id:'both',text:'alpha beta running GPU显存 foo_bar HTTPServer 牙买加 哈哈哈'},
  {id:'alpha',text:'alpha alphaprint'}, {id:'prefix',text:'alp alpha'},
  {id:'gap',text:'牙买 买加 ab cd'}, {id:'escaped',text:'ab"cd'},
];
const invalid = [
  ['alpha beta', 'INVALID_QUERY'],
  [{ concepts: [] }, 'INVALID_ARRAY'],
  [{ concepts: [['alpha']], query: 'beta' }, 'UNKNOWN_FIELD'],
  [{ concepts: [['alpha']], must: ['beta'] }, 'UNKNOWN_FIELD'],
  [{ concepts: [['alpha']], prefer: ['beta'] }, 'UNKNOWN_FIELD'],
  [{ concepts: [['alpha']], match: 'some' }, 'INVALID_MODE'],
];
const ids = result => result.results.map(row=>row.id).sort();

test('manual rejects old contracts using author QueryError name and code', t => {
  const index = createIndex(docs, { arm: 'porter' });
  t.after(() => index.close());
  for (const [query, code] of invalid) {
    assert.throws(() => index.queryPage(query), { name: 'QueryError', code });
  }
  assert.deepEqual(ids(index.queryRows({ concepts: [['GPU显存']] })), ['both']);
  assert.deepEqual(ids(index.queryRows({ concepts: [['牙买加']] })), ['both', 'gap']);
  assert.deepEqual(ids(index.queryRows({ concepts: [['哈哈哈']] })), ['both']);
  assert.deepEqual(ids(index.queryRows({ concepts: [['HTTPServer']] })), ['both']);
  assert.deepEqual(ids(index.queryRows({ concepts: [['alpha AND beta']] })), []);
});

test('total=0 gets recall advice but an offset-only empty page does not',t=>{
  const index=createIndex(docs,{arm:'porter'});t.after(()=>index.close());
  const empty=index.queryPage({ concepts: [['absent']] });
  assert.equal(empty.page.details.total,0);
  assert.match(empty.page.text,/未找到匹配项/);
  assert.match(empty.page.text,/零命中不代表历史中不存在相关内容/);
  const beyond=index.queryPage({ concepts: [['alpha']] },{limit:1,offset:999});
  assert.equal(beyond.page.details.total,3);assert.equal(beyond.page.details.returned,0);
  assert.doesNotMatch(beyond.page.text,/请检查参数格式/);
});
const timestamp='2026-10-05T00:00:00Z';
const branch=[...docs.map(({id,text})=>({type:'message',id,timestamp,message:{role:'user',content:text}})),
  {type:'message',id:'live',timestamp,message:{role:'user',content:'retained'}},
  {type:'compaction',id:'compact',timestamp,firstKeptEntryId:'live',summary:'',tokensBefore:10}];
test('actual worker preserves author errors and stays healthy; autocut retains natural language gate',async()=>{
  const index=new BackgroundIndex({engineModule:new URL('../archive/benchmark/retrieval-sqlite-worker.mjs',import.meta.url)});
  index.scan=()=>{throw new Error('unexpected synchronous fallback');};
  try {
    await index.prepare(branch,{preindexLive:true});
    const worker=index.worker, generation=index.generation;
    for(const [query,code] of invalid) {
      await assert.rejects(index.queryRanked(query,branch,{mode:'manual'}),{name:'QueryError',code});
    }
    assert.equal(index.worker,worker);
    assert.equal(index.generation,generation);
    assert.equal(index.failed,false);
    assert.deepEqual((await index.queryRanked({ concepts: [['GPU显存']] },branch,{mode:'manual'})).results.map(row=>row.id),['both']);
    const text='where alpha beta';
    const automatic=await index.queryRanked(text,branch,{mode:'auto'});
    assert.deepEqual(ids(automatic),['alpha','both','prefix']);
    assert.equal(automatic.skipped,false);
    const padded=text+' '.repeat(211-weightedLength(text));
    assert.equal((await index.queryRanked(padded,branch,{mode:'auto'})).skipped,true);
    assert.equal((await index.queryRanked({ concepts: [['alpha'+' '.repeat(500)]] },branch,{mode:'manual'})).total,3);
  } finally {await index.dispose();}
});
test('actual SDK tool returns zero/offset advice, preserves author errors and keeps context autocut',async t=>{
  const {discoverAndLoadExtensions}=await import('@earendil-works/pi-coding-agent');
  const loaded=await discoverAndLoadExtensions([fileURLToPath(new URL('../archive/benchmark/retrieval-sqlite-adapter.ts',import.meta.url))],process.cwd(),process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors,[]);
  const extension=loaded.extensions[0],tool=extension.tools.get('history_recall').definition;
  const ctx={sessionManager:{getSessionId:()=> 'raw-explicit-fixture',getBranch:()=>branch}};
  t.after(async()=>{for(const handler of extension.handlers.get('session_shutdown')??[])await handler({type:'session_shutdown',reason:'quit'},ctx);});
  await assert.rejects(tool.execute('obsolete',{query:'alpha beta'},undefined,undefined,ctx),{name:'QueryError',code:'UNKNOWN_FIELD'});
  const empty=await tool.execute('zero',{concepts:[['absent']]},undefined,undefined,ctx);
  assert.equal(empty.details.total,0);assert.match(empty.content[0].text,/零命中不代表历史中不存在相关内容/);
  const beyond=await tool.execute('beyond',{concepts:[['alpha']],offset:999},undefined,undefined,ctx);
  assert.equal(beyond.details.total,3);assert.equal(beyond.details.returned,0);
  assert.doesNotMatch(beyond.content[0].text,/请检查参数格式/);
  await assert.rejects(tool.execute('invalid',{concepts:[]},undefined,undefined,ctx),{name:'QueryError',code:'INVALID_ARRAY'});
  const recovered=await tool.execute('recover',{concepts:[['GPU显存']]},undefined,undefined,ctx);
  assert.equal(recovered.details.total,1);
  let messages=[{role:'user',content:[{type:'text',text:'where alpha beta'}],timestamp:0}];
  for(const handler of extension.handlers.get('context')??[]) {
    const changed=await handler({type:'context',messages},ctx);if(changed?.messages)messages=changed.messages;
  }
  assert.deepEqual(messages.filter(x=>x.customType===LOCATOR_TYPE).flatMap(x=>x.content.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line).id)).sort(),['alpha','both','prefix']);
  assert.doesNotMatch(JSON.stringify(messages),/请检查参数格式/);
});

test('dictionary trial modes preserve fixed candidates and automatic lookup',async()=>{
  const matches=[];
  for(const mode of ['off','jieba']) {
    const index=new BackgroundIndex({engineModule:new URL('../archive/benchmark/retrieval-sqlite-worker.mjs',import.meta.url)});
    index.workerFactory=options=>new Worker(new URL('../src/index-worker.mjs',import.meta.url),{
      workerData:options,env:{...process.env,COMPACTION_RECALL_SQLITE_HAN_PHRASE_TRIAL:mode,COMPACTION_RECALL_SQLITE_BIGRAM_ONLY:'porter'},
    });
    index.scan=()=>{throw new Error('unexpected fallback');};
    try {
      const page=await index.queryPage({ concepts: [['牙买加']] },branch,{limit:50});
      assert.deepEqual(page.ids.sort(),['both','gap']);
      const rows=await index.queryRanked({ concepts: [['牙买加']] },branch,{mode:'manual'});
      matches.push(rows.results.map(({id,score})=>({id,score})).sort((a,b)=>a.id.localeCompare(b.id)));
      const auto=await index.queryRanked('where GPU显存 running',branch,{mode:'auto'});
      assert.deepEqual(auto.results.map(row=>row.id),['both']);
      assert.equal(auto.skipped,false);
    } finally {await index.dispose();}
  }
  assert.deepEqual(matches[0],matches[1]);
});
