import test from 'node:test';import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import { loadPreindexConfig } from '../prototype/preindex-config.mjs';
const fixture=work=>{const dir=mkdtempSync(join(tmpdir(),'pi-recall-config-'));mkdirSync(join(dir,'.pi'));try{work(dir,content=>writeFileSync(join(dir,'.pi','pi-recall.json'),content));}finally{rmSync(dir,{recursive:true,force:true});}};
test('defaults10/10 and independent environment > file > default precedence',()=>fixture((dir,write)=>{
 assert.deepEqual(loadPreindexConfig(dir,{env:{}}),{userCycles:10,toolRounds:10});
 write(JSON.stringify({preindex:{userCycles:5,toolRounds:20}}));
 assert.deepEqual(loadPreindexConfig(dir,{env:{}}),{userCycles:5,toolRounds:20});
 assert.deepEqual(loadPreindexConfig(dir,{env:{PI_RECALL_PREINDEX_TURNS:'30'}}),{userCycles:30,toolRounds:20});
}));
test('malformed, oversized, unknown and invalid values warn without echoing content or failing',()=>fixture((dir,write)=>{
 let warnings=[];const load=env=>loadPreindexConfig(dir,{env,warn:x=>warnings.push(x)});
 write('{SENSITIVE_CONTENT');assert.deepEqual(load({}),{userCycles:10,toolRounds:10});assert.equal(warnings.length,1);assert.ok(!warnings.join().includes('SENSITIVE_CONTENT'));
 write(JSON.stringify({preindex:{userCycles:'5',toolRounds:101},unknown:'SENSITIVE_CONTENT'}));warnings=[];
 assert.deepEqual(load({PI_RECALL_PREINDEX_TURNS:'5e1',PI_RECALL_PREINDEX_TOOL_ROUNDS:'0'}),{userCycles:10,toolRounds:10});assert.equal(warnings.length,5);
 write(JSON.stringify({preindex:{userCycles:6,toolRounds:7}}));assert.deepEqual(load({PI_RECALL_PREINDEX_TURNS:''}),{userCycles:6,toolRounds:7});
 write(' '.repeat(65537));assert.deepEqual(load({}),{userCycles:10,toolRounds:10});
}));
