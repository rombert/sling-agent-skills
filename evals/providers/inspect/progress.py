"""Durable redacted progress emitted by native Inspect sample hooks."""

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from uuid import uuid4

from inspect_ai.hooks import Hooks, hooks

from report import error_summary, sample_record

ACTIVE = ContextVar("sling_inspect_progress", default=None)


class Journal:
    def __init__(self, path, config):
        self.path = Path(path)
        self.expected = {sample["id"]: sample for sample in config["samples"]}
        self.samples = {}
        self.started = time.monotonic()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.output = self.path.open("x")

    def write(self, event, **fields):
        record = {"event": event, "at": datetime.now(timezone.utc).isoformat(),
                  "elapsedSeconds": round(time.monotonic() - self.started, 3), **fields}
        self.output.write(json.dumps(record) + "\n")
        self.output.flush()
        os.fsync(self.output.fileno())


@contextmanager
def progress_journal(log_dir, config):
    path = os.environ.get("INSPECT_PROGRESS_JOURNAL") or str(Path(log_dir) / f"progress-{uuid4().hex}.jsonl")
    journal = Journal(path, config)
    token = ACTIVE.set(journal)
    try:
        journal.write("evaluation_start", selectedSamples=list(journal.expected))
        print(json.dumps({"progressJournal": str(journal.path)}), flush=True)
        yield journal
    finally:
        ACTIVE.reset(token)
        journal.output.close()


@hooks(name="sling-inspect-progress", description="Redacted durable per-slot native progress")
class NativeProgress(Hooks):
    def enabled(self):
        return ACTIVE.get() is not None

    async def on_sample_start(self, data):
        journal = ACTIVE.get()
        identity = {"id": data.summary.id, "epoch": data.summary.epoch}
        journal.samples[data.sample_id] = identity
        journal.write("sample_start", evalId=data.eval_id, runId=data.run_id, **identity)

    async def on_sample_scoring(self, data):
        journal = ACTIVE.get()
        journal.write("sample_scoring", **journal.samples.get(data.sample_id, {}))

    async def on_sample_end(self, data):
        journal = ACTIVE.get()
        sample = data.sample
        journal.write("sample_end", id=sample.id, epoch=sample.epoch, evalId=data.eval_id,
                      runId=data.run_id, **sample_record(sample, journal.expected.get(sample.id)))
        journal.samples.pop(data.sample_id, None)

    async def on_run_end(self, data):
        ACTIVE.get().write("run_end", runId=data.run_id, error=error_summary(data.exception))
