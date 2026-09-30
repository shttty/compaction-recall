"""One bounded fresh-session retry per provider-failed answer, same snapshot/model/provider."""
import importlib.util,pathlib,json,sys
root=pathlib.Path(__file__).resolve().parents[1];spec=importlib.util.spec_from_file_location('r',root/'prototype/pi-dev8.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
qs={q['question_id']:q for q in json.loads((root/'prototype/stacked.download.json').read_text())};plans=[]
for name in ['pi-dev8-timed-pilot-20260930','pi-dev8-timed-main-20260930']:
 for folder in (r.BENCH/'runs'/name).iterdir():
  if not folder.is_dir():continue
  for arm in ['native','grep','indexed']:
   d=folder/arm
   if not (d/'result.json').exists():continue
   rows=[json.loads(x) for x in r.b.jsonl_lines(d/'session.jsonl')];last=next((x['message'] for x in reversed(rows) if x.get('message',{}).get('role')=='assistant'),{})
   if last.get('stopReason')=='error':
    retry=folder/f'retry1-{arm}';category='websocket_closed_1000' if last.get('errorMessage')=='WebSocket closed 1000' else 'provider_error'
    plans.append({'questionId':folder.name,'arm':arm,'errorCategory':category,'retryExists':retry.exists(),'folder':folder})
print(json.dumps([{k:v for k,v in x.items() if k!='folder'} for x in plans]),flush=True)
if '--run' in sys.argv:
 for plan in plans:
  if plan['retryExists']:continue
  if plan['errorCategory']!='websocket_closed_1000':continue # unknown failure needs diagnosis
  folder=plan['folder'];out=r.answer(qs[folder.name],folder/'snapshot.jsonl',folder/f"retry1-{plan['arm']}",plan['arm'])
  print(json.dumps({'questionId':folder.name,'arm':plan['arm'],'retry':1,'outcome':out.get('outcome'),'rc':out.get('rc')}),flush=True)
