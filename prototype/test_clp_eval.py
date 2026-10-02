import importlib.util
import json
import os
import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("clp_eval", Path(__file__).with_name("clp-eval.py"))
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)


class EvaluationRunnerTest(unittest.TestCase):
    def test_child_environment_drops_herdr_identity_without_mutating_parent(self):
        source = {"PATH": "/bin", "HERDR_ENV": "1", "HERDR_PANE": "w2:p1", "CLP_API_KEY": "private"}
        child = e.child_env(source)
        self.assertEqual(child, {"PATH": "/bin", "CLP_API_KEY": "private"})
        self.assertIn("HERDR_PANE", source)

    def test_manifest_resume_requires_identical_fingerprint(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "manifest.json"
            e.write_json(path, {"fingerprint": "abc"}, private=True)
            self.assertTrue(e.valid_manifest(path, "abc"))
            self.assertFalse(e.valid_manifest(path, "different"))

    def test_judge_verdict_requires_a_standalone_yes_or_no(self):
        self.assertIs(e.parse_verdict(" yes. "), True)
        self.assertIs(e.parse_verdict("NO"), False)
        self.assertIsNone(e.parse_verdict("No, but yes"))
        self.assertIsNone(e.parse_verdict(""))

    def test_hard_question_ranking_uses_separated_answer_labels(self):
        single = {"question_id": "single", "question_type": "temporal-reasoning", "question": "When did it change?",
                  "haystack_session_ids": ["a"], "answer_session_ids": ["a"],
                  "haystack_sessions": [[{"role": "user", "content": "fact", "has_answer": True}]]}
        spread = {"question_id": "spread", "question_type": "knowledge-update", "question": "Which plan did they choose?",
                  "haystack_session_ids": ["a", "b"], "answer_session_ids": ["a", "b"],
                  "haystack_sessions": [[{"role": "user", "content": "old", "has_answer": True}],
                                        [{"role": "user", "content": "new", "has_answer": True}]]}
        self.assertGreater(e.hardness(spread), e.hardness(single))

    def test_labelled_turns_map_to_real_chunk_cuts_and_are_stripped(self):
        turns = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"turn {i} padded detail",
                  "has_answer": i in (0, 24)} for i in range(40)]
        q = {"question_id": "label-fixture", "question_type": "multi-session", "question": "what is it",
             "question_date": "2024-01-02", "haystack_dates": ["2024/01/01 (Mon) 12:00"],
             "haystack_session_ids": ["s1"], "answer_session_ids": ["s1"], "haystack_sessions": [turns]}
        self.assertEqual(e.labeled_evidence_segments(q), [1, 3])
        exported = e.serializable_question(q)
        self.assertNotIn("answer_session_ids", exported)
        self.assertNotIn("haystack_session_ids", exported)
        self.assertTrue(all("has_answer" not in turn for session in exported["haystack_sessions"] for turn in session))
        coarse = {**q, "question_id": "coarse-label-fixture",
                  "haystack_sessions": [[{"role": turn["role"], "content": turn["content"]} for turn in turns]]}
        self.assertIsNone(e.labeled_evidence_segments(coarse))

    def test_failed_and_empty_answers_stay_distinct_from_wrong_answers(self):
        self.assertEqual(e.answer_outcome("provider-error", "text"), "model-error")
        self.assertEqual(e.answer_outcome("completed", "  "), "empty-answer")
        self.assertEqual(e.answer_outcome("completed", "wrong answer"), "answered")

    def test_invalid_judge_text_and_failed_answers_are_not_scored_wrong(self):
        q = {"question_id": "judge-fixture", "question_type": "single-session-user", "question": "fixture"}
        answered = {"outcome": "answered", "answer": "candidate"}
        with patch.object(e.b, "chat", return_value="No, but yes"):
            judged = e.grade(q, "gold", answered)
        self.assertIsNone(judged["judge"]["correct"])
        self.assertEqual(judged["judge"]["status"], "judge-error")
        with patch.object(e.b, "chat", return_value="yes"):
            failed = e.grade(q, "gold", {"outcome": "model-error", "answer": ""})
        self.assertIsNone(failed["judge"]["correct"])
        self.assertEqual(failed["judge"]["status"], "answer-failure-not-scored")

    def test_private_json_files_have_owner_only_permissions(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "private.json"
            e.write_json(path, {"answer": "sensitive"}, private=True)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), {"answer": "sensitive"})

    def test_rpc_uses_lf_and_real_pi_get_state_responds_offline(self):
        self.assertTrue(e.rpc_line({"id": "ready", "type": "get_state"}).endswith("\n"))
        with tempfile.TemporaryDirectory() as td:
            env = e.child_env()
            env.update({"PI_CODING_AGENT_DIR": td, "PI_TELEMETRY": "0"})
            result = e.rpc.run_rpc(["node", str(e.CLI), *e.PI_FLAGS, "--no-tools", "--mode", "rpc"],
                                   env, Path(td), timeout=30, settle_only=True)
        self.assertEqual(result["outcome"], "offline-ready")
        self.assertIsNotNone(result["timing"]["startupToRpcReadyMs"])


    def test_compression_helper_source_mutations_change_snapshot_fingerprint(self):
        question = {"question_id": "fixture", "history": "same"}
        digest = e.object_sha(question)
        baseline, _ = e.fingerprint(question, digest)
        original_getsource = e.inspect.getsource
        for name in ("child_env", "valid_manifest", "file_sha", "safe_error"):
            target = getattr(e, name)

            def changed_source(function, target=target):
                source = original_getsource(function)
                return source + "\n# offline source-only mutation" if function is target else source

            with patch.object(e.inspect, "getsource", side_effect=changed_source):
                with patch.object(e, "COMPRESSION_ORCHESTRATION_SOURCE", e.compression_orchestration_source()):
                    changed, config = e.fingerprint(question, digest)
            self.assertNotEqual(baseline, changed, name)
            self.assertIn("compression_orchestration", config["code"])

    def test_answer_only_source_mutations_do_not_change_snapshot_fingerprint(self):
        question = {"question_id": "fixture", "history": "same"}
        digest = e.object_sha(question)
        baseline, _ = e.fingerprint(question, digest)
        original_getsource = e.inspect.getsource
        for name in ("answer", "answer_outcome", "grade"):
            target = getattr(e, name)

            def changed_source(function, target=target):
                source = original_getsource(function)
                return source + "\n# offline answer-only mutation" if function is target else source

            with patch.object(e.inspect, "getsource", side_effect=changed_source):
                with patch.object(e, "COMPRESSION_ORCHESTRATION_SOURCE", e.compression_orchestration_source()):
                    unchanged, _ = e.fingerprint(question, digest)
            self.assertEqual(baseline, unchanged, name)

    def test_run_recovers_durable_outputs_and_rejects_changed_inputs(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "evaluation"
            data = home / "data" / "dev8"
            data.mkdir(parents=True)
            question = {"question_id": "fixture", "question_type": "single-session-user",
                        "question": "fixture question", "question_date": "2024-01-01",
                        "haystack_dates": ["2024/01/01 (Mon) 12:00"],
                        "haystack_sessions": [[{"role": role, "content": f"fixture turn {index}"}
                                               for index, role in enumerate(["user", "assistant"] * 8)]]}
            e.write_json(data / "questions.json", {"fixture": question})
            e.write_json(data / "gold.json", {"fixture": "judge-only gold"})
            e.write_json(data / "manifest.json", {"source_sha256": "data-hash"})
            plugin_dir = Path(td) / "plugin"
            plugin_dir.mkdir()
            wrapper = Path(td) / "adapter.mjs"
            wrapper.write_text("unused")
            plugin = {"files": {"index.ts": "candidate-hash"}, "resolved_commit": e.ALLOWED_PLUGIN_REFS[0],
                      "archive_sha256": "archive-hash", "closure_sha256": "closure-hash"}

            def answer(q, snap, run_dir, arm, pinned, adapter):
                return {"question_id": q["question_id"], "arm": arm, "outcome": "answered",
                        "answer": "fixture\u2028answer\u2029", "tool_calls": [], "timing": {}}

            def grade(q, gold, result):
                return {**result, "judge": {"correct": True}}

            compact_calls = []

            def compact(session, env, cwd):
                compact_calls.append(session)
                return {"success": True, "timing": {"processWallMs": 1}}

            with patch.object(e, "EVAL_HOME", home), patch.object(e, "pin_plugin", return_value=(plugin_dir, plugin)) as pin, \
                 patch.object(e, "pin_wrapper", return_value=(wrapper, "wrapper-hash")), \
                 patch.object(e, "compact", new=compact), \
                 patch.object(e, "answer", side_effect=answer) as answer_call, \
                 patch.object(e, "grade", side_effect=grade) as grade_call, \
                 patch.object(e.b, "API", "https://unit.invalid"), patch.object(e.b, "KEY", "unit-secret"), \
                 patch.object(e.subprocess, "Popen", side_effect=AssertionError("unexpected Pi/model process")), \
                 patch.object(e.b, "chat", side_effect=AssertionError("unexpected judge request")), \
                 patch("builtins.print"):
                e.run("dev8", "orchestration", e.ALLOWED_PLUGIN_REFS[0], "fixture")
                self.assertEqual(answer_call.call_count, 3)
                self.assertEqual(grade_call.call_count, 3)
                self.assertEqual(len(compact_calls), 3)
                e.run("dev8", "orchestration", e.ALLOWED_PLUGIN_REFS[0], "fixture")
                self.assertEqual(answer_call.call_count, 3)
                self.assertEqual(grade_call.call_count, 3)
                self.assertEqual(len(compact_calls), 3)

                run_dir = home / "runs/orchestration"
                ledger = run_dir / "results.jsonl"
                ledger.unlink()
                for arm in ("native", "grep", "production"):
                    arm_dir = run_dir / arm / "fixture"
                    (arm_dir / "judge.json").unlink()
                    state = json.loads((arm_dir / "status.json").read_text())
                    state["state"] = "answer-complete"
                    e.write_json(arm_dir / "status.json", state)
                e.run("dev8", "orchestration", e.ALLOWED_PLUGIN_REFS[0], "fixture")
                self.assertEqual(answer_call.call_count, 3)
                self.assertEqual(grade_call.call_count, 6)
                rows = e.jsonl_records(ledger)
                self.assertEqual([row["arm"] for row in rows], ["native", "grep", "production"])
                self.assertTrue(all(row["answer"] == "fixture\u2028answer\u2029" for row in rows))

                ledger.unlink()
                for arm in ("native", "grep", "production"):
                    arm_dir = run_dir / arm / "fixture"
                    state = json.loads((arm_dir / "status.json").read_text())
                    state["state"] = "judge-complete"
                    e.write_json(arm_dir / "status.json", state)
                e.run("dev8", "orchestration", e.ALLOWED_PLUGIN_REFS[0], "fixture")
                self.assertEqual(answer_call.call_count, 3)
                self.assertEqual(grade_call.call_count, 6)
                rows = e.jsonl_records(ledger)
                self.assertTrue(all(row["answer"] == "fixture\u2028answer\u2029" for row in rows))
                manifest = json.loads((run_dir / "manifest.json").read_text())
                self.assertEqual(manifest["plugin_commit"], e.ALLOWED_PLUGIN_REFS[0])
                self.assertEqual(manifest["questions_file_sha256"], e.file_sha(data / "questions.json"))
                self.assertEqual(manifest["gold_file_sha256"], e.file_sha(data / "gold.json"))

                native = run_dir / "native" / "fixture"
                native_answer = (native / "answer.json").read_bytes()
                native_judge = (native / "judge.json").read_bytes()
                native_state = json.loads((native / "status.json").read_text())
                ledger.unlink()
                (native / "answer.json").unlink()
                (native / "judge.json").unlink()
                native_state["state"] = "answer-inflight"
                e.write_json(native / "status.json", native_state)
                with self.assertRaisesRegex(RuntimeError, "Answer attempt is ambiguous"):
                    e.run("dev8", "orchestration", e.ALLOWED_PLUGIN_REFS[0], "fixture")
                self.assertEqual(answer_call.call_count, 3)
                self.assertEqual(grade_call.call_count, 6)

                (native / "answer.json").write_bytes(native_answer)
                (native / "judge.json").write_bytes(native_judge)
                native_state["state"] = "judge-complete"
                e.write_json(native / "status.json", native_state)
                grep = run_dir / "grep" / "fixture"
                (grep / "judge.json").unlink()
                grep_state = json.loads((grep / "status.json").read_text())
                grep_state["state"] = "judge-inflight"
                e.write_json(grep / "status.json", grep_state)
                with self.assertRaisesRegex(RuntimeError, "Judge attempt is ambiguous"):
                    e.run("dev8", "orchestration", e.ALLOWED_PLUGIN_REFS[0], "fixture")
                self.assertEqual(answer_call.call_count, 3)
                self.assertEqual(grade_call.call_count, 6)

                changed_question = {**question, "question": "changed input"}
                e.write_json(data / "questions.json", {"fixture": changed_question})
                e.write_json(data / "gold.json", {"fixture": "changed gold"})
                pin_count = pin.call_count
                with self.assertRaisesRegex(RuntimeError, "input files changed"):
                    e.run("dev8", "orchestration", e.ALLOWED_PLUGIN_REFS[0], "fixture")
                self.assertEqual(pin.call_count, pin_count)
                self.assertEqual(answer_call.call_count, 3)
                self.assertEqual(grade_call.call_count, 6)

    def test_sdk_loads_both_immutable_pins_with_isolated_grep_tools(self):
        pins = [e.pin_plugin(ref) for ref in e.ALLOWED_PLUGIN_REFS]
        wrapper_path, wrapper_hash = e.pin_wrapper()
        self.assertEqual(e.file_sha(wrapper_path), wrapper_hash)
        self.assertEqual(wrapper_path.stat().st_mode & 0o222, 0)
        paths = []
        for ref, (path, manifest) in zip(e.ALLOWED_PLUGIN_REFS, pins):
            self.assertEqual(manifest["resolved_commit"], ref)
            self.assertTrue({"index.ts", "recall-extension.ts", "locator.ts", "timing.ts", "package.json"}.issubset(manifest["files"]))
            self.assertEqual(path.stat().st_mode & 0o222, 0)
            paths.append(str(path))
        completed = subprocess.run(["node", str(Path(__file__).with_name("test-clp-extensions.mjs")), str(wrapper_path), *paths],
                                   check=True, capture_output=True, text=True)
        observed = json.loads(completed.stdout)
        self.assertEqual([item["commit"] for item in observed], list(e.ALLOWED_PLUGIN_REFS))
        self.assertTrue(all(item["grepTools"] == ["history_expand", "history_grep"] and not item["grepContextHook"] for item in observed))
        self.assertTrue(all(item["productionTools"] == ["history_expand", "history_grep", "history_recall"] and item["productionContextHook"] for item in observed))
if __name__ == "__main__":
    unittest.main()
