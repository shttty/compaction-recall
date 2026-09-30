"""Actual Pi subscription DEV8, isolated sessions; no judge and no credential copies."""
import argparse, concurrent.futures, hashlib, importlib.util, json, os, pathlib, shutil, subprocess, time, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]; BENCH=ROOT.parent/'lme-bench'
spec=importlib.util.spec_from_file_location('bench',BENCH/'bench.py'); b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
CLI=ROOT.parent/'pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
PROFILE=BENCH/'.pi-profile'; ADAPTER=ROOT/'prototype/pi-benchmark-adapter.mjs'
BASE=['node',str(CLI),'--offline','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-approve','--model','openai-codex/gpt-6-luna:high','--system-prompt','You are a helpful assistant.']
def write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def env_for(folder,arm='native'):
 folder.mkdir(parents=True,exist_ok=False)
 (folder/'auth.json').symlink_to(PROFILE/'auth.json')
 (folder/'models.json').symlink_to(PROFILE/'models.json')
 write(folder/'settings.json',{'compaction':{'enabled':False}})
 return {**os.environ,'PI_CODING_AGENT_DIR':str(folder),'PI_RECALL_BENCH_ARM':arm,'PI_RECALL_TIMING_FILE':str(folder.parent/'timing.jsonl')}
def preflight(session):
 result=subprocess.run(['node',str(ROOT/'prototype/pi-context-estimate.mjs'),str(session)],capture_output=True,text=True,check=True)
 estimate=json.loads(result.stdout)['estimatedTokens']+5000
 if estimate>340000:raise ValueError(f'Conservative context estimate {estimate} exceeds 340000 safety ceiling')
 return estimate
