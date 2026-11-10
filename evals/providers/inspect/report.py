"""Read-only, redacted slot coverage for complete or interrupted native logs."""

import argparse
from collections import Counter
import json
from pathlib import Path
import re

SCORERS = {"ParentUpgrade", "SkillUsage", "JavaTarget", "ScenarioChecks", "UpgradeQuality"}


def error_summary(error):
    """Never include upstream bodies, which can contain credential hashes."""
    if error is None:
        return None
    # Inspect can wrap the original SDK error in tenacity.RetryError even when
    # there was only one HTTP request. Native EvalError retains its traceback.
    messages = []
    pending = [error]
    seen = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        messages.extend([str(getattr(current, "message", "")), str(getattr(current, "traceback", ""))])
        status = getattr(current, "status_code", None)
        if isinstance(status, int):
            messages.append(f"status_code={status}")
        messages.append(type(current).__name__)
        for nested in [getattr(current, "__cause__", None), getattr(current, "__context__", None)]:
            if nested is not None:
                pending.append(nested)
        attempt = getattr(current, "last_attempt", None)
        if attempt is not None and attempt.done() and not attempt.cancelled() and attempt.exception() is not None:
            pending.append(attempt.exception())
    message = "\n".join(messages)
    kind = re.search(r"\b(APIConnectionError|APITimeoutError|RateLimitError|AuthenticationError|"
                     r"PermissionDeniedError|BadRequestError|InternalServerError|CancelledError)\b", message)
    match = re.search(r"(?:Error code:|status(?:_code)?[=: ]+)\s*([45]\d\d)\b", message, re.IGNORECASE)
    status = int(match.group(1)) if match else None
    return {"type": kind.group(1) if kind else type(error).__name__,
            "httpStatus": status if isinstance(status, int) else None}


def validate_config(config, runs):
    if runs < 1 or config.get("schemaVersion") != 1 or not config.get("samples"):
        raise ValueError("Expected schemaVersion 1 configuration with samples and positive runs")
    ids = []
    for sample in config["samples"]:
        expected_id = f"{sample['scenario']['id']}--{sample['arm']}"
        if sample["arm"] not in {"with-skills", "without-skills"} or sample["id"] != expected_id:
            raise ValueError("Invalid Inspect sample identity")
        ids.append(sample["id"])
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate Inspect sample IDs")


def sample_record(sample, expected):
    evaluation = sample.metadata.get("evaluation", {})
    completion = evaluation.get("completion", {}).get("status")
    # Native submit must retain both the tool call and its successful result.
    submitted = {call.id for message in sample.messages if message.role == "assistant"
                 for call in (getattr(message, "tool_calls", None) or []) if call.function == "finish_task"
                 and isinstance(call.arguments, dict) and call.arguments.get("status") == "completed"
                 and isinstance(call.arguments.get("summary"), str) and call.arguments["summary"].strip()}
    transcript_complete = any(message.role == "tool" and getattr(message, "function", None) == "finish_task"
                              and getattr(message, "tool_call_id", None) in submitted
                              and not getattr(message, "error", None) for message in sample.messages)
    metadata = sample.metadata.get("sample", {})
    identity_matches = bool(expected and metadata.get("id") == expected["id"]
                            and metadata.get("arm") == expected["arm"]
                            and metadata.get("scenario") == expected["scenario"])
    scores = {name: score.value for name, score in (sample.scores or {}).items()}
    complete = identity_matches and completion == "completed" and transcript_complete and set(scores) == SCORERS
    error = error_summary(sample.error)
    if sample.error:
        outcome = "cancelled" if error["type"] == "CancelledError" else "error"
    elif not complete:
        outcome = "incomplete"
    else:
        outcome = "pass" if all(value == 1 for value in scores.values()) else "fail"
    return {"outcome": outcome, "scores": scores, "completion": completion,
            "transcriptComplete": transcript_complete, "identityMatches": identity_matches,
            "error": error,
            "runDir": sample.metadata.get("runDir", evaluation.get("runDir"))}


def summarize(logs, config, runs=1):
    validate_config(config, runs)
    expected = {(sample["id"], epoch): sample for sample in config["samples"] for epoch in range(1, runs + 1)}
    records = {key: [] for key in expected}
    unexpected = []
    native = []
    for log in logs:
        native.append({"status": log.status, "evalId": log.eval.eval_id, "runId": log.eval.run_id,
                       "location": log.location, "error": error_summary(log.error)})
        for sample in log.samples or []:
            key = (sample.id, sample.epoch)
            record = sample_record(sample, expected.get(key))
            if key in expected:
                records[key].append(record)
            else:
                unexpected.append({"id": sample.id, "epoch": sample.epoch, **record})
    slots = [{"id": key[0], "epoch": key[1], "scenario": expected[key]["scenario"]["id"],
              "arm": expected[key]["arm"],
              "outcome": "missing" if not values else "duplicate" if len(values) != 1 else values[0]["outcome"],
              "records": values} for key, values in records.items()]
    counts = dict(Counter(slot["outcome"] for slot in slots))
    all_passed = (len(logs) == 1 and logs[0].status == "success" and not logs[0].error
                  and not unexpected and counts.get("pass", 0) == len(expected))
    return {"schemaVersion": 1, "allPassed": all_passed, "expectedSlots": len(expected),
            "retainedSamples": sum(len(log.samples or []) for log in logs), "outcomes": counts,
            "logs": native, "slots": slots, "unexpected": unexpected,
            "note": "Log status describes retained data, not whether a process is running. Errors are not model defects."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--log", required=True, action="append", help="Retained .eval log; never modified")
    parser.add_argument("--output", help="New report file (must not already exist)")
    args = parser.parse_args()
    from inspect_ai.log import read_eval_log
    report = summarize([read_eval_log(log) for log in args.log], json.loads(Path(args.config).read_text()), args.runs)
    text = json.dumps(report, indent=2) + "\n"
    if args.output:
        with Path(args.output).open("x") as output:
            output.write(text)
    print(text, end="")
    return 0 if report["allPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
