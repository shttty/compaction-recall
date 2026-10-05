import './isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createIndex, weightedLength } from '../prototype/soft-match-sqlite/index.mjs';
import { BackgroundIndex } from '../src/background-index.mjs';
import { LOCATOR_TYPE } from '../src/locator.mjs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
const docs = [
  {id:'both',text:'alpha beta running GPU显存 foo_bar HTTPServer 牙买加 哈哈哈'},
  {id:'alpha',text:'alpha alphaprint'}, {id:'prefix',text:'alp alpha'},
  {id:'gap',text:'牙买 买加 ab cd'}, {id:'escaped',text:'ab"cd'},
];
const native = () => {
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE terms USING fts5(tokens, stems, tokenize='ascii')");
  const insert=db.prepare('INSERT INTO terms(rowid,tokens,stems) VALUES(?,?,?)');
  const rows=[
    ['alpha beta running gpu 显存 \ue000 foo bar http server 牙买 买加 \ue000 哈哈 哈哈 \ue000','alpha beta run gpu foo bar http server'],
    ['alpha alphaprint','alpha alphaprint'], ['alp alpha','alp alpha'],
    ['牙买 \ue000 买加 \ue000 ab cd','ab cd'], ['ab cd','ab cd'],
  ];
  rows.forEach(([tokens,stems],i)=>insert.run(i+1,tokens,stems));
  return db;
};
const valid = ['alpha AND beta','alpha OR beta','alpha NOT beta','"alpha beta"','alpha + beta',
  'NEAR(alpha beta, 3)','NEAR(alpha beta)','tokens:NEAR(alpha beta, 3)',
  'NEAR(alpha beta) OR alp','{tokens stems}:alpha','-{stems}:alpha','tokens:(alpha OR beta)',
  'tokens:^alpha','alp*','"alp"*','"alp*"','"ab""cd"','foo_bar','"foo-bar"','"http server"',
  'tokens : "gpu 显存" AND stems : run','牙买加','"牙买 买加"','牙*','牙','tokens:牙买*',
  'GPU显存','HTTPServer','runs','stems:run','"哈哈 哈哈"','"alpha" + "beta"*'];
const implicit = ['alpha beta','"alpha" "beta"','"alpha beta" alp','alpha* beta',
  'NEAR(alpha beta) alp','alpha NEAR(alpha beta)','tokens:alpha stems:run',
  'tokens:(alpha beta)','alpha + beta alp','NEAR(alpha beta) NEAR(alpha beta)'];
const invalid = ['"','alpha AND','(alpha OR beta','unknown:alpha','*alpha',
  'NEAR(alpha beta, x)','alpha +','NOT alpha','alpha OR OR beta','tokens:'];
const ids = result => result.results.map(row=>row.id).sort();

test('manual rejects native implicit AND instead of inventing OR',t=>{
  const index=createIndex(docs,{arm:'porter'}); t.after(()=>index.close());
  for(const query of implicit) assert.throws(()=>index.queryPage(query),/explicit AND\/OR\/NOT|显式/,query);
});
test('accepted raw expressions agree with independent native SQLite; malformed errors are unchanged',t=>{
  const index=createIndex(docs,{arm:'porter'}), db=native();
  t.after(()=>{index.close();db.close();});
  for(const query of valid) {
    const expected=db.prepare('SELECT rowid FROM terms WHERE terms MATCH ?').all(query).map(row=>docs[row.rowid-1].id).sort();
    assert.deepEqual(ids(index.queryRows(query)),expected,query);
  }
  for(const query of invalid) {
    let original;
    try {db.prepare('SELECT rowid FROM terms WHERE terms MATCH ?').all(query);} catch(error) {original=error;}
    assert.ok(original,query);
    assert.throws(()=>index.queryPage(query),error=>error.name===original.name&&error.message===original.message,query);
  }
  assert.deepEqual(ids(index.queryRows('tokens:"gpu 显存"')),['both']);
  assert.deepEqual(ids(index.queryRows('"牙买 买加"')),['both']);
  assert.deepEqual(ids(index.queryRows('"哈哈 哈哈"')),['both']);
  assert.deepEqual(ids(index.queryRows('"http server"')),['both']);
});
test('native total=0 gets advice; offset-only empty page does not',t=>{
  const index=createIndex(docs,{arm:'porter'});t.after(()=>index.close());
  const empty=index.queryPage('GPU显存');
  assert.equal(empty.page.details.total,0);
  assert.match(empty.page.text,/未找到匹配项。请检查参数格式、显式运算符/);
  assert.match(empty.page.text,/零命中不代表历史中不存在相关内容/);
  const beyond=index.queryPage('alpha',{limit:1,offset:999});
  assert.equal(beyond.page.details.total,3);assert.equal(beyond.page.details.returned,0);
  assert.doesNotMatch(beyond.page.text,/请检查参数格式/);
});
const timestamp='2026-10-05T00:00:00Z';
const branch=[...docs.map(({id,text})=>({type:'message',id,timestamp,message:{role:'user',content:text}})),
  {type:'message',id:'live',timestamp,message:{role:'user',content:'retained'}},
  {type:'compaction',id:'compact',timestamp,firstKeptEntryId:'live',summary:'',tokensBefore:10}];
