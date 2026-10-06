#!/usr/bin/env python3
"""Offline fixed coding-dev8 or authorized real LME16 report; no provider access."""
import argparse
from collections import Counter
import json
import math
from pathlib import Path
import random
import statistics

ARMS = ("pi-native", "pi-mainline", "pi-sqlite", "omp-native", "omp-sqlite")
PAIRS = (("pi-sqlite", "pi-native"), ("pi-sqlite", "pi-mainline"),
         ("omp-sqlite", "omp-native"))
TOKEN_FIELDS = ("input", "output", "cacheRead", "cacheWrite")
BOOTSTRAP_SEED = 20261004
BOOTSTRAP_DRAWS = 10000
DISCLAIMER = ("A阶段: fixed dev8 only; stop after stageA. N=8 single-run descriptive "
              "evaluation, not evidence of superiority. Bootstrap 95% intervals are "
              "reference only; they do not quantify model-run variability. Six shared "
              "compression snapshots (not six compaction calls); at least four compactions "
              "per case in both modes, with no upper bound. No B/C-stage launch is implied.")
LME16_IDS = frozenset(("778164c6", "51b23612", "ceb54acb", "577d4d32", "3d86fd0a", "15745da0",
                       "gpt4_65aabe59", "982b5123", "gpt4_7fce9456", "gpt4_a1b77f9c", "28dc39ac",
                       "gpt4_15e38248", "6d550036", "2ce6a0f2", "9d25d4e0", "gpt4_731e37d7"))


def question_map(questions):
    if questions is None:
        return None
    if isinstance(questions, dict):
        return {str(qid): dict(metadata) for qid, metadata in questions.items()}
    result = {}
    for question in questions:
        if isinstance(question, str):
            qid, metadata = question, {}
        else:
            qid = question.get("question_id", question.get("id"))
            metadata = question.get("metadata", question)
        if not isinstance(qid, str) or not qid or qid in result:
            raise ValueError("Selected question IDs must be unique nonempty strings")
        result[qid] = dict(metadata)
    return result


def scored_correct(record):
    judge = record.get("judge") or {}
    correct = judge.get("correct")
    if (record.get("outcome") == "answered" and judge.get("status") == "graded"
            and isinstance(correct, bool)):
        return correct
    return None


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def measure(values):
    available = [value for value in values if number(value)]
    return {"mean": statistics.mean(available) if available else None,
            "observed": len(available), "missing": len(values) - len(available)}


def tool_result_errors(record):
    """Count explicit error tool results, without treating provider errors as tools."""
    results = record.get("toolResults", record.get("tool_results", record.get("toolResult")))
    if results is None:
        return None
    if not isinstance(results, list):
        results = [results]
    return sum(isinstance(result, dict) and
               (result.get("isError") is True or result.get("error") not in (None, False, "")
                or result.get("status") in ("error", "failed")
                or result.get("outcome") == "error") for result in results)


