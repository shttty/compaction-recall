"""Offline runner regression; never calls a model or reads auth contents."""
import importlib.util
import json
import io
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('runner',Path(__file__).with_name('pi-dev8.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class RunnerTest(unittest.TestCase):
 def test_unicode_jsonl_is_not_split_at_unicode_line_separators(self):
  q={'question_id':'fixture','haystack_dates':['2024/01/01 (Mon) 12:00'],
     'haystack_sessions':[[{'role':'user' if i%2==0 else 'assistant','content':f'turn {i} with separator \u2028 and text'} for i in range(24)]]}
  with tempfile.TemporaryDirectory() as td:
   folder=Path(td)/'question'
   with patch.object(r,'env_for',return_value={}),patch.object(r,'compact',return_value={'success':True}),patch.object(r.b,'RUNS',Path(td)):
    self.assertTrue(r.snapshot(q,folder,6))
   rows=[json.loads(x) for x in r.b.jsonl_lines(folder/'snapshot.jsonl')]
   self.assertEqual(len(rows),25)
   self.assertTrue(all('\u2028' in x['message']['content'][0]['text'] for x in rows[1:]))
 def test_rpc_ready_and_compaction_timing_without_model(self):
  class Process:
   returncode=0
   stdin=io.StringIO()
   stdout=iter([json.dumps({'id':'ready','type':'response','success':True})+'\n',json.dumps({'id':'compact','type':'response','success':True})+'\n'])
   stderr=io.StringIO('')
   def wait(self,timeout):return 0
  process=Process()
  with tempfile.TemporaryDirectory() as td:
   session=Path(td)/'session.jsonl';session.with_suffix('.preflight.json').write_text(json.dumps({'timing':{}}))
   with patch.object(r,'preflight',return_value=100),patch.object(r.subprocess,'Popen',return_value=process):
    result=r.compact(session,{},Path(td))
  self.assertTrue(result['success'])
  self.assertGreaterEqual(result['timing']['startupToRpcReadyMs'],0)
  self.assertGreaterEqual(result['timing']['compactionRpcWallMs'],0)
 def test_rpc_observer_milestones_do_not_log_stream_content(self):
  with tempfile.TemporaryDirectory() as td:
   script=Path(td)/'fake.py'
   script.write_text("import json,sys\nfor line in sys.stdin:\n c=json.loads(line)\n if c['type']=='get_state':print(json.dumps({'id':'ready','type':'response','success':True}),flush=True)\n else:\n  for e in [{'type':'message_end','message':{'role':'user'}},{'type':'turn_start'},{'type':'message_update','assistantMessageEvent':{'type':'thinking_delta','delta':'SECRET_SENTINEL'}},{'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'SECRET_SENTINEL'}},{'type':'tool_execution_start'},{'type':'tool_execution_start'},{'type':'turn_end','toolResults':[{},{}]},{'type':'agent_end'}]:print(json.dumps(e),flush=True)\n")
   result=r.rpc.run_rpc([sys.executable,str(script)],{},Path(td),prompt='fixture',timeout=10)
   self.assertEqual(result['outcome'],'completed');self.assertEqual(result['timing']['toolCalls'],2);self.assertEqual(result['timing']['toolBatches'],1)
   self.assertIsNotNone(result['timing']['firstVisibleTextFromSpawnMs']);self.assertIsNone(result['timing']['providerTTFTMs'])
   self.assertNotIn('SECRET_SENTINEL',json.dumps(result))
if __name__=='__main__':unittest.main()