test('actual worker preserves raw errors and survives; autocut uses natural language and existing gate',async()=>{
  const index=new BackgroundIndex({engineModule:new URL('../benchmark/retrieval-sqlite-worker.mjs',import.meta.url)});
  index.scan=()=>{throw new Error('unexpected synchronous fallback');};
  try {
    await index.prepare(branch,{preindexLive:true});
    await assert.rejects(index.queryRanked('alpha beta',branch,{mode:'manual'}),/explicit AND\/OR\/NOT|显式/);
    const db=native();
    try {
      for(const query of invalid) {
        let original;try {db.prepare('SELECT rowid FROM terms WHERE terms MATCH ?').all(query);}catch(error){original=error;}
        await assert.rejects(index.queryRanked(query,branch,{mode:'manual'}),error=>error.name===original.name&&error.message===original.message);
      }
    } finally {db.close();}
    assert.equal(index.failed,false);
    assert.deepEqual((await index.queryRanked('"gpu 显存"',branch,{mode:'manual'})).results.map(row=>row.id),['both']);
    const text='where alpha beta';
    const automatic=await index.queryRanked(text,branch,{mode:'auto'});
    assert.deepEqual(ids(automatic),['alpha','both','prefix']);
    assert.equal(automatic.skipped,false);
    const padded=text+' '.repeat(211-weightedLength(text));
    assert.equal((await index.queryRanked(padded,branch,{mode:'auto'})).skipped,true);
    assert.equal((await index.queryRanked('alpha'+' '.repeat(500),branch,{mode:'manual'})).total,3);
  } finally {await index.dispose();}
});
test('actual SDK tool returns zero advice, preserves native errors and keeps context autocut',async t=>{
  const {discoverAndLoadExtensions}=await import('@earendil-works/pi-coding-agent');
  const loaded=await discoverAndLoadExtensions([fileURLToPath(new URL('../benchmark/retrieval-sqlite-adapter.ts',import.meta.url))],process.cwd(),process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors,[]);
  const extension=loaded.extensions[0],tool=extension.tools.get('history_recall').definition;
  const ctx={sessionManager:{getSessionId:()=> 'raw-explicit-fixture',getBranch:()=>branch}};
  t.after(async()=>{for(const handler of extension.handlers.get('session_shutdown')??[])await handler({type:'session_shutdown',reason:'quit'},ctx);});
  await assert.rejects(tool.execute('implicit',{query:'alpha beta'},undefined,undefined,ctx),/explicit AND\/OR\/NOT|显式/);
  const empty=await tool.execute('zero',{query:'GPU显存'},undefined,undefined,ctx);
  assert.equal(empty.details.total,0);assert.match(empty.content[0].text,/零命中不代表历史中不存在相关内容/);
  const beyond=await tool.execute('beyond',{query:'alpha',offset:999},undefined,undefined,ctx);
  assert.equal(beyond.details.total,3);assert.equal(beyond.details.returned,0);
  assert.doesNotMatch(beyond.content[0].text,/请检查参数格式/);
  await assert.rejects(tool.execute('syntax',{query:'"'},undefined,undefined,ctx),{message:'unterminated string'});
  const recovered=await tool.execute('recover',{query:'"gpu 显存"'},undefined,undefined,ctx);
  assert.equal(recovered.details.total,1);
  let messages=[{role:'user',content:[{type:'text',text:'where alpha beta'}],timestamp:0}];
  for(const handler of extension.handlers.get('context')??[]) {
    const changed=await handler({type:'context',messages},ctx);if(changed?.messages)messages=changed.messages;
  }
  assert.deepEqual(messages.filter(x=>x.customType===LOCATOR_TYPE).flatMap(x=>x.content.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line).id)).sort(),['alpha','both','prefix']);
  assert.doesNotMatch(JSON.stringify(messages),/请检查参数格式/);
});

test('existing dictionary trial modes keep autocut available and explicitly mark unresolved ranking',async()=>{
  const matches=[];
  for(const mode of ['off','jieba']) {
    const index=new BackgroundIndex({engineModule:new URL('../benchmark/retrieval-sqlite-worker.mjs',import.meta.url)});
    index.workerFactory=options=>new Worker(new URL('../src/index-worker.mjs',import.meta.url),{
      workerData:options,env:{...process.env,COMPACTION_RECALL_SQLITE_HAN_PHRASE_TRIAL:mode,COMPACTION_RECALL_SQLITE_BIGRAM_ONLY:'porter'},
    });
    index.scan=()=>{throw new Error('unexpected fallback');};
    try {
      const page=await index.queryRanked('"牙买 买加"',branch,{mode:'manual',options:{page:true,limit:50}});
      assert.deepEqual(page.ids,['both']);
      assert.equal(page.page.details.jiebaRankingPending,mode==='jieba'?true:undefined);
      const rows=await index.queryRanked('"牙买 买加"',branch,{mode:'manual'});
      matches.push(rows.results.map(({id,score})=>({id,score})));
      const auto=await index.queryRanked('where GPU显存 running',branch,{mode:'auto'});
      assert.deepEqual(auto.results.map(row=>row.id),['both']);
      assert.equal(auto.skipped,false);
    } finally {await index.dispose();}
  }
  assert.deepEqual(matches[0],matches[1]);
});
