"""Resume verified six-segment checkpoints; invoke only after approval of remaining calls."""
import importlib.util,json,pathlib,shutil,tempfile,concurrent.futures,hashlib
spec=importlib.util.spec_from_file_location('r',pathlib.Path(__file__).with_name('pi-dev8.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
SOURCE=r.BENCH/'runs/pi-subscription-dev8-six-20260930'
def resume_snapshot(q,d):
 d.mkdir(parents=True,exist_ok=False);sess=d/'snapshot.jsonl';shutil.copyfile(SOURCE/q['question_id']/'snapshot.jsonl',sess)
 with tempfile.TemporaryDirectory() as td:
  full=pathlib.Path(td)/'full.jsonl';r.b.build_session(q,full,pi=True);raw=r.b.jsonl_lines(full)[1:]
 cuts=[0]+r.b.chunk_cuts(raw,6)+[len(raw)];original=[json.loads(x) for x in raw];byid={x['id']:x for x in original}
 rows=[json.loads(x) for x in r.b.jsonl_lines(sess)];existing=[x for x in rows if x.get('type')=='message' and x.get('id') in byid]
 assert [x['id'] for x in existing]==[x['id'] for x in original[:len(existing)]], 'Checkpoint is not an exact history prefix'
 assert all(x['message']['role']==byid[x['id']]['message']['role'] and x['message']['content']==byid[x['id']]['message']['content'] for x in existing), 'Checkpoint source content mismatch'
 completed=sum(x.get('type')=='compaction' for x in rows);fed=cuts.index(len(existing))
 assert fed in [completed,completed+1], 'Unsupported checkpoint boundary'
 env=r.env_for(d/'agent');results=[]
 for stage in range(completed+1,6):
  if fed<stage:r.b.append_entries(sess,raw[cuts[stage-1]:cuts[stage]]);fed=stage
  r.write(d/'progress.json',{'question':q['question_id'],'phase':'compacting','stage':stage,'reused_compactions':completed,'completed':results})
  result=r.compact(sess,env,d);results.append(result)
  r.write(d/'progress.json',{'question':q['question_id'],'phase':'compacted' if result.get('success') else 'failed','stage':stage,'reused_compactions':completed,'completed':results})
  if not result.get('success'):return False
 r.b.append_entries(sess,raw[cuts[5]:]);return True
if __name__=='__main__':
 run=r.BENCH/'runs/pi-subscription-dev8-resume372-20260930';run.mkdir(parents=True,exist_ok=False)
 qs={q['question_id']:q for q in json.loads((r.ROOT/'prototype/stacked.download.json').read_text())}
 r.write(run/'manifest.json',{'source':str(SOURCE),'model':'openai-codex/gpt-6-luna','thinking':'high','contextWindow':372000,'guard':340000,'segments':6,'remaining_compaction_rpcs':10,'remaining_answer_sessions':11,'judge':'none','source_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [pathlib.Path(__file__),r.ROOT/'prototype/pi-dev8.py',r.ROOT/'prototype/pi-context-guard.mjs']}})
 def one(qid):
  q=qs[qid];d=run/qid
  if qid=='3d86fd0a':
   d.mkdir();shutil.copyfile(SOURCE/qid/'snapshot.jsonl',d/'snapshot.jsonl');arms=['grep','indexed']
  else:
   if not resume_snapshot(q,d):return {'question':qid,'failed':'compaction'}
   arms=['native','grep','indexed']
  for arm in arms:r.answer(q,d/'snapshot.jsonl',d/arm,arm)
  return {'question':qid,'answers':len(arms)}
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
  for result in pool.map(one,['51b23612','15745da0','gpt4_65aabe59','3d86fd0a']):print(json.dumps(result),flush=True)
