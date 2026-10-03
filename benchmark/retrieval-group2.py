"""Retrieval-only single-run Pi SDK evaluation; answers are saved, never judged."""
import argparse
import importlib.util
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("retrieval_evaluate", ROOT / "benchmark/evaluate.py")
evaluate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluate)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--gold", required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--adapter-package", required=True)
    parser.add_argument("--prototype", required=True)
    parser.add_argument("--output", required=True, help="New directory inside config.output_dir; no resume")
    parser.add_argument("--question", action="append", help="split/id; repeatable")
    parser.add_argument("--language", action="append", choices=("en", "zh"))
    args = parser.parse_args(argv)
    evaluate.configure(args.config)
    output = pathlib.Path(args.output).resolve()
    configured_output = pathlib.Path(evaluate.CONFIG["output_dir"])
    if configured_output not in output.parents:
        raise ValueError("--output must be strictly inside config.output_dir")
    data = pathlib.Path(args.data).resolve(strict=True)
    gold_path = pathlib.Path(args.gold).resolve(strict=True)
    engine = pathlib.Path(args.engine).resolve(strict=True)
    adapter = pathlib.Path(args.adapter_package).resolve(strict=True)
    for filename in adapter.rglob("*"):
        if filename.is_file() and filename.stat().st_mode & 0o222:
            raise ValueError(f"Adapter package must be read-only: {filename}")
    if (adapter / "package.json").stat().st_mode & 0o222:
        raise ValueError("Adapter package manifest must be read-only")
    entries = json.loads((adapter / "package.json").read_text(encoding="utf-8")).get("pi", {}).get("extensions")
    if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], str):
        raise ValueError("Adapter must declare exactly one pi.extensions entry")
    entry = (adapter / entries[0]).resolve(strict=True)
    if adapter not in entry.parents:
        raise ValueError("Adapter entry escapes package")
    gold = json.loads(gold_path.read_text(encoding="utf-8"))["gold"]
    prompts = {}
    for key in gold:
        question = json.loads((data / key / "question-zh.json").read_text(encoding="utf-8"))
        for language in ("en", "zh"):
            text = question["question_en" if language == "en" else "question"]
            prompts[f"{key}/{language}"] = evaluate.b.ASK.format(question["question_date"], text)
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    evaluate.write_json(output / "run.json", {"group": 2, "singleRun": True, "prototype": args.prototype,
                        "adapterPackage": str(adapter), "extensionPaths": [str(entry)], "engine": str(engine),
                        "engineSha256": evaluate.file_sha(engine), "config": str(evaluate.CONFIG_PATH),
                        "packageSha256": {str(p.relative_to(adapter)): evaluate.file_sha(p)
                                          for p in adapter.rglob("*") if p.is_file()}})
    prepare = output / "prepare.json"
    evaluate.write_json(prepare, {"dataRoot": str(data), "goldPath": str(gold_path), "engine": str(engine),
                                "output": str(output), "questions": args.question, "languages": args.language,
                                "prompts": prompts})
    bridge = ROOT / "benchmark/retrieval-session.mjs"
    subprocess.run(["node", str(bridge), "prepare", str(prepare)], check=True, env=evaluate.child_env())
    cases = json.loads((output / "cases.json").read_text(encoding="utf-8"))
    recall_config = output / "compaction-recall.json"
    evaluate.write_json(recall_config, {"trace": True})
    observed = []
    for case in cases:
        directory = pathlib.Path(case["directory"])
        trace = directory / "timing.jsonl"
        q = {"question_id": case["questionId"], "question": case["question"], "question_date": case["questionDate"]}
        result = evaluate.answer(q, pathlib.Path(case["snapshot"]), directory, "production", adapter, None,
                                 recall_config=recall_config, timing_file=trace,
                                 retrieval_input=directory / "input.json", collect_memory=True)
        answer_path = directory / "answer.json"
        evaluate.write_json(answer_path, result)
        if result["outcome"] != "answered":
            raise RuntimeError(f"SDK answer failed for {case['key']}/{case['language']}; see {answer_path}")
        observed.append({"metadata": str(directory / "retrieval.json"), "trace": str(trace),
                         "recallCalls": result["tool_calls"].count("history_recall"),
                         "answerWallMs": result["answerWallMs"], "timing": result["timing"],
                         "memory": result.get("memory"), "answerPath": str(answer_path)})
    score_request = output / "score.json"
    evaluate.write_json(score_request, {"prototype": args.prototype, "cases": observed,
                                      "report": str(output / "report.json")})
    subprocess.run(["node", str(bridge), "score", str(score_request)], check=True, env=evaluate.child_env())


if __name__ == "__main__":
    main()
