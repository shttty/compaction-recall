"""Operate actual tmux Pi panes. Run only after checking the visible terminal route."""
import argparse,json,pathlib,subprocess,time
p=argparse.ArgumentParser();p.add_argument('action',choices=['launch','exercise']);p.add_argument('--tmux',required=True);p.add_argument('--run',required=True);a=p.parse_args()
run=pathlib.Path(a.run).resolve();name='pi-recall-warm';arms=['native','grep','indexed']
def tmux(*args):return subprocess.check_output([a.tmux,*args],text=True).strip()
def events(arm):
 path=run/arm/'tui-events.jsonl'
 if not path.exists():return []
 return [json.loads(line) for line in path.read_text().splitlines() if line]
def wait_for(arm,event,cycle=None):
 deadline=time.monotonic()+600
 while time.monotonic()<deadline:
  rows=[r for r in events(arm) if r['event']==event and (cycle is None or r['cycle']==cycle)]
  if rows:
   if event=='completed' and rows[-1].get('stopReason') in ['error','aborted']:raise RuntimeError(arm+' model turn failed; no automatic retry')
   return rows[-1]
  time.sleep(.1)
 raise TimeoutError(arm+' '+event)
def record(event,**data):
 with (run/'driver-events.jsonl').open('a') as f:f.write(json.dumps({'event':event,'monotonicMs':time.monotonic()*1000,'epochMs':time.time()*1000,**data})+'\n')
if a.action=='launch':
 if (run/'panes.json').exists():raise SystemExit('Already launched: preserving current sessions')
 panes={}
 for i,arm in enumerate(arms):
  cmd=['sh',str(run/arm/'launch.sh')]
  import shlex
  if i==0:pane=tmux('new-session','-d','-s',name,'-x','210','-y','54','-P','-F','#{pane_id}',shlex.join(cmd))
  else:pane=tmux('split-window','-h','-t',name,'-P','-F','#{pane_id}',shlex.join(cmd))
  panes[arm]=pane;tmux('select-pane','-t',pane,'-T',arm);tmux('select-layout','-t',name,'even-horizontal')
 tmux('set-option','-t',name,'pane-border-status','top')
 tmux('set-option','-t',name,'pane-border-format',' #{pane_title} ')
 (run/'panes.json').write_text(json.dumps(panes));record('panes_launched')
 print('Attach visible terminal: '+shlex.join([a.tmux,'attach-session','-t',name]))
else:
 if (run/'driver-events.jsonl').exists() and 'hello_submitted' in (run/'driver-events.jsonl').read_text():raise SystemExit('Exercise already started; no repeated model calls')
 panes=json.loads((run/'panes.json').read_text())
 for arm in arms:wait_for(arm,'ready')
 for arm in arms:
  tmux('send-keys','-t',panes[arm],'-l','hello');tmux('send-keys','-t',panes[arm],'Enter');record('hello_submitted',arm=arm)
 for arm in arms:wait_for(arm,'completed',1);record('hello_completed_observed',arm=arm)
 # Same three-second input interval for all panes, after all hello responses completed.
 question=(run/'question.txt').read_text();chunks=[question[i:i+8] for i in range(0,len(question),8)];start=time.monotonic();record('typing_started',method='eight-character bracketed-paste chunks')
 for i,chunk in enumerate(chunks):
  for arm in arms:tmux('send-keys','-t',panes[arm],'-l','\x1b[200~'+chunk+'\x1b[201~')
  target=start+3*(i+1)/len(chunks);time.sleep(max(0,target-time.monotonic()))
 record('typing_finished',actualMs=(time.monotonic()-start)*1000)
 for arm in arms:tmux('send-keys','-t',panes[arm],'Enter');record('question_submitted',arm=arm)
 for arm in arms:wait_for(arm,'completed',2);record('question_completed_observed',arm=arm)
 print('All three TUI answers completed; panes remain visible.')
