"""Prepare three genuine Pi TUI sessions; no model calls until visible launch/input."""
import argparse, hashlib, importlib.util, json, pathlib, shlex, shutil
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('dev',ROOT/'prototype/pi-dev8.py');d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
p=argparse.ArgumentParser();p.add_argument('--run',required=True);a=p.parse_args()
run=d.BENCH/'runs'/a.run;run.mkdir(exist_ok=False)
snap=d.BENCH/'runs/pi-dev8-timed-pilot-20260930/577d4d32/snapshot.jsonl'
q=next(q for q in json.loads((ROOT/'prototype/stacked.download.json').read_text()) if q['question_id']=='577d4d32')
(run/'question.txt').write_text(d.b.ASK.format(q['question_date'],q['question']))
for arm in ['native','grep','indexed']:
 folder=run/arm;folder.mkdir();session=folder/'session.jsonl';shutil.copyfile(snap,session);env=d.env_for(folder/'agent',arm)
 estimate=d.preflight(session)
 extra=['--no-tools'] if arm=='native' else ['-e',str(d.ADAPTER),'--tools','history_grep,history_expand'+(',history_recall' if arm=='indexed' else '')]
 cmd=d.BASE+extra+['-e',str(ROOT/'prototype/pi-stage-events.mjs'),'-e',str(ROOT/'prototype/pi-context-guard.mjs'),'-e',str(ROOT/'prototype/pi-tui-milestones.mjs'),'--session',str(session),'--tui-mode','fullscreen']
 selected={k:env[k] for k in ['PI_CODING_AGENT_DIR','PI_RECALL_BENCH_ARM','PI_RECALL_TIMING_FILE']};selected['PI_RECALL_TUI_EVENTS']=str(folder/'tui-events.jsonl')
 script='#!/bin/sh\nset -eu\ncd '+shlex.quote(str(folder))+'\n'+''.join('export '+k+'='+shlex.quote(v)+'\n' for k,v in selected.items())+'exec '+shlex.join(cmd)+'\n'
 (folder/'launch.sh').write_text(script)
manifest={'questionId':'577d4d32','snapshotSha256':hashlib.sha256(snap.read_bytes()).hexdigest(),'model':'openai-codex/gpt-6-luna','thinking':'high','contextWindow':372000,'ceiling':340000,'typingSeconds':3,'arms':['native','grep','indexed'],'protocol':'Independent snapshot copies; hello then completed, three seconds typing, submit original question. Hello also warms provider caches. No new compactions.'}
(run/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(run)
