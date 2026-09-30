import json,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[1];R=ROOT.parent/'lme-bench/runs/pi-tui-warm-20260930'
def read(p):return [json.loads(x) for x in p.read_text().splitlines() if x]
result={'questionId':'577d4d32','runtime':'Pi0.99.1 genuine Herdr0.9.3 TUI','model':'openai-codex/gpt-6-luna','thinking':'high','arms':{},'typing':next(e for e in read(R/'herdr-driver-events.jsonl') if e['event']=='typing_finished'),'limitations':['One question, one observation per arm; no general speed/quality claim.','Setup delay warmed the index before hello; this is not a fresh-start three-second test.','Hello also warms provider/model caches; the same process handles both turns.','Only common typing interval measured, per-arm first/last keystrokes unavailable.','First visible text is not provider TTFT. Inclusive stage spans overlap and must not be summed.']}
question=(R/'question.txt').read_text()
for arm in ['native','grep','indexed']:
 events=read(R/arm/'tui-events.jsonl');timing=read(R/arm/'timing.jsonl');phases={}
 for cycle,label in [(1,'hello'),(2,'question')]:
  start=next(x for x in events if x['event']=='input' and x['cycle']==cycle);end=next(x for x in events if x['event']=='completed' and x['cycle']==cycle)
  def pos(e):return e.get('clockOriginMs',0)+e.get('atMs',e.get('startMs',0))
  spans=[e for e in timing if start['monotonicMs']<=pos(e)<=end['monotonicMs']]
  text=next((e for e in spans if e['stage']=='first_visible_text_delta'),None)
  phases[label]={'wallMs':end['monotonicMs']-start['monotonicMs'],'firstVisibleTextMs':pos(text)-start['monotonicMs'] if text else None,'providerTtftMs':None,'providerPreparedCount':sum(e['stage']=='provider_request_prepared' for e in spans),'criticalPathIndexWaitMs':sum(e.get('wallMs',0) for e in spans if e['stage']=='critical_path_index_wait'),'stages':spans,'inputEpochMs':start['epochMs']}
 rows=read(R/arm/'session.jsonl');last=next(i for i in range(len(rows)-1,-1,-1) if rows[i].get('message',{}).get('role')=='user');messages=[x['message'] for x in rows[last:] if 'message'in x];user=messages[0]['content'];ut=user if isinstance(user,str) else ''.join(c.get('text','') for c in user if c.get('type')=='text');assistants=[m for m in messages if m.get('role')=='assistant'];answer=''.join(c.get('text','') for c in assistants[-1]['content'] if c.get('type')=='text')
 ready=[e for e in timing if e['stage']=='background_index_ready'];origin=events[0]['epochMs']-events[0]['monotonicMs']
 result['arms'][arm]={'phases':phases,'answer':answer,'exactPrompt':ut==question,'referenceMatch':arm!='native','toolNames':[m.get('toolName') for m in messages if m.get('role')=='toolResult'],'indexReady':[{'buildWallMs':e['wallMs'],'beforeQuestionMs':phases['question']['inputEpochMs']-(origin+e['clockOriginMs']+e['atMs']),'mainExtractionMs':e.get('mainExtractionMs')} for e in ready]}
(ROOT/'prototype/pi-tui-warm-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
for arm,a in result['arms'].items():
 print(arm,{k:{x:v for x,v in p.items() if x!='stages'} for k,p in a['phases'].items()},a['indexReady'])
