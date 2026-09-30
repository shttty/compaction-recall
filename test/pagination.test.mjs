import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecallPage, buildLocator, RECALL_PAGE_CHARS, LOCATOR_CHARS } from '../locator.ts';
const msg = (id, text) => ({ type: 'message', id, timestamp: '2026-09-30T00:00:00.000Z', parentId: null,
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 } });
const branch = old => [...old, msg('live', 'quasar live'), { type: 'compaction', id: 'c', firstKeptEntryId: 'live', timestamp: '2026-09-30T00:00:00.000Z' }];
const rows = text => text.split('\n').filter(line=>line.startsWith('{')).map(JSON.parse);

test('manual default page returns 50 plus continuation; automatic hints remain five / 1500', () => {
  const b = branch(Array.from({ length: 73 }, (_,i) => msg(`id${i}`, `quasar unique detail ${i}`)));
  const first = buildRecallPage('quasar', b);
  assert.deepEqual(first.details, { total: 73, offset: 0, limit: 50, returned: 50,
    nextOffset: 50, hasMore: true, budgetChars: RECALL_PAGE_CHARS, budgetExceeded: false });
  const second = buildRecallPage('quasar', b, { offset: first.details.nextOffset });
  assert.equal(second.details.returned, 23);
  assert.equal(second.details.nextOffset, null);
  assert.equal(second.details.hasMore, false);
  assert.deepEqual([...rows(first.text), ...rows(second.text)].map(r=>r.id), Array.from({ length: 73 }, (_,i)=>`id${72-i}`));
  assert.match(first.text.split('\n')[0], /"nextOffset":50/);
  const auto = buildLocator('quasar', b);
  assert.equal(rows(auto).length, 5);
  assert.ok(Array.from(auto).length <= LOCATOR_CHARS);
  assert.deepEqual(rows(auto), rows(first.text).slice(0,5));
});

test('deduplication and tie order are stable across pages and query repeats', () => {
  const old = Array.from({ length: 9 },(_,i)=>msg(`id${i}`, `quasar unique ${i}`));
  const b = branch([...old, msg('duplicate-content', 'quasar unique 2'), msg('id1', 'quasar updated id1')]);
  const all = buildRecallPage('quasar',b,{ limit:50 });
  assert.equal(all.details.total,9);
  const collected=[];
  let offset=0;
  do {
    const page = buildRecallPage('quasar',b,{limit:2,offset});
    assert.deepEqual(page,buildRecallPage('quasar',b,{limit:2,offset}));
    collected.push(...rows(page.text)); offset=page.details.nextOffset;
  } while(offset!==null);
  assert.deepEqual(collected,rows(all.text));
  assert.equal(new Set(collected.map(r=>r.id)).size,9);
  assert.equal(collected[0].id,'id1');
  assert.equal(collected[1].id,'duplicate-content');
});

test('budget-shortened pages resume at the unreturned row without gaps', () => {
  const b = branch(Array.from({length:40},(_,i)=>msg(`${i}-`+'m'.repeat(400), `quasar unique detail ${i} `+'😀'.repeat(120))));
  const collected=[]; let offset=0, pageCount=0;
  do {
    const page=buildRecallPage('quasar',b,{limit:50,offset});
    assert.equal(page.details.total,40);
    assert.ok(page.details.returned>0 && page.details.returned<50);
    assert.ok(Array.from(page.text).length<=RECALL_PAGE_CHARS);
    assert.equal(page.details.budgetExceeded,false);
    assert.ok(page.text.isWellFormed());
    if(page.details.hasMore) assert.equal(page.details.nextOffset,offset+page.details.returned);
    collected.push(...rows(page.text).map(r=>r.id));
    offset=page.details.nextOffset; pageCount++;
  }while(offset!==null);
  assert.ok(pageCount>1);
  assert.deepEqual(collected,Array.from({length:40},(_,i)=>`${39-i}-`+'m'.repeat(400)));
});

