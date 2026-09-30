"""Sanitized webpage dataset from the fresh instrumented Pi run. No inference/credentials."""
import json,pathlib,statistics,math,hashlib,collections
ROOT=pathlib.Path(__file__).resolve().parents[1];BASE=ROOT.parent/'lme-bench/runs'
RUNS=[BASE/'pi-dev8-timed-pilot-20260930',BASE/'pi-dev8-timed-main-20260930']
IDS=['778164c6','51b23612','ceb54acb','577d4d32','3d86fd0a','15745da0','gpt4_65aabe59','982b5123']
questions={q['question_id']:q for q in json.loads((ROOT/'prototype/stacked.download.json').read_text())}
def readrows(path):return [json.loads(x) for x in path.read_text().split('\n') if x]
def events(path):return readrows(path) if path.exists() else []
def stats(values):
 return {'n':len(values),'median':statistics.median(values) if values else None,'p95NearestRank':sorted(values)[math.ceil(.95*len(values))-1] if values else None,'max':max(values) if values else None}
def summed(ev,stage,field):
 values=[e[field] for e in ev if e['stage']==stage and isinstance(e.get(field),(int,float))];return sum(values) if values else None
def union_ms(intervals):
 merged=[]
 for start,end in sorted(intervals):
  if end<=start:continue
  if merged and start<=merged[-1][1]:merged[-1][1]=max(end,merged[-1][1])
  else:merged.append([start,end])
 return sum(end-start for start,end in merged)
def trace_summary(ev):
 windows=[e for e in ev if e['stage']=='event_loop_window'];requests=[]
 for e in ev:
  if e['stage']=='provider_request_prepared':
   related=[x for x in ev if x.get('timerId')==e.get('timerId') and x.get('requestId')==e.get('requestId')]
   get=lambda stage:next((x.get('sinceRequestMs') for x in related if x['stage']==stage),None)
   requests.append({'requestId':e['requestId'],'responseHeadersMs':get('provider_response_headers'),'firstVisibleTextMs':get('first_visible_text_delta'),'firstThinkingMs':get('first_thinking_delta'),'firstToolDeltaMs':get('first_toolcall_delta'),'responseEndMs':get('assistant_response_end'),'providerTTFTMs':None})
 spans=[{'stage':e['stage'],'durationMs':e['durationMs'],'parentId':e.get('parentId'),'id':e.get('id'),'execution':e.get('execution')} for e in ev if e.get('type')=='span']
 workerStages=[{**s,'rawExecution':s.get('execution'),'execution':'worker_thread','thread':'worker'} for e in ev if e['stage']=='worker_operation' for s in e.get('stages',[]) if s.get('type')=='span']
 waits=[(e.get('timerId'),e.get('atMs',0)-e['wallMs'],e.get('atMs',0)) for e in ev if e['stage']=='critical_path_index_wait']
 overlap=0
 for build in [e for e in ev if e['stage']=='background_index_ready']:
  start=build.get('atMs',0)-build['wallMs'];end=build.get('atMs',0)
  overlap+=union_ms([(max(start,w_start),min(end,w_end)) for timer,w_start,w_end in waits if timer==build.get('timerId')])
 wait_union=sum(union_ms([(start,end) for timer,start,end in waits if timer==tid]) for tid in {x[0] for x in waits})
 return {'foregroundIndexWaitUnionMs':wait_union if waits else None,'backgroundForegroundWaitOverlapMs':overlap if waits else None,'mainLoopMaxLagMs':max((e['maxLagMs'] for e in windows),default=None),'heartbeatSamples':sum(e['samples'] for e in windows),'heartbeatSamplesOver16ms':sum(e['over16ms'] for e in windows),'providerRequestsObserved':len(requests) if requests else None,'modelRequests':requests,'toolSpans':[s for s in spans if s['stage'].startswith('tool_')],'autoContextWallMs':summed(ev,'auto_context_total','durationMs'),'foregroundIndexWaitMs':summed(ev,'critical_path_index_wait','wallMs'),'backgroundReadyWallMs':summed(ev,'background_index_ready','wallMs'),'backgroundReadiness':[{'kind':e.get('kind'),'wallMs':e.get('wallMs'),'mainExtractionMs':e.get('mainExtractionMs'),'workerHeapBytes':e.get('workerHeapBytes')} for e in ev if e['stage']=='background_index_ready'],'mainTransferSubmissionMs':summed(ev,'worker_post_message','mainThreadMs'),'workerOperationMs':summed(ev,'worker_operation','workerMs'),'workerStages':workerStages,'mainStages':[{**s,'thread':'main'} for s in spans],'preindexConfig':[{'userCycles':e['userCycles'],'toolRounds':e['toolRounds']} for e in ev if e['stage']=='preindex_config'],'preindexTriggers':dict(collections.Counter(e.get('trigger') for e in ev if e['stage']=='preindex_scheduled')),'timingEventsDropped':sum(e.get('count',0) for e in ev if e['stage']=='dropped_timing_events'),'workerFailures':sum(e['stage']=='worker_failed' for e in ev),'missingMetrics':['genuine server TTFT','exact Pi internal load/parse breakdown','internal compaction model streaming timings']}
