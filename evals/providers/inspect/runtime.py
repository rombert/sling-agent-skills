"""Per-sample tools and artifact handling. Inspect owns the agent/model loop."""

import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
from typing import Literal

import yaml
from inspect_ai.tool import ToolError, tool

HERE = Path(__file__).resolve().parent
SECRET = re.compile(r"^(?:LITELLM|OPENAI|INSPECT|ANTHROPIC|GOOGLE|GEMINI)_.*(?:KEY|TOKEN|SECRET)$")


def child_environment(env=None):
    return {k: v for k, v in (os.environ if env is None else env).items()
            if not k.startswith("GIT_") and not SECRET.match(k) and k not in {"BASH_ENV", "ENV"}}


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def grading_evidence(calls):
    # Keep reference-fetch and Git-action evidence even if it occurs late in a
    # long task. Commands are evidence, not proof every mentioned URL was fetched.
    sources = {}
    git_actions = []
    for call in calls:
        command = call["input"]["command"]
        if re.search(r"https?://|\b(?:curl|wget)\b", command):
            sources[command] = call
        if re.search(r"\bgit\b", command):
            git_actions.append({"command": command[:500], "is_error": call["is_error"]})
    return {"sources": [{**call, "output": str(call["output"])[:2000]} for call in list(sources.values())[:12]],
            "gitActions": {"count": len(git_actions), "truncated": len(git_actions) > 20, "commands": git_actions[:20]}}


async def bridge(operation, payload):
    process = await asyncio.create_subprocess_exec(
        os.environ.get("EVAL_NODE", "node"), str(HERE / "bridge.cjs"), operation,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, env=child_environment(), start_new_session=True,
    )
    try:
        stdout, stderr = await process.communicate(json.dumps(payload).encode())
    except BaseException:
        if process.returncode is None:
            os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
        raise
    if process.returncode:
        raise RuntimeError(f"Inspect {operation} failed: {stderr.decode(errors='replace')}")
    return json.loads(stdout)


def install_skills(source, run_dir, enabled):
    if not enabled:
        return []
    destination = Path(run_dir) / "skills"
    shutil.copytree(source, destination)
    skills = []
    for directory in sorted(destination.iterdir()):
        if directory.is_dir() and not directory.name.startswith("."):
            document = directory / "SKILL.md"
            text = document.read_text()
            frontmatter = yaml.safe_load(text.split("---", 2)[1]) if text.startswith("---\n") else {}
            skills.append({"name": directory.name, "description": str(frontmatter.get("description", "")),
                           "path": str(document.resolve())})
    return skills


