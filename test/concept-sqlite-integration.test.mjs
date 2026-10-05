import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';
import { SQLiteBackgroundIndex } from '../benchmark/sqlite-background-index.mjs';
import { BackgroundIndex } from '../src/background-index.mjs';
import { initialBranch, msg } from './corpus.mjs';
const docs=[{id:'both',text:'cedar harbor'}, {id:'alternative',text:'maple harbor'},
  {id:'first',text:'cedar inland'}, {id:'second',text:'willow harbor'}, {id:'neither',text:'willow inland'}];
const query=(concepts,match='any',exclude=[])=>({concepts,match,exclude});
const sorted=result=>result.results.map(row=>row.id).sort();
const engineModule=new URL('../benchmark/retrieval-sqlite-worker.mjs',import.meta.url);

test('existing SQLite index integrates groups, alternatives, defaults and hard exclusions',t=>{
  const index=createIndex(docs);t.after(()=>index.close());
  assert.deepEqual(sorted(index.queryRows({concepts:[['cedar','maple'],['harbor']]})),['alternative','both','first','second']);
  assert.deepEqual(sorted(index.queryRows(query([['cedar','maple'],['harbor']],'all'))),['alternative','both']);
  assert.deepEqual(sorted(index.queryRows(query([['cedar','maple'],['harbor']],'any',['maple']))),['both','first','second']);
  assert.equal(index.queryRows(query([['cedar'],['willow']],'all')).total,0);
  assert.deepEqual(index.queryRows({concepts:[[' cedar ','cedar']]}),index.queryRows({concepts:[['cedar']]}));
});
test('Han words and identifiers require co-occurrence, not position; FTS syntax is literal data',t=>{
  const index=createIndex([{id:'whole',text:'共和国 HTTPServer'}, {id:'reversed',text:'server gap http 和国，共和'},
    {id:'partial',text:'共和 http'}, {id:'literal',text:'backup OR rollback body foo'}, {id:'backup',text:'backup'}]);
  t.after(()=>index.close());
  assert.deepEqual(sorted(index.queryRows(query([['共和国'],['HTTPServer']],'all'))),['reversed','whole']);
  assert.deepEqual(sorted(index.queryRows(query([['backup OR rollback']]))),['literal']);
  assert.deepEqual(sorted(index.queryRows(query([['body:foo']]))),['literal']);
  assert.equal(index.queryRows(query([['absent" OR "backup']])).total,0);
  assert.throws(()=>index.queryRows(query([['中']])),{name:'QueryError',code:'EMPTY_ANALYSIS'});
  assert.throws(()=>index.queryRows({concepts:[['backup']],exclude:['C++']}),{name:'QueryError',code:'EMPTY_ANALYSIS'});
});
test('exclusions cannot select snippet windows or add positive evidence',t=>{
  const index=createIndex([{id:'hit',text:'needle '+ 'padding '.repeat(250)+'poison'}, {id:'drop',text:'needle poison forbidden'}]);
  t.after(()=>index.close());
  const input=query([['needle']],'any',['poison forbidden']);
  const page=index.queryPage(input);
  assert.deepEqual(page.ids,['hit']);
  assert.match(page.page.text,/needle/);
  assert.doesNotMatch(page.page.text,/poison/);
});
test('author parameter/analysis limits and errors survive integrated index, not raw compatibility',t=>{
  const index=createIndex(docs);t.after(()=>index.close());
  for(const [input,code] of [[null,'INVALID_QUERY'],['cedar','INVALID_QUERY'],[{query:'cedar'},'UNKNOWN_FIELD'],
    [{concepts:[['cedar']],must:[]},'UNKNOWN_FIELD'],[{concepts:[]},'INVALID_ARRAY'],
    [{concepts:[[]]},'INVALID_ARRAY'],[{concepts:[['cedar']],match:'none'},'INVALID_MODE'],
    [{concepts:Array.from({length:6},()=>['cedar'])},'INVALID_ARRAY'],
    [{concepts:[Array(5).fill('cedar')]},'INVALID_ARRAY'],
    [{concepts:[['cedar']],exclude:Array(6).fill('willow')},'INVALID_ARRAY'],
    [{concepts:[['x'.repeat(257)]]},'LIMIT_EXCEEDED'],
    [{concepts:[['cedar '.repeat(17)]]},'INVALID_ARRAY'],
    [{concepts:[['cedar\0']]},'INVALID_TEXT'],[{concepts:[['!!!']]},'EMPTY_ANALYSIS']]) {
    assert.throws(()=>index.queryRows(input),{name:'QueryError',code},JSON.stringify(input));
  }
  assert.equal(index.queryRows(query([['x'.repeat(256)]])).total,0);
  assert.equal(index.queryRows(query([['cedar']])).total,2);
});
test('existing SQL dedupe/time ordering and pages remain consistent after concept compilation',t=>{
  const source=Array.from({length:62},(_,i)=>({id:`row${i}`,text:`needle marker${i}`,timestamp:'2026-10-05',sourcePosition:i}));
  source.push({id:'duplicate',text:'needle   marker61',timestamp:'2026-10-06',sourcePosition:63});
  const index=createIndex(source);t.after(()=>index.close());
  const input=query([['needle']]),all=index.queryRows(input);
  assert.equal(all.total,62);assert.equal(all.results[0].id,'duplicate');
  let offset=0;const ids=[];
  while(offset<all.total){const page=index.queryPage(input,{limit:7,offset});assert.equal(page.total,62);
    assert.ok(Array.from(page.page.text).length<=16000);ids.push(...page.ids);offset=page.page.details.nextOffset??all.total;}
  assert.deepEqual(ids,all.results.map(row=>row.id));
  const beyond=index.queryPage(input,{offset:500});assert.equal(beyond.page.details.total,62);
  assert.equal(beyond.page.details.returned,0);assert.doesNotMatch(beyond.page.text,/概念分组/);
  assert.match(index.queryPage(query([['unmatched']])).page.text,/概念分组/);
});
for(const Engine of [BackgroundIndex,SQLiteBackgroundIndex])test(`${Engine.name} uses the actual worker and reuses it after author errors`,async()=>{
  const index=new Engine({engineModule});index.scan=()=>{throw new Error('synchronous fallback forbidden');};
  const branch=initialBranch(docs.map(({id,text})=>({...msg(id,text),id})));
  try {
    const input=query([['cedar','maple'],['harbor']],'all');
    const found=await index.queryRanked(input,branch,{mode:'manual'});
    assert.deepEqual(sorted(found),['alternative','both']);
    const worker=index.worker;
    await assert.rejects(index.queryRanked(query([['中']]),branch,{mode:'manual'}),{name:'QueryError',code:'EMPTY_ANALYSIS'});
    await assert.rejects(index.queryRanked({concepts:[['cedar']],query:'legacy'},branch,{mode:'manual'}),{name:'QueryError',code:'UNKNOWN_FIELD'});
    assert.equal(index.worker,worker);assert.equal(index.failed,false);
    assert.deepEqual(sorted(await index.queryRanked(input,branch,{mode:'manual'})),['alternative','both']);
    const automatic=await index.queryRanked('where cedar harbor',branch,{mode:'auto'});
    assert.deepEqual(sorted(automatic),['alternative','both','first','second']);
    if(Engine===SQLiteBackgroundIndex){const page=await index.queryPage(input,branch,{limit:1,offset:1});
      assert.equal(page.total,2);assert.equal(page.ids.length,1);}
  } finally {await index.dispose();}
});
