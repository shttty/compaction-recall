"""Offline actual Pi startup/worker timing check; no prompt/model call."""
import importlib.util,json,tempfile,pathlib,os
root=pathlib.Path(__file__).resolve().parents[1]
def module(name,file):
 s=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
b=module('b',root/'prototype/pi-dev8.py');rpc=module('rpc',root/'prototype/pi-rpc-observer.py')
with tempfile.TemporaryDirectory() as td:
 d=pathlib.Path(td);sess=d/'session.jsonl';sess.write_text(json.dumps({'type':'session','version':3,'id':'offline-timing','timestamp':'2026-09-30T00:00:00Z','cwd':str(d)})+'\n')
 env=b.env_for(d/'agent','indexed')
 result=rpc.run_rpc(b.BASE+['-e',str(b.ADAPTER),'-e',str(root/'prototype/pi-stage-events.mjs'),'--no-tools','--mode','rpc','--session',str(sess)],env,d,settle_only=True,timeout=20)
 events=[json.loads(x) for x in (d/'timing.jsonl').read_text().splitlines()]
 names={x['stage'] for x in events};assert {'session_start','preindex_config','preindex_scheduled','background_index_ready','event_loop_window'}<=names,(names,result)
 assert not any(x['stage']=='provider_request_prepared' for x in events)
 print(json.dumps({'outcome':result['outcome'],'timing':result['timing'],'event_types':sorted(names),'worker_fallback':any(x['stage']=='fallback_required' for x in events)}))
