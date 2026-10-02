"""Offline RPC observer regression using a synthetic child; no model calls."""
import importlib.util
import json
import sys
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('rpc_observer',Path(__file__).resolve().parents[1]/'benchmark'/'pi-rpc-observer.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class RpcObserverTest(unittest.TestCase):
 def test_rpc_observer_milestones_do_not_log_stream_content(self):
  with tempfile.TemporaryDirectory() as td:
   script=Path(td)/'fake.py'
   script.write_text("import json,sys\nfor line in sys.stdin:\n c=json.loads(line)\n if c['type']=='get_state':print(json.dumps({'id':'ready','type':'response','success':True}),flush=True)\n else:\n  for e in [{'type':'message_end','message':{'role':'user'}},{'type':'turn_start'},{'type':'message_update','assistantMessageEvent':{'type':'thinking_delta','delta':'SECRET_SENTINEL'}},{'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'SECRET_SENTINEL'}},{'type':'tool_execution_start'},{'type':'tool_execution_start'},{'type':'turn_end','toolResults':[{},{}]},{'type':'agent_end'}]:print(json.dumps(e),flush=True)\n")
   result=r.run_rpc([sys.executable,str(script)],{},Path(td),prompt='fixture',timeout=10)
   self.assertEqual(result['outcome'],'completed');self.assertEqual(result['timing']['toolCalls'],2);self.assertEqual(result['timing']['toolBatches'],1)
   self.assertIsNotNone(result['timing']['firstVisibleTextFromSpawnMs']);self.assertIsNone(result['timing']['providerTTFTMs'])
   self.assertNotIn('SECRET_SENTINEL',json.dumps(result))
if __name__=='__main__':unittest.main()
