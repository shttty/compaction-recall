"""Post-run reporting only: no model calls or credential access."""
import json,pathlib,hashlib,statistics,math
ROOT=pathlib.Path(__file__).resolve().parents[1];BASE=ROOT.parent/'lme-bench/runs'
OLD=BASE/'pi-subscription-dev8-six-20260930';NEW=BASE/'pi-subscription-dev8-resume372-20260930'
qs={q['question_id']:q for q in json.loads((ROOT/'prototype/stacked.download.json').read_text())}
ids=['778164c6','51b23612','ceb54acb','577d4d32','3d86fd0a','15745da0','gpt4_65aabe59','982b5123'];out=[]
def rows(p):return [json.loads(x) for x in p.read_text().split('\n') if x]
for qid in ids:
 item={'question_id':qid,'question':qs[qid]['question'],'reference':qs[qid]['answer'],'arms':{}}
 for arm in ['native','grep','indexed']:
  folder=NEW/qid/arm if (NEW/qid/arm/'result.json').exists() else OLD/qid/arm
  if not (folder/'result.json').exists():raise RuntimeError('Run incomplete: '+qid+' '+arm)
  result=json.loads((folder/'result.json').read_text());snap=folder.parent/'snapshot.jsonl'
  events=rows(folder/'session.jsonl')[len(rows(snap)):]
  responses=[x['message'] for x in events if x.get('message',{}).get('role')=='assistant']
  calls=[{'name':c.get('name'),'arguments':c.get('arguments')} for m in responses for c in m.get('content',[]) if c.get('type')=='toolCall']
  usage={k:sum(m.get('usage',{}).get(k,0) for m in responses) for k in ['input','output','cacheRead','cacheWrite','reasoning','totalTokens']}
  item['arms'][arm]={**result,'artifact_dir':str(folder),'contextWindow':372000 if folder.is_relative_to(NEW) else 272000,'guard':340000 if folder.is_relative_to(NEW) else 240000,'observed_assistant_responses':len(responses),'usage':usage,'tool_trace':calls}
 assert len({a['snapshot_sha256'] for a in item['arms'].values()})==1,'Arms do not share snapshot'
 out.append(item)
comp=[]
for parent in [OLD,NEW]:
 for p in parent.glob('*/progress.json'):
  d=json.loads(p.read_text())
  for x in d['completed']:
   comp.append({'question':d['question'],'run':parent.name,'seconds':x['seconds'],'success':x.get('success'),'preflight':x.get('preflightEstimateWithReserve'),'usage':x.get('data',{}).get('usage',{})})
speed={}
for arm in ['native','grep','indexed']:
 values=[q['arms'][arm]['seconds'] for q in out];speed[arm]={'n':len(values),'median_seconds':statistics.median(values),'p95_nearest_rank_seconds':sorted(values)[math.ceil(.95*len(values))-1],'tool_calls':sum(len(q['arms'][arm]['tool_calls']) for q in out),'assistant_responses':sum(q['arms'][arm]['observed_assistant_responses'] for q in out),'total_answer_seconds':sum(values)}
report={'speed':speed,'model':'openai-codex/gpt-6-luna','thinking':'high','sdk':'0.99.1','segments':6,'judge':'none; references are post-run comparison only','questions':out,'compaction_rpcs':comp,'notes':['Per-question snapshot hashes verified identical across arms.','Metadata/guard changed from272k/240k to372k/340k for resumed work; no model substitution.','Compaction RPC can issue multiple model requests; exact HTTP request count/retries were not instrumented.','Observed assistant responses count completed answer-model turns, not guaranteed HTTP attempts.','Pilot and interrupted four-segment work plus safety-blocked attempts incurred additional usage and remain in their original run directories.']}
(ROOT/'prototype/pi-dev8-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'questions':len(out),'successful_answer_sessions':sum(a.get('rc')==0 for q in out for a in q['arms'].values()),'compaction_rpcs':len(comp),'assistant_responses':sum(a['observed_assistant_responses'] for q in out for a in q['arms'].values())}))
