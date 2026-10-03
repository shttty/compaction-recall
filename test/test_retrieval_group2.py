"""A real SDK 1.0.0 session with an in-process fake SSE provider; no sockets."""
import importlib.util
import json
import os
import pathlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RetrievalSdkChainTest(unittest.TestCase):
    def test_real_sdk_auto_recall_page_trace_and_union_metrics(self):
        temp = tempfile.TemporaryDirectory(prefix="retrieval-sdk-chain-")
        self.addCleanup(temp.cleanup)
        home = pathlib.Path(temp.name)
        # The explicitly requested smoke can retain its evidence outside the repository.
        evidence = os.environ.get("RECALL_S0_SMOKE_OUTPUT")
        if evidence:
            home = pathlib.Path(evidence)
            home.mkdir(parents=True, exist_ok=False)
        data, profile, output, package = (home / name for name in ("data", "profile", "output", "package"))
        for directory in (data, profile, output, package):
            directory.mkdir()
        gold = {"gold": {}}
        for index in range(16):
            key = f"dev8/q{index}"
            directory = data / key
            directory.mkdir(parents=True)
            corpus = {"haystack_dates": ["2024/01/01 00:00"], "haystack_sessions": [[
                {"role": "user", "content": f"redshift distinct evidence {turn}"} for turn in range(60)]]}
            for filename in ("corpus.json", "corpus-zh.json"):
                (directory / filename).write_text(json.dumps(corpus))
            # Production does not consume benchmark input metadata. Include ASK's distinct
            # framing/date terms in this synthetic question so both real auto paths agree.
            question = "Synthetic question: 2024/01/02 00:00 / Where redshift evidence?"
            (directory / "question-zh.json").write_text(json.dumps({"question_id": f"q{index}", "split": "dev8", "question": question, "question_en": question, "question_date": "2024/01/02 00:00"}))
            gold["gold"][key] = [{"session": 0, "turn": 58, "role": "user"}]
        gold_path = home / "gold.json"
        gold_path.write_text(json.dumps(gold))
        helper = home / "helper.py"
        helper.write_text(load("synthetic_helper_fixture", ROOT / "test/test_evaluate.py").HELPER)
        (profile / "models.json").write_text(json.dumps({"providers": {"synthetic-offline": {
            "baseUrl": "https://benchmark.invalid/v1", "api": "openai-completions", "models": [{
                "id": "fixture-model", "name": "Offline", "reasoning": False, "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}, "contextWindow": 16384, "maxTokens": 2048}]}}}))
        (profile / "auth.json").write_text('{"synthetic-offline":{"type":"api_key","key":"synthetic-not-real"}}')
        shutil.copytree(ROOT / "src", package / "src")
        (package / "package.json").write_text('{"type":"module","pi":{"extensions":["./src/index.ts"]}}')
        for filename in package.rglob("*"):
            if filename.is_file():
                filename.chmod(0o444)
        self.addCleanup(lambda: [p.chmod(0o600) for p in package.rglob("*") if p.is_file()])
        phase = {"provider": "synthetic-offline", "model": "fixture-model", "effort": "off", "profile": str(profile)}
        config = {"sdk_path": str(ROOT / "node_modules/@earendil-works/pi-coding-agent"), "helper_path": str(helper),
                  "data_path": str(home / "gold.json"), "candidate_repo": str(package), "output_dir": str(output),
                  "system_prompt": "Synthetic offline chain only", "protocol": {"segments": 4, "reserve_tokens": 100, "overhead_tokens": 10},
                  **{name: phase for name in ("compression", "answer", "judge")}}
        config_path = home / "config.json"
        config_path.write_text(json.dumps(config))
        engine = home / "engine.mjs"
        engine.write_text(f"""import {{ collectLocatorCandidates,rankLocatorCandidates }} from {json.dumps((ROOT / 'src/locator.mjs').as_uri())};
export function createEngine(documents) {{
 const branch=documents.map((d,i)=>({{type:'message',id:d.id,timestamp:'2024-01-01',message:{{role:'user',content:d.text}}}}));
 branch.push({{type:'message',id:'tail',message:{{role:'user',content:'retained'}}}},{{type:'compaction',firstKeptEntryId:'tail'}});
 return {{searchAuto(query){{const f=collectLocatorCandidates(query,branch);return f?rankLocatorCandidates(f.candidates,f.frequency,f.documents).map(c=>({{id:c.id,score:1}})):[];}}}};
}}
""")
        provider = home / "fake-provider.mjs"
        requests = home / "provider-requests.jsonl"
        provider.write_text("""import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';import http2 from 'node:http2';import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';import {appendFileSync} from 'node:fs';
const blocked=()=>{throw new Error('FORBIDDEN_NETWORK');};
net.Socket.prototype.connect=blocked;net.connect=net.createConnection=tls.connect=blocked;
http.request=http.get=https.request=https.get=http2.connect=blocked;dns.lookup=dns.resolve=dns.promises.lookup=dns.promises.resolve=blocked;syncBuiltinESMExports();
let turn=0;
globalThis.fetch=async (url,options)=>{
 const request=JSON.parse(options.body);appendFileSync(REQUESTS,JSON.stringify(request)+'\\n',{mode:0o600});
 if(!String(url).startsWith('https://benchmark.invalid/'))throw new Error('Unexpected provider URL');
 turn++;
 let delta,reason;
 if(turn<3){delta={role:'assistant',content:'Checking history.',tool_calls:[{index:0,id:'recall-'+turn,type:'function',function:{name:'history_recall',arguments:JSON.stringify({query:'redshift',limit:1,offset:turn-1})}}]};reason='tool_calls';}
 else {delta={role:'assistant',content:'Synthetic answer.'};reason='stop';}
 const chunk=(delta,finish_reason)=>({id:'fake-'+turn,object:'chat.completion.chunk',created:0,model:'fixture-model',choices:[{index:0,delta,finish_reason}]});
 return new Response('data: '+JSON.stringify(chunk(delta,null))+'\\n\\ndata: '+JSON.stringify(chunk({},reason))+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
};
""".replace("REQUESTS", json.dumps(str(requests))))
        runner = load("retrieval_group2", ROOT / "benchmark/retrieval-group2.py")
        original = runner.evaluate.bridge_command
        with patch.object(runner.evaluate, "bridge_command", side_effect=lambda *args: ["node", "--import", str(provider), *original(*args)[1:]]):
            runner.main(["--config", str(config_path), "--data", str(data), "--gold", str(gold_path),
                         "--engine", str(engine), "--adapter-package", str(package), "--prototype", "production-offline-smoke",
                         "--output", str(output / "run"), "--question", "dev8/q0", "--language", "en"])
        report = json.loads((output / "run/report.json").read_text())
        metrics = report["rows"][0]["metrics"]
        self.assertEqual(metrics["callCount"], 2)
        self.assertEqual(metrics["queryMismatchCount"], 0)
        self.assertEqual(metrics["errorCount"], 0)
        self.assertEqual(metrics["mrr"], 0)  # First returned page misses gold; later page cannot change MRR.
        self.assertEqual(metrics["recall@5"], 1)  # Union includes second page (and automatic ranking).
        self.assertEqual(metrics["ndcg@5"], 0)
        trace_path = output / "run/dev8/q0/en/timing.jsonl"
        traces = [json.loads(line) for line in trace_path.read_text().splitlines() if json.loads(line).get("type") == "history_recall_trace"]
        self.assertEqual(len(traces), 2)
        self.assertTrue(all(event["query_identical"] is True for event in traces))
        self.assertEqual(traces[0]["result"]["nextOffset"], 1)
        self.assertEqual(traces[1]["execute"]["params"]["offset"], 1)
        self.assertEqual(traces[1]["result"]["ids"], ["q0:0000003b"])
        self.assertEqual(trace_path.stat().st_mode & 0o777, 0o600)
        messages = json.loads(requests.read_text().splitlines()[0])["messages"]
        self.assertIn("Compacted-history locators", json.dumps(messages))
        auto_text = next(block["text"] for message in messages if isinstance(message.get("content"), list)
                         for block in message["content"] if "Compacted-history locators" in block.get("text", ""))
        actual_ids = [json.loads(line)["id"] for line in auto_text.splitlines() if line.startswith("{")]
        metadata = json.loads((output / "run/dev8/q0/en/retrieval.json").read_text())
        self.assertEqual(actual_ids, [row["id"] for row in metadata["autoResults"][:5]])
        self.assertEqual(actual_ids, ["q0:00000001", *[f"q0:{number:08x}" for number in range(60, 56, -1)]])
        self.assertNotIn("has_answer", json.dumps(messages))
        self.assertNotIn("goldIds", json.dumps(messages))
        self.assertGreater(report["rows"][0]["memory"]["sdk"]["peakObservedRssKiB"], 0)
        answer = json.loads((output / "run/dev8/q0/en/answer.json").read_text())
        self.assertEqual(answer["answer"], "Synthetic answer.")
        print("OFFLINE_SDK_CHAIN", json.dumps({"calls": 2, "query_identical": [e["query_identical"] for e in traces], "metrics": metrics, "report": str(output / "run/report.json")}))