result=[];compactions=[]
for qid in IDS:
 folder=next((run/qid for run in RUNS if (run/qid/'progress.json').exists()),None)
 if folder is None:raise RuntimeError('Missing question '+qid)
 q=questions[qid];item={'id':qid,'question':q['question'],'reference':q['answer'],'arms':{}}
 progress=json.loads((folder/'progress.json').read_text())
 for i,c in enumerate(progress['completed']):
  compactions.append({'questionId':qid,'stage':i+1,'success':c.get('success'),'wallSeconds':c['seconds'],'timing':c.get('timing'),'preflightTiming':c.get('preflightTiming'),'usage':c.get('data',{}).get('usage',{}),'foregroundClass':'explicit compaction waiting; aggregate includes model/network','internalProviderTTFTMs':None})
 item['compactionTiming']=trace_summary(events(folder/'timing.jsonl'))
 item['ingestionTiming']=json.loads((folder/'ingestion-timing.json').read_text())
 for arm in ['native','grep','indexed']:
  original=folder/arm;retry=folder/f'retry1-{arm}';d=retry if (retry/'result.json').exists() else original
  if not (d/'result.json').exists():raise RuntimeError('Incomplete '+qid+' '+arm)
  a=json.loads((d/'result.json').read_text());snap=folder/'snapshot.jsonl';fresh=readrows(d/'session.jsonl')[len(readrows(snap)):]
  assistants=[e['message'] for e in fresh if e.get('message',{}).get('role')=='assistant']
  usage={key:sum(m.get('usage',{}).get(key,0) for m in assistants) for key in ['input','output','cacheRead','cacheWrite','reasoning','totalTokens']}
  tooltrace=[{'name':c.get('name'),'arguments':c.get('arguments')} for m in assistants for c in m.get('content',[]) if c.get('type')=='toolCall']
  terminal=assistants[-1].get('stopReason') if assistants else None
  terminal_error='websocket_closed_1000' if assistants and assistants[-1].get('errorMessage')=='WebSocket closed 1000' else ('provider_error' if terminal=='error' else None)
  attempts=[]
  for attempt_dir in [original]+([retry] if retry!=original and (retry/'result.json').exists() else []):
   attempt=json.loads((attempt_dir/'result.json').read_text());attempt_rows=readrows(attempt_dir/'session.jsonl')[len(readrows(snap)):];last=next((e['message'] for e in reversed(attempt_rows) if e.get('message',{}).get('role')=='assistant'),{})
   attempts.append({'attempt':len(attempts)+1,'wallSeconds':attempt.get('seconds'),'rc':attempt.get('rc'),'terminalStopReason':last.get('stopReason'),'providerRequestsPreparedObserved':sum(e['stage']=='provider_request_prepared' for e in events(attempt_dir/'timing.jsonl')),'assistantResponsesObserved':sum(e.get('message',{}).get('role')=='assistant' for e in attempt_rows),'errorCategory':'websocket_closed_1000' if last.get('errorMessage')=='WebSocket closed 1000' else None})
  item['arms'][arm]={'attempts':attempts,'validAnswer':a.get('rc')==0 and terminal!='error' and bool(a.get('answer','').strip()),'terminalStopReason':terminal,'errorCategory':terminal_error,'answer':a.get('answer'),'rc':a.get('rc'),'outcome':'model-error' if terminal=='error' else a.get('outcome'),'wallSeconds':a.get('seconds'),'timing':a.get('timing'),'preflightTiming':a.get('preflightTiming'),'toolCalls':a.get('tool_calls',[]),'toolTrace':tooltrace,'assistantResponses':len(assistants),'usage':usage,'snapshotHash':a.get('snapshot_sha256'),'stages':trace_summary(events(d/'timing.jsonl'))}
 assert len({x['snapshotHash'] for x in item['arms'].values()})==1
 result.append(item)
evaluations=json.loads((ROOT/'prototype/pi-dev8-timed-evaluation.json').read_text())['answers']
for question in result:
 for arm,answer in question['arms'].items():
  reviewed=evaluations[question['id']][arm]
  if reviewed['answerSha256']!=hashlib.sha256(answer['answer'].encode()).hexdigest():raise RuntimeError('Answer changed after reference review')
  answer['evaluation']=reviewed
aggregate={}
for arm in ['native','grep','indexed']:
 rows=[q['arms'][arm] for q in result]
 aggregate[arm]={'answerSeconds':stats([x['wallSeconds'] for x in rows]),'firstVisibleTextMs':stats([x['timing']['firstVisibleTextFromSpawnMs'] for x in rows if x['timing']['firstVisibleTextFromSpawnMs'] is not None]),'mainLoopMaxLagMs':stats([x['stages']['mainLoopMaxLagMs'] for x in rows if x['stages']['mainLoopMaxLagMs'] is not None]),'referenceMatches':sum(x['evaluation']['correct'] for x in rows),'allAttemptSecondsSum':sum(t['wallSeconds'] for x in rows for t in x['attempts']),'toolCalls':sum(len(x['toolCalls']) for x in rows),'assistantResponses':sum(x['assistantResponses'] for x in rows),'usage':{k:sum(x['usage'][k] for x in rows) for k in rows[0]['usage']}}