class Runtime:
    def __init__(self, metadata, limits, skills):
        self.metadata = metadata
        self.limits = limits
        self.skills = skills
        self.calls = []
        self.skill_reads = []
        self.completion = {"status": "incomplete", "summary": "No explicit completion recorded"}
        self.turns = 0
        self.text_turns = 0
        self.repeats = {}
        self.last_fingerprint = None
        self.stopped = False

    def stop(self, reason):
        self.stopped = True
        self.completion = {"status": "incomplete", "summary": reason}

    def fingerprint(self):
        entries = []
        for root, dirs, files in os.walk(self.metadata["workingDir"]):
            dirs[:] = sorted(d for d in dirs if d not in {".git", "target"})
            for name in sorted(files):
                path = Path(root) / name
                stat = path.lstat()
                entries.append((str(path), stat.st_size, stat.st_mtime_ns))
        return hashlib.sha256(json.dumps(entries).encode()).hexdigest()

    def begin(self, name, arguments):
        if self.stopped or self.completion["status"] != "incomplete":
            raise ToolError("Task has already stopped")
        fingerprint = self.fingerprint()
        if fingerprint != self.last_fingerprint:
            self.repeats.clear()
            self.last_fingerprint = fingerprint
        key = json.dumps([name, arguments], sort_keys=True)
        self.repeats[key] = self.repeats.get(key, 0) + 1
        if self.repeats[key] > self.limits["maxToolRepeats"]:
            self.stop("Repeated identical tool calls without edits")
            raise ToolError(self.completion["summary"])

    def record(self, name, arguments, output, error=False):
        self.calls.append({"name": name, "input": arguments, "output": output, "is_error": error})
        write_json(Path(self.metadata["runDir"]) / "tool-calls.json", self.calls)

    def path(self, requested, write=False):
        root = Path(self.metadata["workingDir"]).resolve()
        path = (root / requested).resolve()
        allowed = [root] if write else [root, *[Path(s["path"]).parent for s in self.skills]]
        if not any(path == base or base in path.parents for base in allowed):
            raise ToolError("Path must be inside the disposable project or installed skills")
        if path.is_relative_to(root) and ".git" in path.relative_to(root).parts:
            raise ToolError("Direct .git access is not available through file tools")
        return path

    def tools(self):
        @tool
        def read_file():
            async def execute(path: str) -> str:
                """Read an entire UTF-8 file. Use this tool to load SKILL.md.

                Args:
                    path: Absolute path or path relative to the project.
                """
                arguments = {"path": path}
                self.begin("read_file", arguments)
                try:
                    resolved = self.path(path)
                    if resolved.stat().st_size > 64000:
                        raise ToolError("File exceeds 64000 bytes; use bash for bounded inspection")
                    text = resolved.read_text()
                    self.record("read_file", arguments, text)
                    for skill in self.skills:
                        if resolved == Path(skill["path"]):
                            self.skill_reads.append(skill["name"])
                    return text
                except (OSError, UnicodeError, ToolError) as error:
                    self.record("read_file", arguments, str(error), True)
                    raise ToolError(str(error)) from error
            return execute

        @tool
        def edit_file():
            async def execute(path: str, old_text: str, new_text: str) -> str:
                """Replace one exact occurrence, or create a new file using empty old_text.

                Args:
                    path: File path relative to the project.
                    old_text: Existing text, which must occur exactly once; empty for a new file.
                    new_text: Replacement text or new file contents.
                """
                arguments = {"path": path, "old_text": old_text, "new_text": new_text}
                self.begin("edit_file", arguments)
                try:
                    resolved = self.path(path, write=True)
                    if old_text:
                        text = resolved.read_text()
                        if text.count(old_text) != 1:
                            raise ToolError("old_text must match exactly once")
                        resolved.write_text(text.replace(old_text, new_text, 1))
                    else:
                        resolved.parent.mkdir(parents=True, exist_ok=True)
                        with resolved.open("x") as output:
                            output.write(new_text)
                    self.record("edit_file", arguments, "File updated")
                    return "File updated"
                except (OSError, UnicodeError, ToolError) as error:
                    self.record("edit_file", arguments, str(error), True)
                    raise ToolError(str(error)) from error
            return execute

        @tool
        def bash():
            async def execute(command: str) -> str:
                """Run a shell command in the disposable project; output is bounded.

                Args:
                    command: Bash command. Use for search, builds and HTTP retrieval.
                """
                arguments = {"command": command}
                self.begin("bash", arguments)
                log = Path(self.metadata["runDir"]) / f"shell-{len(self.calls)}.log"
                with log.open("wb") as output:
                    process = await asyncio.create_subprocess_exec(
                        "bash", "--noprofile", "--norc", "-c", command,
                        cwd=self.metadata["workingDir"], env=child_environment(),
                        stdout=output, stderr=asyncio.subprocess.STDOUT, start_new_session=True,
                    )
                    try:
                        await asyncio.wait_for(process.wait(), self.metadata["mavenTimeoutMs"] / 1000)
                    except BaseException as error:
                        if process.returncode is None:
                            os.killpg(process.pid, signal.SIGKILL)
                            await process.wait()
                        self.record("bash", arguments, {"log": str(log), "error": "Command cancelled or timed out"}, True)
                        if isinstance(error, TimeoutError):
                            raise ToolError(f"Command timed out; full output: {log}") from error
                        raise
                with log.open("rb") as output:
                    head = output.read(16000)
                    truncated = bool(output.read(1))
                result = f"exit={process.returncode}\n" + head.decode(errors="replace")
                if truncated:
                    result += f"\n[truncated; full output: {log}]"
                self.record("bash", arguments, result, process.returncode != 0)
                return result
            return execute

        return [read_file(), edit_file(), bash()]

    def submit_tool(self):
        @tool
        def finish_task():
            async def execute(status: Literal["completed", "blocked"], summary: str) -> str:
                """Explicitly finish the task with a truthful status and verification summary.

                Args:
                    status: completed only when the task is done; otherwise blocked.
                    summary: Changes, verification results and any blockers.
                """
                if not summary.strip():
                    raise ToolError("A nonempty summary is required")
                if self.stopped:
                    raise ToolError("Task has already stopped")
                self.turns += 1
                self.completion = {"status": status, "summary": summary}
                self.record("finish_task", self.completion, summary)
                return summary
            return execute
        return finish_task()

    async def on_continue(self, state):
        self.turns += 1
        self.text_turns = 0 if state.output.message.tool_calls else self.text_turns + 1
        if self.stopped:
            return False
        if state.output.stop_reason == "content_filter":
            self.stop("Model refused the task")
        elif self.turns >= self.limits["maxTurns"]:
            self.stop("Agent turn budget exhausted")
        elif self.text_turns >= self.limits["maxTextOnlyTurns"]:
            self.stop("Consecutive text-only turn budget exhausted")
        if self.stopped:
            return False
        return True if state.output.message.tool_calls else "Continue using tools, or call finish_task with an explicit status and summary."

    def persist(self):
        self.metadata.update(completion=self.completion, skillReads=self.skill_reads, turns=self.turns)
        run_dir = Path(self.metadata["runDir"])
        write_json(run_dir / "completion.json", self.completion)
        write_json(run_dir / "state.json", self.metadata)
        write_json(run_dir / "tool-calls.json", self.calls)
        (run_dir / "summary.txt").write_text(self.completion["summary"])