def arm_summary(records):
    total = len(records)
    scores = [scored_correct(record) for record in records]
    correct = sum(score is True for score in scores)
    wrong = sum(score is False for score in scores)
    failures = {
        "provider/model-error": sum(record.get("outcome") == "model-error" for record in records),
        "empty-answer": sum(record.get("outcome") == "empty-answer" for record in records),
        "judge-error": sum((record.get("judge") or {}).get("status") == "judge-error" for record in records),
        "unresolved": sum(score is None for score in scores),
    }
    tool_lists = [record.get("tool_calls") for record in records]
    tools = Counter(tool for calls in tool_lists if isinstance(calls, list) for tool in calls)
    observed_tools = sum(isinstance(calls, list) for calls in tool_lists)
    tool_errors = [tool_result_errors(record) for record in records]
    failures["toolResult-errors"] = sum(value for value in tool_errors if value is not None)
    failures["toolResult-missing"] = sum(value is None for value in tool_errors)
    tokens = {}
    for field in TOKEN_FIELDS:
        values = [(record.get("tokens") or {}).get(field) for record in records]
        tokens[field] = {"sum": sum(value for value in values if number(value)),
                         "observed": sum(number(value) for value in values),
                         "missing": sum(not number(value) for value in values)}
    totals = []
    for record in records:
        usage = record.get("tokens") or {}
        totals.append(sum(usage[field] for field in TOKEN_FIELDS)
                      if all(number(usage.get(field)) for field in TOKEN_FIELDS) else None)
    return {
        "selected": total, "correct": correct, "wrong": wrong, "scored": correct + wrong,
        "accuracyTotal": correct / total if total else None,
        "accuracyScored": correct / (correct + wrong) if correct + wrong else None,
        "failures": failures,
        "toolCalls": {**measure([len(calls) if isinstance(calls, list) else None for calls in tool_lists]),
                      "sum": sum(tools.values()),
                      "byTool": {tool: {"sum": count,
                                          "mean": count / observed_tools if observed_tools else None}
                                 for tool, count in sorted(tools.items())}},
        "answerWallMs": measure([record.get("answerWallMs") for record in records]),
        "promptToCompleteMs": measure([(record.get("timing") or {}).get("promptToCompleteMs")
                                        for record in records]),
        "tokens": {**tokens, "totalInclusiveCaches": measure(totals)},
        "judgeScore": {**measure([(record.get("judge") or {}).get("score")
                                  if scored_correct(record) is not None else None
                                  for record in records]),
                       "perQuestion": {record["question_id"]: (record.get("judge") or {}).get("score")
                                       if scored_correct(record) is not None else None for record in records}},
    }


def bootstrap_ci(differences):
    if not differences:
        return None
    rng = random.Random(BOOTSTRAP_SEED)
    size = len(differences)
    means = sorted(sum(rng.choice(differences) for _ in range(size)) / size
                   for _ in range(BOOTSTRAP_DRAWS))
    def quantile(probability):
        position = probability * (len(means) - 1)
        lo = math.floor(position)
        hi = math.ceil(position)
        return means[lo] + (means[hi] - means[lo]) * (position - lo)
    return [quantile(0.025), quantile(0.975)]


def pair_summary(by_arm, ids, treatment, baseline):
    rows = []
    for qid in ids:
        left, right = scored_correct(by_arm[treatment][qid]), scored_correct(by_arm[baseline][qid])
        difference = int(left) - int(right) if left is not None and right is not None else None
        rows.append({"question_id": qid, "treatmentCorrect": left,
                     "baselineCorrect": right, "difference": difference})
    differences = [row["difference"] for row in rows if row["difference"] is not None]
    return {"treatment": treatment, "baseline": baseline, "selected": len(ids),
            "completePairs": len(differences), "excluded": len(ids) - len(differences),
            "wins": differences.count(1), "losses": differences.count(-1),
            "bothCorrect": sum(row["treatmentCorrect"] is True and row["baselineCorrect"] is True for row in rows),
            "bothWrong": sum(row["treatmentCorrect"] is False and row["baselineCorrect"] is False for row in rows),
            "meanDifference": statistics.mean(differences) if differences else None,
            "bootstrap95CI": bootstrap_ci(differences), "perQuestion": rows}


