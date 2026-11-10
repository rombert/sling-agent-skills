"""Explicit Python API entry point; no implicit dotenv loading or CLI defaults."""

import argparse
import json
from pathlib import Path

from inspect_ai import eval
from progress import progress_journal
from report import error_summary, summarize, validate_config
from tasks import build_task, model_for


def exit_code(logs, config, runs=1):
    return 0 if summarize(logs, config, runs)["allPassed"] else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--log-dir", required=True)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    config = json.loads(Path(args.config).read_text())
    validate_config(config, args.runs)
    with progress_journal(args.log_dir, config):
        logs = eval(build_task(config), model=model_for(config["models"], "coding"),
                    epochs=args.runs, max_samples=1, max_tasks=1, max_connections=1,
                    fail_on_error=True, retry_on_error=0, log_dir=args.log_dir,
                    log_format="eval", log_model_api=False, cache=False, display="none",
                    log_level="critical", log_samples=True, log_realtime=True, log_buffer=1)
    report = summarize(logs, config, args.runs)
    # Unique to this native evaluation; never overwrite another run's report.
    destination = Path(args.log_dir) / f"coverage-{logs[0].eval.eval_id}.json" if logs else None
    if destination:
        with destination.open("x") as output:
            output.write(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["allPassed"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print('{"interrupted": true, "hint": "Use report.py to inspect retained native log coverage"}')
        raise SystemExit(130)
    except Exception as error:
        print(json.dumps({"error": error_summary(error), "hint": "Inspect retained native logs locally; upstream bodies are not printed"}))
        raise SystemExit(1)