test('one oversized metadata row is explicit and advances instead of disappearing or looping', () => {
  const huge='huge-'+'<'.repeat(RECALL_PAGE_CHARS);
  const b=branch([msg('small','quasar small'),msg(huge,'quasar huge')]);
  const first=buildRecallPage('quasar',b);
  assert.equal(first.details.returned,1);
  assert.equal(first.details.budgetExceeded,true);
  assert.equal(first.details.nextOffset,1);
  assert.equal(rows(first.text)[0].id,huge);
  assert.ok(Array.from(first.text).length>RECALL_PAGE_CHARS);
  const second=buildRecallPage('quasar',b,{offset:first.details.nextOffset});
  assert.equal(second.details.budgetExceeded,false);
  assert.deepEqual(rows(second.text).map(r=>r.id),['small']);
  assert.equal(second.details.nextOffset,null);
});

test('empty, no-hit, out-of-range and invalid page parameters have defined behavior', () => {
  const b=branch([msg('one','quasar unique')]);
  for(const query of ['', 'the and','unmatched']) {
    const page=buildRecallPage(query,b);
    assert.equal(page.details.total,0); assert.equal(page.details.returned,0);
    assert.equal(page.details.hasMore,false); assert.equal(page.details.nextOffset,null);
    assert.match(page.text,/does not prove absence/);
  }
  const beyond=buildRecallPage('quasar',b,{offset:100});
  assert.equal(beyond.details.total,1); assert.equal(beyond.details.returned,0);
  assert.equal(beyond.details.nextOffset,null); assert.equal(beyond.details.hasMore,false);
  assert.match(beyond.text,/offset is beyond/);
  for(const options of [{limit:0},{limit:51},{limit:1.5},{offset:-1},{offset:1.5},{offset:Infinity}]) {
    assert.throws(()=>buildRecallPage('quasar',b,options),RangeError);
  }
});

test('snippets center the rarest matched query term rather than the first common hit', () => {
  const b=branch([msg('focus', 'common '+'😀'.repeat(200)+' rareNebula '+'🌟'.repeat(200)),
    msg('other1','common ordinary one'),msg('other2','common ordinary two')]);
  const auto=rows(buildLocator('common rareNebula',b));
  const manual=rows(buildRecallPage('common rareNebula',b).text);
  assert.deepEqual(manual,auto);
  const focus=manual.find(r=>r.id==='focus');
  assert.match(focus.snippet,/rareNebula/);
  assert.doesNotMatch(focus.snippet,/common/);
  assert.ok(Array.from(focus.snippet).length<=122);
  assert.ok(focus.snippet.isWellFormed());
  const before=Array.from(focus.snippet.split('rareNebula')[0]).length;
  assert.ok(before>=50 && before<=65);
});

test('equally informative terms choose the earlier source position, independent of query order', () => {
  const b=branch([msg('tie','quasar '+'x'.repeat(200)+' nebula')]);
  const first=rows(buildRecallPage('nebula quasar',b).text)[0].snippet;
  const second=rows(buildRecallPage('quasar nebula',b).text)[0].snippet;
  assert.equal(first,second);
  assert.match(first,/quasar/);
  assert.doesNotMatch(first,/nebula/);
});

test('duplicate removal precedes scoring and chooses newest representative', async () => {
  const { rankLocatorCandidates }=await import('../locator.ts');
  const shared='quasar same snippet';
  const make=(id,recency,matches)=>({id,recency,text:shared,date:'2026-09-30',role:'user',offset:0,matches:new Set(matches)});
  const ranked=rankLocatorCandidates([make('older',0,['quasar','bonus']),make('newer',1,['quasar'])],new Map([['quasar',2],['bonus',1]]),2);
  assert.deepEqual(ranked.map(x=>x.id),['newer']);
});

test('automatic top-five selection precedes budget and never backfills rank six',async()=>{
  const { renderLocators }=await import('../locator.ts');
  const candidates=Array.from({length:6},(_,i)=>({id:i===0?'x'.repeat(2000):`rank${i+1}`,recency:6-i,text:`quasar unique ${i}`,date:'2026-09-30',role:'user',offset:0,matches:new Set(['quasar'])}));
  const text=renderLocators(candidates,new Map([['quasar',6]]),6);
  assert.equal(rows(text).length,4);
  assert.doesNotMatch(text,/rank6/);
});