def summarize(records, questions=None):
    """Pure summary; require a complete selected-ID × five-arm artifact matrix."""
    records = list(records)
    metadata = question_map(questions)
    by_arm = {arm: {} for arm in ARMS}
    for record in records:
        arm, qid = record.get("arm"), record.get("question_id")
        if arm not in by_arm:
            raise ValueError(f"Unknown arm: {arm}")
        if not isinstance(qid, str) or not qid:
            raise ValueError("Result requires a question_id")
        if qid in by_arm[arm]:
            raise ValueError(f"Duplicate result: {arm}/{qid}")
        by_arm[arm][qid] = record
    if metadata is None:
        metadata = {qid: {} for arm in ARMS for qid in by_arm[arm]}
    ids = sorted(metadata)
    if not ids:
        raise ValueError("No selected questions")
    for arm in ARMS:
        missing, extra = set(ids) - by_arm[arm].keys(), by_arm[arm].keys() - set(ids)
        if missing or extra:
            raise ValueError(f"Incomplete selected results for {arm}: missing={sorted(missing)}, extra={sorted(extra)}")
    for qid in ids:
        combined = {}
        for arm in ARMS:
            for key, value in (by_arm[arm][qid].get("metadata") or {}).items():
                if key in combined and combined[key] != value:
                    raise ValueError(f"Conflicting question metadata: {qid}/{key}")
                combined[key] = value
        combined.update(metadata[qid])
        metadata[qid] = combined
    strata = {}
    for dimension in ("answerability", "subset", "language", "type", "overlap"):
        groups = {}
        for qid in ids:
            item = metadata[qid]
            if dimension == "answerability":
                value = "no-answer" if item.get("type") == "no-answer" else "answerable"
            else:
                value = item.get(dimension)
                if dimension == "overlap":
                    value = value.get("band") if isinstance(value, dict) else value
                    value = ("no-answer" if item.get("type") == "no-answer" else "unknown") if value is None else value
                elif value is None:
                    value = "unknown"
            groups.setdefault(str(value), []).append(qid)
        strata[dimension] = {value: {"questionIds": group,
                                     "arms": {arm: arm_summary([by_arm[arm][qid] for qid in group]) for arm in ARMS}}
                             for value, group in sorted(groups.items())}
    return {"stage": "A阶段", "disclaimer": DISCLAIMER, "selectedCount": len(ids),
            "questionIds": ids, "bootstrap": {"seed": BOOTSTRAP_SEED, "draws": BOOTSTRAP_DRAWS,
                                               "unit": "matched question IDs", "confidence": 0.95},
            "arms": {arm: arm_summary([by_arm[arm][qid] for qid in ids]) for arm in ARMS},
            "strata": strata,
            "pairs": {f"{treatment}-minus-{baseline}": pair_summary(by_arm, ids, treatment, baseline)
                      for treatment, baseline in PAIRS}}


def load_report(output):
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    if "arms" in manifest and (len(manifest["arms"]) != len(ARMS) or set(manifest["arms"]) != set(ARMS)):
        raise ValueError("Manifest must include exactly the five report arms")
    selected = question_map(manifest.get("selected"))
    if not selected:
        raise ValueError("Manifest requires selected question IDs")
    lme = manifest.get("identity", {}).get("dataset") == "LME16-English"
    expected = LME16_IDS if lme else {"q030", "q058", "q054", "q042", "q03", "q01", "q025", "q029"}
    if set(selected) != expected:
        raise ValueError("Report requires the authorized exact selected IDs")
    metadata = question_map(manifest.get("questions")) or {}
    for qid in selected:
        selected[qid].update(metadata.get(qid, {}))
    records = []
    for arm in ARMS:
        for qid in selected:
            # IDs are the fixed allowlist above; never follow profile/config paths.
            path = output / "results" / arm / qid / "result.json"
            if not path.is_file():
                raise ValueError(f"Missing result artifact: {arm}/{qid}")
            record = json.loads(path.read_text(encoding="utf-8"))
            if record.get("arm") != arm or record.get("question_id") != qid:
                raise ValueError(f"Result identity mismatch: {arm}/{qid}")
            records.append(record)
    aggregate = summarize(records, selected)
    if lme:
        aggregate["stage"] = "LME16-English"
        aggregate["disclaimer"] = ("Real native compression; English DEV8 + harder8, N=16, one run per arm. "
                                   "Paired bootstrap 95% intervals are descriptive reference only; "
                                   "they do not quantify model-run variability or prove superiority.")
        aggregate["snapshots"] = manifest["snapshots"]
        aggregate["perQuestion"] = {qid: {record["arm"]: {"correct": scored_correct(record),
                                   "score": (record.get("judge") or {}).get("score"), "outcome": record.get("outcome"),
                                   "judgeStatus": (record.get("judge") or {}).get("status")}
                                   for record in records if record["question_id"] == qid} for qid in sorted(selected)}
        for arm in ARMS:
            aggregate["arms"][arm]["outcomes"] = dict(Counter(record["outcome"] for record in records if record["arm"] == arm))
    return aggregate