def compact(session,env,cwd):
 estimate=preflight(session)
 start=time.monotonic(); p=subprocess.Popen(BASE+['-e',str(ROOT/'prototype/pi-stage-events.mjs'),'--no-tools','--mode','rpc','--session',str(session)],cwd=cwd,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 timing={}
 def interaction():
  p.stdin.write('{"id":"ready","type":"get_state"}\n');p.stdin.flush()
  for line in p.stdout:
   try:event=json.loads(line)
   except ValueError:continue
   if event.get('id')=='ready' and event.get('type')=='response':
    timing['startupToRpcReadyMs']=(time.monotonic()-start)*1000;timing['rpcStart']=time.monotonic();p.stdin.write('{"id":"compact","type":"compact"}\n');p.stdin.flush()
   if event.get('id')=='compact' and event.get('type')=='response':
    timing['rpcEnd']=time.monotonic();return event
  return {'success':False,'error':'No compact response'}
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
  job=pool.submit(interaction)
  try:result=job.result(timeout=900)
  except concurrent.futures.TimeoutError:p.kill();result={'success':False,'error':'Compaction timeout'}
  finally:
   p.stdin.close()
   try:p.wait(timeout=15)
   except subprocess.TimeoutExpired:p.kill();p.wait()
 return {'timing':{'startupToRpcReadyMs':timing.get('startupToRpcReadyMs'),'compactionRpcWallMs':(timing['rpcEnd']-timing['rpcStart'])*1000 if 'rpcEnd' in timing else None},'preflightEstimateWithReserve':estimate,'seconds':time.monotonic()-start,'rc':p.returncode,'stderr':p.stderr.read()[-2000:],**result}
def snapshot(q,d,segments=4,pilot=False):
 stages=1 if pilot else segments-1
 d.mkdir(parents=True,exist_ok=True);(b.RUNS/'cwd').mkdir(parents=True,exist_ok=True);session=d/'snapshot.jsonl';status=d/'progress.json'
 b.build_session(q,session,pi=True)
 lines=b.jsonl_lines(session);head,msgs=lines[:1],lines[1:];cuts=[0]+b.chunk_cuts(msgs,segments)+[len(msgs)]
 session.write_text('\n'.join(head+msgs[:cuts[1]])+'\n')
 env=env_for(d/'agent');out=[]
 for i in range(stages):
  if i:b.append_entries(session,msgs[cuts[i]:cuts[i+1]])
  write(status,{'question':q['question_id'],'phase':'compacting','stage':i+1,'completed':out})
  result=compact(session,env,d);out.append(result);write(status,{'question':q['question_id'],'phase':'compacted' if result.get('success') else 'failed','stage':i+1,'completed':out})
  if not result.get('success'):return False
 if not pilot:b.append_entries(session,msgs[cuts[segments-1]:])
 return True
def answer(q,snap,d,arm):
 d.mkdir(parents=True,exist_ok=False);session=d/'session.jsonl';shutil.copyfile(snap,session);env=env_for(d/'agent',arm)
 extra=['--no-tools'] if arm=='native' else ['-e',str(ADAPTER),'--tools','history_grep,history_expand'+(',history_recall' if arm=='indexed' else '')]
 started=time.monotonic()
 try:
  estimate=preflight(session)
  p=subprocess.run(BASE+extra+['-e',str(ROOT/'prototype/pi-stage-events.mjs'),'-e',str(ROOT/'prototype/pi-context-guard.mjs'),'--session',str(session),'-p',b.ASK.format(q['question_date'],q['question'])],cwd=d,env=env,capture_output=True,text=True,timeout=900)
  rows=[json.loads(x) for x in b.jsonl_lines(session)];calls=[r['message']['toolName'] for r in rows if r.get('message',{}).get('role')=='toolResult']
  result={'question_id':q['question_id'],'arm':arm,'seconds':time.monotonic()-started,'rc':p.returncode,'answer':p.stdout.strip(),'stderr':p.stderr[-2000:],'tool_calls':calls,'snapshot_sha256':hashlib.sha256(snap.read_bytes()).hexdigest()}
 except ValueError as e:result={'question_id':q['question_id'],'arm':arm,'error':str(e)}
 except subprocess.TimeoutExpired:result={'question_id':q['question_id'],'arm':arm,'error':'Answer timeout'}
 write(d/'result.json',result);return result
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--run',required=True);a.add_argument('--pilot',action='store_true');a.add_argument('--jobs',type=int,default=4);a.add_argument('--segments',type=int,default=4);a.add_argument('--only');args=a.parse_args()
 if args.segments<4:raise ValueError('At least four segments required')
 run=BENCH/'runs'/args.run;run.mkdir(parents=True,exist_ok=False)
 questions={q['question_id']:q for q in json.loads((ROOT/'prototype/stacked.download.json').read_text())};selected=[questions[x] for x in b.DEV8 if not args.only or x==args.only]
 write(run/'manifest.json',{'model':'openai-codex/gpt-6-luna','thinking':'high','sdk':'0.99.1','questions':[q['question_id'] for q in selected],'cycles':args.segments-1,'segments':args.segments,'preflight_ceiling':340000,'prompt_reserve':5000,'arms':{'native':[],'grep':['history_grep','history_expand'],'indexed':['history_recall','history_grep','history_expand']},'source_sha256':hashlib.sha256((ROOT/'prototype/stacked.download.json').read_bytes()).hexdigest(),'code_sha256':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [pathlib.Path(__file__),ADAPTER,ROOT/'locator.ts',ROOT/'prototype/inverted-index.mjs',ROOT/'recall-extension.ts',ROOT/'prototype/pi-context-guard.mjs',ROOT/'prototype/pi-context-estimate.mjs',ROOT/'timing.ts',ROOT/'prototype/stage-timing.mjs',ROOT/'prototype/pi-stage-events.mjs']},'judge':'none'})
 if args.pilot:
  q=questions['577d4d32'];print(json.dumps({'pilot_success':snapshot(q,run/q['question_id'],args.segments,True)}),flush=True)
 else:
  def one(q):
   d=run/q['question_id']
   try:
    if not snapshot(q,d,args.segments):return {'question_id':q['question_id'],'failed':'snapshot'}
   except Exception as e:
    write(d/'failure.json',{'type':type(e).__name__,'error':str(e)});return {'question_id':q['question_id'],'failed':'preflight-or-runner'}
   results=[]
   for arm in ['native','grep','indexed']:results.append(answer(q,d/'snapshot.jsonl',d/arm,arm))
   return {'question_id':q['question_id'],'answers':len(results)}
  with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
   for result in pool.map(one,selected):print(json.dumps(result),flush=True)
