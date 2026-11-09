"""Explicit Python API entry point; no implicit dotenv loading or CLI defaults."""

import argparse
import json
from pathlib import Path

from inspect_ai import eval
from tasks import build_task, model_for


def exit_code(logs, expected_samples):
    return 0 if len(logs) == 1 and logs[0].status == "success" and logs[0].samples and len(logs[0].samples) == expected_samples and all(
        not sample.error and sample.scores and len(sample.scores) == 5 and
        all(score.value == 1 for score in sample.scores.values()) for sample in logs[0].samples) else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--log-dir", required=True)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    config = json.loads(Path(args.config).read_text())
    if config.get("schemaVersion") != 1 or not config.get("samples"):
        raise ValueError("Expected generated Inspect schemaVersion 1 configuration with samples")
    logs = eval(build_task(config), model=model_for(config["models"], "coding"),
                epochs=args.runs, max_samples=1, max_tasks=1, max_connections=1,
                fail_on_error=False, retry_on_error=0, log_dir=args.log_dir,
                log_format="eval", log_model_api=False, cache=False, display="plain")
    return exit_code(logs, len(config["samples"]) * args.runs)


if __name__ == "__main__":
    raise SystemExit(main())
