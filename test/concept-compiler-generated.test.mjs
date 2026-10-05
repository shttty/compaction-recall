import assert from 'node:assert/strict';
import test from 'node:test';
import * as author from '../prototype/concept-group-query/original/query.ts';
import * as generated from '../prototype/soft-match-sqlite/concept-query-compiler.mjs';
const outcomes = (module,input,analyze) => {
  try{return {plan:module.compileFts5(input,analyze)};}
  catch(error){return {error:{name:error.name,code:error.code,message:error.message}};}
};
test('worker-loadable JS compiler preserves unchanged author semantics and errors',()=>{
  const cases=[null,[],{},'legacy',{query:'legacy'},{concepts:[]},{concepts:[[]]},
    {concepts:[[' cedar ','cedar'],['harbor','port']],match:'all',exclude:['android']},
    {concepts:[['" AND OR ( : *']],match:'any'}, {concepts:[['cedar']],exclude:['a\0']},
    {concepts:[['cedar']],match:'invalid'}, {concepts:[Array(5).fill('cedar')]},
    {concepts:Array(6).fill(['cedar'])}, {concepts:[['cedar']],exclude:Array(6).fill('android')},
    {concepts:[['x'.repeat(256)]]}, {concepts:[['x'.repeat(257)]]},
    {concepts:[['𠀀'.repeat(256)]]}, {concepts:[['\ud800']]},
    {concepts:Array.from({length:5},(_,i)=>Array.from({length:4},(_,j)=>`${i}${j}`+'x'.repeat(254)))}];
  for(const analyze of [s=>[[s]],s=>[['httpserver'],['http','server']],()=>[],()=>{throw Error('analyzer');},
    ()=>[Array(17).fill('word')],()=>Array(5).fill(['word']),()=>[[' outer ']],()=>[['a'.repeat(4097)]]]){
    for(const input of cases)assert.deepEqual(outcomes(generated,input,analyze),outcomes(author,input,analyze));
  }
});
