"""Parent-side monotonic RPC observation; never logs message content or provider payloads."""
import json,subprocess,time,threading,queue,pathlib

def run_rpc(command,env,cwd,prompt=None,timeout=900,settle_only=False,collect_memory=False,request=None):
 start=time.monotonic();p=subprocess.Popen(command,cwd=cwd,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 events=queue.Queue();stderr=[]
 def read():
  for line in p.stdout:
   try:events.put((time.monotonic(),json.loads(line)))
   except ValueError:pass
  events.put((time.monotonic(),None))
 def errors():
  for line in p.stderr:stderr.append(line)
 threads=[threading.Thread(target=read,daemon=True),threading.Thread(target=errors,daemon=True)]
 for t in threads:t.start()
 p.stdin.write('{"id":"ready","type":"get_state"}\n');p.stdin.flush()
 metrics={'startupToRpcReadyMs':None,'firstVisibleTextFromSpawnMs':None,'firstThinkingFromSpawnMs':None,'firstToolDeltaFromSpawnMs':None,'promptToCompleteMs':None,'providerTTFTMs':None,'modelTurns':0,'toolBatches':0,'toolCalls':0,'userMessages':0}
 prompt_start=None;outcome='incomplete';settle_deadline=None
 response=None;peak_rss=None
 try:
  while time.monotonic()-start<timeout:
   if collect_memory:
    try:
     for line in pathlib.Path(f'/proc/{p.pid}/status').read_text().splitlines():
      if line.startswith('VmHWM:'):
       peak_rss=max(peak_rss or 0,int(line.split()[1]));break
    except (OSError,ValueError):pass
   if settle_deadline and time.monotonic()>=settle_deadline:outcome='offline-ready';break
   try:at,e=events.get(timeout=.1)
   except queue.Empty:continue
   if e is None:break
   if e.get('id')=='ready' and e.get('type')=='response':
    if not e.get('success'):outcome='readiness-error';break
    metrics['startupToRpcReadyMs']=(at-start)*1000
    if settle_only:settle_deadline=at+2
    else:
     prompt_start=time.monotonic();p.stdin.write(json.dumps(request or {'id':'answer','type':'prompt','message':prompt})+'\n');p.stdin.flush()
   if request and e.get('id')==request['id'] and e.get('type')=='response':
    response=e;outcome='completed' if e.get('success') else 'request-error';break
   if e.get('id')=='answer' and e.get('type')=='response' and not e.get('success'):outcome='prompt-error';break
   kind=e.get('type')
   if kind=='message_end' and e.get('message',{}).get('role')=='user':metrics['userMessages']+=1
   if kind=='turn_start':metrics['modelTurns']+=1
   if kind=='turn_end' and e.get('toolResults'):metrics['toolBatches']+=1
   if kind=='tool_execution_start':metrics['toolCalls']+=1
   if kind=='message_update':
    field={'text_delta':'firstVisibleTextFromSpawnMs','thinking_delta':'firstThinkingFromSpawnMs','toolcall_delta':'firstToolDeltaFromSpawnMs'}.get(e.get('assistantMessageEvent',{}).get('type'))
    if field and metrics[field] is None:metrics[field]=(at-start)*1000
   if kind=='agent_end' and prompt_start is not None:
    metrics['promptToCompleteMs']=(at-prompt_start)*1000;outcome='completed';break
  else:outcome='timeout'
 finally:
  p.stdin.close()
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:p.kill();p.wait();outcome+='-forced-shutdown'
  for t in threads:t.join(timeout=1)
  p.stdout.close();p.stderr.close()
 metrics['processWallMs']=(time.monotonic()-start)*1000
 result={'rc':p.returncode,'outcome':outcome,'timing':metrics,'stderr':''.join(stderr)[-2000:]}
 if collect_memory:result['memory']={'peakObservedRssKiB':peak_rss,'method':'sampled /proc VmHWM; process incl. worker threads'}
 if request:result['response']=response
 return result