definitions={'answerWall':'Foreground attempt wall time, includes preflight, process startup, all model/tool rounds and response collection; not pure UI blocking','firstVisibleText':'RPC-client observed first visible text from Pi process spawn; may precede tools and final answer','mainLoopLag':'Observed scheduling stall after heartbeat initialization; does not identify a unique cause or sum to total blocking CPU','grepExpand':'Synchronous main-thread search/formatting, measured by awaited tool wrapper','indexedRecall':'Foreground waits for worker; background work may overlap and main-loop responsiveness is separate','backgroundReadiness':'Worker build/tokenization plus extraction/transfers/readiness; not free if a query awaits it','compaction':'Explicit foreground compaction RPC wall time; may contain multiple internal model requests, whose streaming timing is unavailable','preflightReadParse':'Separate safety-estimator subprocess timings, not Pi internal session-loader decomposition'}
summary={'questionCount':8,'finalAnswerSessions':24,'validFinalAnswers':sum(a['validAnswer'] for q in result for a in q['arms'].values()),'totalAnswerAttempts':sum(len(a['attempts']) for q in result for a in q['arms'].values()),'extraRetryAttempts':sum(len(a['attempts'])-1 for q in result for a in q['arms'].values()),'compactionRPCs':len(compactions),'answerProviderPreparedCallbacksAllAttempts':sum(t['providerRequestsPreparedObserved'] for q in result for a in q['arms'].values() for t in a['attempts']),'exactHTTPRequests':None,'evaluationMethod':'Assistant reference review after run; no independent judge call','referenceMatches':{arm:aggregate[arm]['referenceMatches'] for arm in aggregate}}
compactionSummary={'count':len(compactions),'wallSeconds':stats([c['wallSeconds'] for c in compactions]),'wallSecondsSum':sum(c['wallSeconds'] for c in compactions),'startupToRpcReadyMs':stats([c['timing']['startupToRpcReadyMs'] for c in compactions if c.get('timing') and c['timing']['startupToRpcReadyMs'] is not None]),'rpcWallMs':stats([c['timing']['compactionRpcWallMs'] for c in compactions if c.get('timing') and c['timing']['compactionRpcWallMs'] is not None]),'usage':{key:sum(c['usage'].get(key,0) for c in compactions) for key in ['input','output','cacheRead','cacheWrite','reasoning','totalTokens']},'internalRequestTTFTMs':None}
report={'summary':summary,'compactionSummary':compactionSummary,'manualEvaluation':evaluations,'metricDefinitions':definitions,'baseCommit':'44774d2af066d1927feed3a32096dc208c5359c9','title':'Fresh Pi DEV8 with detailed stage timing','model':'openai-codex/gpt-6-luna','thinking':'high','sdk':'0.99.1','contextWindow':372000,'guard':340000,'segments':6,'questions':result,'compactions':compactions,'aggregate':aggregate,'judge':'No independent judge; assistant checked all24 answers against reference after completion. Historical-name caveats accepted when target is clearly supplied.','metadata':{'n':8,'parallelHistories':4,'armOrder':['native','grep','indexed'],'units':'milliseconds unless named seconds','scope':'original eight independent real histories, not stacked ten','sourceManifests':[json.loads((p/'manifest.json').read_text()) for p in RUNS]},'limitations':['First visible text is client/SDK observation and may be pre-tool commentary, not the final answer or genuine server TTFT.','Foreground wait and background processing can overlap: never add them as independent latency.','Main-loop lag is observed scheduling delay after observer initialization, not exact summed blocking CPU time; common SDK serialization, GC and OS load can contribute.','Fresh answer sessions begin immediately after readiness, so prewarming may still lie on the critical path.','Raw history ingestion does not simulate ten live user cycles; cadence correctness is covered separately by offline lifecycle tests.','n=8 one run per arm/question; p95 nearest rank is effectively maximum.','Fixed arm order and concurrent histories/cache behavior confound isolated speed comparisons.','Worker stages were collected by a shared timer that labeled synchronous work as main_thread; exported workerStages normalize thread=worker/execution=worker_thread and preserve rawExecution.','Actual Pi internal session JSONL load/parse is not separately instrumented; RPC readiness includes startup, while preflight helper read/parse is a separate measured process.','Provider transport failures are retained, each gets at most one fresh-session retry; final-attempt speed and all-attempt overhead are separated.','Timing instrumentation has overhead. No timing of hidden reasoning content or credentials is exported.']}
(ROOT/'prototype/pi-dev8-timed-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'questions':len(result),'answers':sum(len(q['arms']) for q in result),'compactionRPCs':len(compactions),'aggregate':aggregate}))