def render_report(aggregate):
    def value(item):
        return "missing" if item is None else (f"{item:.4f}" if isinstance(item, float) else str(item))
    lines = [f"# {aggregate['stage']} — end-to-end report", "", aggregate["disclaimer"], "",
             "Failures remain unresolved, not wrong. Total accuracy uses all selected IDs; "
             "scored accuracy excludes unresolved records. Timing/tool means use observed "
             "records; missing counts are explicit. Token sums include only observed fields; "
             "inclusive-cache means require all four token fields. Correct is the S5 atLeast8 "
             "descriptive bucket (judge score >= 8); numeric scores and their observed mean "
             "are retained separately.", "",
             "## Five-arm accuracy", "",
             "| Arm | Correct / selected | Wrong | Scored | Total accuracy | Scored accuracy | Unresolved |",
             "|---|---:|---:|---:|---:|---:|---:|"]
    for arm, item in aggregate["arms"].items():
        lines.append(f"| {arm} | {item['correct']}/{item['selected']} | {item['wrong']} | {item['scored']} | "
                     f"{value(item['accuracyTotal'])} | {value(item['accuracyScored'])} | {item['failures']['unresolved']} |")
    lines.extend(["", "## Paired differences (treatment minus baseline)", "",
                  "Matched-question bootstrap: 10,000 draws, fixed seed " + str(BOOTSTRAP_SEED) +
                  ". Complete pairs only; unresolved failures excluded. Intervals are reference only.", ""])
    for name, item in aggregate["pairs"].items():
        lines.extend([f"### {name}", "",
                      f"Complete pairs: {item['completePairs']}/{item['selected']}; excluded: {item['excluded']}. "
                      f"Wins: {item['wins']}; losses: {item['losses']}; both correct: {item['bothCorrect']}; "
                      f"both wrong: {item['bothWrong']}. Mean difference: {value(item['meanDifference'])}; "
                      f"reference 95% CI: {item['bootstrap95CI']}.", "",
                      "| Question | Treatment correct | Baseline correct | Difference |",
                      "|---|---|---|---:|"])
        for row in item["perQuestion"]:
            lines.append(f"| {row['question_id']} | {value(row['treatmentCorrect'])} | "
                         f"{value(row['baselineCorrect'])} | {value(row['difference'])} |")
        lines.append("")
    lines.extend(["## Stratified accuracy", "",
                  "| Dimension | Stratum | Arm | Correct / selected | Scored | Wrong | Unresolved |",
                  "|---|---|---|---:|---:|---:|---:|"])
    for dimension, groups in aggregate["strata"].items():
        for group, data in groups.items():
            for arm, item in data["arms"].items():
                lines.append(f"| {dimension} | {group} | {arm} | {item['correct']}/{item['selected']} | "
                             f"{item['scored']} | {item['wrong']} | {item['failures']['unresolved']} |")
    lines.extend(["", "## Costs, latency, tool usage and failures", "",
                  "Observed/missing counts and per-tool means are included below; zero is not substituted for missing data.", ""])
    for arm, item in aggregate["arms"].items():
        lines.extend([f"### {arm}", "", "```json", json.dumps({key: item[key] for key in
                      ("failures", "toolCalls", "answerWallMs", "promptToCompleteMs", "tokens", "judgeScore")},
                      indent=2, ensure_ascii=False), "```", ""])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        aggregate = load_report(args.output)
    except (OSError, ValueError, TypeError) as error:
        parser.error(str(error))
    (args.output / "aggregate.json").write_text(json.dumps(aggregate, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (args.output / "REPORT.md").write_text(render_report(aggregate), encoding="utf-8")


if __name__ == "__main__":
    main()
