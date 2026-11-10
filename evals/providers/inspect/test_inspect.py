"""Offline native Inspect tests: local HTTP model, fake fixtures/builds, real tools/logs."""

import asyncio
from contextlib import contextmanager, redirect_stdout
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
from io import StringIO
import json
import os
from pathlib import Path
import re
import tempfile
from threading import Thread
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from inspect_ai import eval_async

from runtime import Runtime, bridge, child_environment, grading_evidence, install_skills
from tasks import build_task, model_for, parse_verdict
from report import SCORERS, error_summary, summarize, validate_config

HERE = Path(__file__).resolve().parent


@contextmanager
def mock_endpoint(mode="completed"):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append({"path": self.path, "body": body, "authorization": self.headers.get("Authorization")})
            if mode == "error":
                self.send_response(429)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"Test rate limit","type":"rate_limit_error","api_key":"test-credential-hash-never-print"}}')
                return
            message = {"role": "assistant", "content": ""}
            if body["model"] == "gemma4-26b":
                message["content"] = 'not-json' if mode == "badjudge" else '{"pass":true,"reason":"Mock criteria met"}'
                if mode == "fencedjudge":
                    message["content"] = f"```json\n{message['content']}\n```"
            elif mode == "compaction" and not body.get("tools"):
                message["content"] = "The parent upgrade is in progress. Inspect pom.xml and finish the task."
            elif mode in {"text", "refusal"}:
                message["content"] = "Let me think about the next step."
            else:
                calls = [call for entry in body["messages"] if entry["role"] == "assistant"
                         for call in entry.get("tool_calls", [])]
                names = [call["function"]["name"] for call in calls]
                if mode == "compaction":
                    stage = len([r for r in requests if r["body"]["model"] == "qwen3.8-27b" and r["body"].get("tools")]) - 1
                    names = ["edit_file", "bash"][:stage]
                skill = re.search(r'"path": "([^"\n]*SKILL.md)"', json.dumps(body["messages"][0]["content"]).replace('\\"', '"'))
                if mode == "blocked":
                    name, arguments = "finish_task", {"status": "blocked", "summary": "Test blocker"}
                elif mode == "timeout":
                    name, arguments = "bash", {"command": "sleep 30"}
                elif mode == "repeat":
                    name, arguments = "read_file", {"path": "pom.xml"}
                elif skill and "read_file" not in names:
                    name, arguments = "read_file", {"path": skill.group(1)}
                elif "edit_file" not in names:
                    name, arguments = "edit_file", {"path": "pom.xml", "old_text": "34", "new_text": "46"}
                elif "bash" not in names:
                    name, arguments = "bash", {"command": 'test -z "$LITELLM_API_KEY$OPENAI_API_KEY$GIT_DIR" && echo clean-environment'}
                else:
                    name, arguments = "finish_task", {"status": "completed", "summary": "Parent upgraded and verified"}
                message["tool_calls"] = [{"id": f"call-{len(calls)}", "type": "function",
                                          "function": {"name": name, "arguments": json.dumps(arguments)}}]
            response = {"id": "mock-response", "object": "chat.completion", "created": 1,
                        "model": body["model"], "choices": [{"index": 0, "message": message,
                        "finish_reason": "content_filter" if mode == "refusal" else ("tool_calls" if message.get("tool_calls") else "stop")}],
                        "usage": {"prompt_tokens": 15000 if mode == "compaction" else 100,
                                  "completion_tokens": 20, "total_tokens": 15020 if mode == "compaction" else 120}}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class VerdictTests(unittest.TestCase):
    def test_bare_and_single_fenced_json_preserve_true_and_false_verdicts(self):
        for passed in [True, False]:
            verdict = {"pass": passed, "reason": "Judge explanation"}
            text = json.dumps(verdict)
            for response in [text, f"```json\n{text}\n```", f"```\n{text}\n```", f" \n```JSON\r\n{text}\r\n```\n "]:
                with self.subTest(response=response):
                    self.assertEqual(parse_verdict(response), verdict)

    def test_ambiguous_malformed_or_wrongly_typed_verdicts_fail_closed(self):
        valid = '{"pass":true,"reason":"ok"}'
        for response in ["not-json", "[]", "null", "{}", '{"pass":"true","reason":"ok"}',
                         '{"pass":1,"reason":"ok"}', '{"pass":true,"reason":null}',
                         f"Some prose\n{valid}", f"```json\n{valid}\n```\nMore prose",
                         f"```json\n{valid}\n```\n```json\n{valid}\n```", f"```python\n{valid}\n```"]:
            with self.subTest(response=response), self.assertRaises((ValueError, TypeError)):
                parse_verdict(response)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sling-inspect-python-", dir="/tmp/opencode")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.project.mkdir()
        (self.project / "pom.xml").write_text("34")
        self.runtime = Runtime({"runDir": str(self.root), "workingDir": str(self.project), "mavenTimeoutMs": 100},
                               {"maxToolRepeats": 3, "maxTurns": 80, "maxTextOnlyTurns": 3}, [])

    async def test_filter_paths_edits_and_repetition(self):
        self.assertEqual(child_environment({"PATH": "/bin", "LITELLM_API_KEY": "secret", "OPENAI_API_KEY": "secret",
                         "GIT_DIR": "elsewhere", "MAVEN_REPOSITORY_TOKEN": "needed",
                         "MAVEN_ARGS": "--settings /private/settings.xml", "MAVEN_OPTS": "-Dmaven.repo.local=/private/repository"}),
                         {"PATH": "/bin", "MAVEN_REPOSITORY_TOKEN": "needed", "MAVEN_ARGS": "--settings /private/settings.xml",
                          "MAVEN_OPTS": "-Dmaven.repo.local=/private/repository"})
        read, edit, _ = self.runtime.tools()
        for _ in range(3):
            self.assertEqual(await read("pom.xml"), "34")
        with self.assertRaisesRegex(Exception, "Repeated identical"):
            await read("pom.xml")
        self.assertEqual(self.runtime.completion["status"], "incomplete")
        self.runtime.stopped = False
        await edit("pom.xml", "34", "46")
        self.assertEqual(await read("pom.xml"), "46")
        with self.assertRaisesRegex(Exception, "exactly once"):
            await edit("pom.xml", "absent", "no")
        outside = self.root / "outside"
        outside.write_text("private")
        (self.project / "escape").symlink_to(outside)
        for path in [str(outside), "escape", "../outside", ".git/config"]:
            with self.assertRaises(Exception):
                await read(path)

    async def test_skill_read_credit_and_no_skills_isolation(self):
        source = self.root / "source"
        skill = source / "update-sling-parent-pom"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: update-sling-parent-pom\ndescription: Test description\n---\nInstructions")
        (skill / "references").mkdir()
        (skill / "references" / "helper.md").write_text("reference")
        self.assertEqual(install_skills("/does-not-exist", self.root, False), [])
        self.runtime.skills = install_skills(source, self.root, True)
        read, edit, _ = self.runtime.tools()
        await read(self.runtime.skills[0]["path"])
        self.assertEqual(self.runtime.skill_reads, ["update-sling-parent-pom"])
        self.assertTrue((self.root / "skills/update-sling-parent-pom/references/helper.md").exists())
        with self.assertRaises(Exception):
            await edit(self.runtime.skills[0]["path"], "Instructions", "modified")
        self.runtime.persist()
        self.assertEqual(json.loads((self.root / "state.json").read_text())["skillReads"], self.runtime.skill_reads)

    async def test_shell_timeout_kills_process_and_preserves_log(self):
        _, _, bash = self.runtime.tools()
        with self.assertRaisesRegex(Exception, "Command timed out"):
            await bash("echo started; sleep 30")
        self.assertIn("started", (self.root / "shell-0.log").read_text())
        self.assertTrue(self.runtime.calls[0]["is_error"])

    async def test_bridge_reports_native_node_failure(self):
        with self.assertRaisesRegex(RuntimeError, "Unknown Inspect bridge operation"):
            await bridge("not-an-operation", {})

    async def test_judge_evidence_retains_late_fetches_and_git_actions(self):
        calls = [{"input": {"command": "mvn verify"}, "output": "build", "is_error": False}] * 30
        calls += [{"input": {"command": "curl https://example.invalid/reference"}, "output": "reference", "is_error": False},
                  {"input": {"command": "git status"}, "output": "status", "is_error": False}]
        evidence = grading_evidence(calls)
        self.assertEqual(len(evidence["sources"]), 1)
        self.assertEqual(evidence["sources"][0]["output"], "reference")
        self.assertEqual(evidence["gitActions"]["count"], 1)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.sample_config = {"id": "scenario--with-skills", "arm": "with-skills", "scenario": {"id": "scenario", "pin": "original"}}
        self.config = {"schemaVersion": 1, "samples": [self.sample_config]}
        call = SimpleNamespace(id="submit-1", function="finish_task", arguments={"status": "completed", "summary": "Done"})
        self.sample = SimpleNamespace(id=self.sample_config["id"], epoch=1, error=None,
                                      metadata={"sample": deepcopy(self.sample_config), "runDir": "/retained/run",
                                                "evaluation": {"completion": {"status": "completed"}}},
                                      scores={name: SimpleNamespace(value=1) for name in SCORERS},
                                      messages=[SimpleNamespace(role="assistant", tool_calls=[call]),
                                                SimpleNamespace(role="tool", function="finish_task", tool_call_id="submit-1", error=None)])
        self.log = SimpleNamespace(status="success", error=None, location="/retained/native.eval", samples=[self.sample],
                                   eval=SimpleNamespace(eval_id="eval-1", run_id="run-1"))

    def test_exact_identity_epochs_scorers_and_completion_fail_closed(self):
        from runner import exit_code
        self.assertEqual(exit_code([self.log], self.config), 0)
        self.assertEqual(exit_code([self.log], self.config, 2), 1)
        mutations = [lambda s: setattr(s, "id", "wrong-slot"), lambda s: setattr(s, "epoch", 2),
                     lambda s: s.scores.pop("JavaTarget"),
                     lambda s: s.scores.update({"WrongScorer": s.scores.pop("JavaTarget")}),
                     lambda s: setattr(s.scores["UpgradeQuality"], "value", 0),
                     lambda s: s.metadata["sample"]["scenario"].update(pin="different"),
                     lambda s: s.metadata["evaluation"]["completion"].update(status="blocked"),
                     lambda s: s.messages.pop(),
                     lambda s: setattr(s.messages[-1], "tool_call_id", "wrong-id"),
                     lambda s: s.messages[0].tool_calls[0].arguments.update(status="blocked")]
        for mutate in mutations:
            log = deepcopy(self.log)
            mutate(log.samples[0])
            with self.subTest(mutation=mutate):
                self.assertEqual(exit_code([log], self.config), 1)
        self.assertEqual(exit_code([], self.config), 1)
        self.assertEqual(exit_code([self.log, self.log], self.config), 1)

    def test_duplicate_cannot_replace_missing_slot_at_same_count(self):
        self.config["samples"].append({"id": "scenario--without-skills", "arm": "without-skills", "scenario": {"id": "scenario"}})
        self.log.samples.append(deepcopy(self.sample))
        report = summarize([self.log], self.config)
        self.assertFalse(report["allPassed"])
        self.assertEqual(report["outcomes"], {"duplicate": 1, "missing": 1})

    def test_interrupted_log_retains_passes_and_errors_without_claiming_complete(self):
        self.log.status = "started"
        report = summarize([self.log], self.config, 2)
        self.assertFalse(report["allPassed"])
        self.assertEqual(report["outcomes"], {"pass": 1, "missing": 1})
        self.sample.error = SimpleNamespace(message='RateLimitError: Error code: 429 {"api_key":"never-print-hash"}')
        report = summarize([self.log], self.config)
        self.assertEqual(report["slots"][0]["outcome"], "error")
        self.assertEqual(report["slots"][0]["records"][0]["error"], {"type": "RateLimitError", "httpStatus": 429})
        self.assertNotIn("never-print", json.dumps(report))
        self.assertEqual(error_summary(SimpleNamespace(message="APIConnectionError: private body"))["type"], "APIConnectionError")

    def test_invalid_or_duplicate_config_rejected_before_execution(self):
        with self.assertRaises(ValueError):
            validate_config(self.config, 0)
        self.config["samples"].append(deepcopy(self.sample_config))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            validate_config(self.config, 1)

    def test_runner_is_serial_retry_free_fail_fast_and_writes_coverage(self):
        from runner import main
        with tempfile.TemporaryDirectory(prefix="sling-inspect-report-", dir="/tmp/opencode") as directory:
            root = Path(directory)
            config = {**self.config, "models": {}}
            path = root / "config.json"
            path.write_text(json.dumps(config))
            args = ["runner.py", "--config", str(path), "--log-dir", str(root)]
            with patch("sys.argv", args), patch("runner.build_task"), patch("runner.model_for"), \
                    patch("runner.eval", return_value=[self.log]) as evaluate, redirect_stdout(StringIO()):
                self.assertEqual(main(), 0)
            kwargs = evaluate.call_args.kwargs
            self.assertTrue(kwargs["fail_on_error"])
            self.assertEqual(kwargs["retry_on_error"], 0)
            self.assertEqual([kwargs[key] for key in ["max_samples", "max_tasks", "max_connections"]], [1, 1, 1])
            self.assertEqual(kwargs["display"], "none")
            self.assertFalse(kwargs["log_model_api"])
            self.assertTrue(kwargs["log_realtime"])
            self.assertEqual(kwargs["log_buffer"], 1)
            self.assertTrue(json.loads((root / "coverage-eval-1.json").read_text())["allPassed"])


class NativeInspectTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration = 10
        self.temp = tempfile.TemporaryDirectory(prefix="sling-inspect-native-", dir="/tmp/opencode")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = self.root / "source-skills/update-sling-parent-pom"
        source.mkdir(parents=True)
        (source / "SKILL.md").write_text("---\nname: update-sling-parent-pom\ndescription: Upgrade Sling parents\n---\nTest instructions")
        self.config = {"schemaVersion": 1, "models": json.loads((HERE / "../../models.json").read_text()),
                       "agent": json.loads((HERE / "config.json").read_text()), "skillsDir": str(source.parent),
                       "samples": []}
        scenario = {"id": "mock-scenario", "skill": "update-sling-parent-pom", "prompt": "Upgrade parent to 46",
                    "criteria": [{"id": "quality", "description": "SECRET-GRADING-CRITERIA"}],
                    "checks": [{"type": "pom_parent", "expected": {"group_id": "org.apache.sling", "artifact_id": "sling-bundle-parent", "version": "46"}}]}
        for arm in ["with-skills", "without-skills"]:
            self.config["samples"].append({"id": f"mock-scenario--{arm}", "arm": arm, "scenario": deepcopy(scenario)})
        self.bridge_calls = []
        self.prepared = []

        async def fake_bridge(operation, payload):
            self.bridge_calls.append(operation)
            if operation == "prepare":
                run_dir = Path(payload["runDir"])
                working = run_dir / "project"
                working.mkdir()
                (working / "pom.xml").write_text("34")
                self.prepared.append(str(run_dir))
                return {"runDir": str(run_dir), "workingDir": str(working), "scenario": payload["scenario"],
                        "baselineCommit": "a" * 40, "initialParent": {}, "mavenTimeoutMs": 1200000}
            if operation == "diff":
                diff = (Path(payload["workingDir"]) / "pom.xml").read_text()
                (Path(payload["runDir"]) / "changes.patch").write_text(diff)
                return {"diff": diff}
            if operation == "checks":
                passed = payload["completion"]["status"] == "completed" and (Path(payload["workingDir"]) / "pom.xml").read_text() == "46"
                return {name: {"pass": passed, "reason": "Fake build result"} for name in ["ParentUpgrade", "JavaTarget", "ScenarioChecks"]}
            raise AssertionError(operation)

        self.addCleanup(patch.stopall)
        patch("tasks.bridge", new=fake_bridge).start()
        patch.dict(os.environ, {"LITELLM_API_KEY": "local-test-secret", "OPENAI_API_KEY": "other-test-secret",
                              "INSPECT_WORKSPACE_ROOT": str(self.root), "GIT_DIR": "/not-the-project"}).start()

    async def evaluate(self, endpoint, epochs=1, fail_on_error=False):
        self.config["models"]["apiBaseUrl"] = endpoint
        # A future change must not silently add Inspect's CLI dotenv loading.
        with patch("dotenv.load_dotenv", side_effect=AssertionError("No implicit dotenv loading")):
            logs = await eval_async(build_task(self.config), model=model_for(self.config["models"], "coding"),
                                    epochs=epochs, max_samples=1, max_tasks=1, max_connections=1, fail_on_error=fail_on_error,
                                    retry_on_error=0, log_dir=str(self.root / "logs"), log_model_api=False, cache=False)
        self.assertEqual(len(logs), 1)
        return logs[0]

    async def test_native_agent_requests_scores_epochs_and_logs(self):
        with mock_endpoint() as (endpoint, requests):
            log = await self.evaluate(endpoint, epochs=2)
        self.assertEqual(log.status, "success", str(log.error))
        self.assertEqual(len(log.samples), 4)
        self.assertEqual(len(set(self.prepared)), 4)
        self.assertEqual(self.bridge_calls.count("checks"), 4)
        for sample in log.samples:
            self.assertIsNone(sample.error)
            self.assertEqual(set(sample.scores), {"ParentUpgrade", "SkillUsage", "JavaTarget", "ScenarioChecks", "UpgradeQuality"})
            self.assertTrue(all(score.value == 1 for score in sample.scores.values()), str(sample.scores))
            evaluation = sample.metadata["evaluation"]
            self.assertEqual(evaluation["completion"]["status"], "completed")
            self.assertTrue((Path(evaluation["runDir"]) / "completion.json").exists())
            calls = json.loads((Path(evaluation["runDir"]) / "tool-calls.json").read_text())
            self.assertIn("clean-environment", next(call["output"] for call in calls if call["name"] == "bash"))
        coding = [request for request in requests if request["body"]["model"] == "qwen3.8-27b"]
        grading = [request for request in requests if request["body"]["model"] == "gemma4-26b"]
        self.assertEqual(len(grading), 4)
        for request in coding:
            self.assertEqual(request["path"], "/v1/chat/completions")
            self.assertEqual(request["authorization"], "Bearer local-test-secret")
            self.assertEqual(request["body"]["temperature"], 0)
            self.assertEqual(request["body"]["max_tokens"], 8192)
            self.assertEqual(request["body"]["chat_template_kwargs"], {"enable_thinking": True})
            self.assertNotIn("SECRET-GRADING-CRITERIA", json.dumps(request["body"]))
        native_logs = list((self.root / "logs").glob("*.eval"))
        self.assertEqual(len(native_logs), 1)
        from inspect_ai.log import read_eval_log
        reloaded = read_eval_log(str(native_logs[0]))
        self.assertEqual(len(reloaded.samples), 4)
        self.assertNotIn("local-test-secret", reloaded.model_dump_json())
        # Reporting a retained native log must not rewrite or rescore it.
        from report import main as report_main
        config_path = self.root / "config.json"
        config_path.write_text(json.dumps(self.config))
        report_path = self.root / "offline-report.json"
        original_digest = hashlib.sha256(native_logs[0].read_bytes()).digest()
        args = ["report.py", "--config", str(config_path), "--runs", "2", "--log", str(native_logs[0]), "--output", str(report_path)]
        with patch("sys.argv", args), redirect_stdout(StringIO()):
            self.assertEqual(report_main(), 0)
        self.assertTrue(json.loads(report_path.read_text())["allPassed"])
        self.assertEqual(hashlib.sha256(native_logs[0].read_bytes()).digest(), original_digest)
        with patch("sys.argv", args), self.assertRaises(FileExistsError):
            report_main()
        from runner import exit_code
        self.assertEqual(exit_code([log], self.config, 2), 0)
        self.assertEqual(exit_code([log], self.config, 3), 1)
        self.assertEqual(exit_code([], self.config), 1)
        log.samples[0].scores["ParentUpgrade"].value = 0
        self.assertEqual(exit_code([log], self.config, 2), 1)

    async def test_native_summary_compaction_usage_is_retained(self):
        self.config["samples"] = self.config["samples"][1:]
        self.config["models"]["coding"]["contextWindow"] = 20000
        self.config["agent"]["compactionReserveTokens"] = 10000
        with mock_endpoint("compaction") as (endpoint, requests):
            log = await self.evaluate(endpoint)
        sample = log.samples[0]
        self.assertIsNone(sample.error, str(sample.error))
        summaries = [r for r in requests if r["body"]["model"] == "qwen3.8-27b" and not r["body"].get("tools")]
        self.assertGreater(len(summaries), 0)
        usage = sample.model_usage["openai-api/litellm/qwen3.8-27b"]
        coding_requests = [r for r in requests if r["body"]["model"] == "qwen3.8-27b"]
        self.assertEqual(usage.input_tokens, len(coding_requests) * 15000)

    async def test_fenced_judge_json_is_accepted_without_another_judge_call(self):
        self.config["samples"] = self.config["samples"][1:]
        with mock_endpoint("fencedjudge") as (endpoint, requests):
            log = await self.evaluate(endpoint)
        sample = log.samples[0]
        self.assertIsNone(sample.error)
        self.assertEqual(sample.scores["UpgradeQuality"].value, 1)
        self.assertEqual(len([r for r in requests if r["body"]["model"] == "gemma4-26b"]), 1)

    async def test_blocked_text_only_and_stall_are_failed_scores_without_judge_calls(self):
        self.config["samples"] = self.config["samples"][1:]
        for mode, expected_calls in [("blocked", 1), ("text", 3), ("repeat", 4), ("refusal", 1)]:
            with self.subTest(mode=mode), mock_endpoint(mode) as (endpoint, requests):
                log = await self.evaluate(endpoint)
                self.assertEqual(log.status, "success", str(log.error))
                sample = log.samples[0]
                self.assertIsNone(sample.error)
                self.assertEqual(sample.scores["ParentUpgrade"].value, 0)
                self.assertEqual(sample.scores["UpgradeQuality"].value, 0)
                self.assertEqual(len(requests), expected_calls)
                self.assertNotEqual(sample.metadata["evaluation"]["completion"]["status"], "completed")

    async def test_transport_failure_has_no_retries_and_retains_error(self):
        self.config["samples"] = self.config["samples"][1:]
        with mock_endpoint("error") as (endpoint, requests):
            log = await self.evaluate(endpoint)
        self.assertEqual(len(requests), 1)
        sample = log.samples[0]
        self.assertIsNotNone(sample.error)
        self.assertTrue((Path(sample.metadata["runDir"]) / "error.json").exists())
        error = json.loads((Path(sample.metadata["runDir"]) / "error.json").read_text())
        self.assertEqual(error, {"type": "RateLimitError", "httpStatus": 429})
        self.assertNotIn("test-credential-hash", json.dumps(error))
        report = summarize([log], self.config)
        self.assertEqual(report["outcomes"], {"error": 1})
        self.assertNotIn("test-credential-hash", json.dumps(report))
        self.assertEqual(sample.metadata["evaluation"]["completion"]["status"], "incomplete")

    async def test_runner_fail_fast_retains_cancellation_without_more_model_requests(self):
        with mock_endpoint("error") as (endpoint, requests):
            log = await self.evaluate(endpoint, fail_on_error=True)
        self.assertEqual(len(requests), 1)
        report = summarize([log], self.config)
        self.assertFalse(report["allPassed"])
        self.assertEqual(report["outcomes"], {"error": 1, "cancelled": 1})

    async def test_real_runner_retains_native_error_but_only_prints_redacted_coverage(self):
        from runner import main
        with mock_endpoint("error") as (endpoint, requests):
            self.config["models"]["apiBaseUrl"] = endpoint
            config = self.root / "config.json"
            config.write_text(json.dumps(self.config))
            output = StringIO()
            with patch("sys.argv", ["runner.py", "--config", str(config), "--log-dir", str(self.root / "logs")]), \
                    redirect_stdout(output):
                code = await asyncio.to_thread(main)
        self.assertEqual(code, 1)
        self.assertEqual(len(requests), 1)
        self.assertNotIn("test-credential-hash", output.getvalue())
        reports = list((self.root / "logs").glob("coverage-*.json"))
        self.assertEqual(len(reports), 1)
        report = json.loads(reports[0].read_text())
        self.assertEqual(report["outcomes"], {"error": 1, "cancelled": 1})
        self.assertEqual(report["slots"][0]["records"][0]["error"], {"type": "RateLimitError", "httpStatus": 429})
        journals = list((self.root / "logs").glob("progress-*.jsonl"))
        self.assertEqual(len(journals), 1)
        text = journals[0].read_text()
        self.assertNotIn("test-credential-hash", text)
        events = [json.loads(line) for line in text.splitlines()]
        self.assertEqual(events[0]["event"], "evaluation_start")
        self.assertTrue(any(event["event"] == "sample_start" for event in events))
        endings = [event for event in events if event["event"] == "sample_end"]
        self.assertEqual({event["outcome"] for event in endings}, {"error", "cancelled"})
        self.assertEqual(events[-1]["event"], "run_end")

    async def test_timeout_and_invalid_judge_fail_closed(self):
        self.config["samples"] = self.config["samples"][1:]
        self.config["agent"]["taskTimeoutSeconds"] = 0.1
        with mock_endpoint("timeout") as (endpoint, requests):
            log = await self.evaluate(endpoint)
        sample = log.samples[0]
        self.assertIsNone(sample.error)
        self.assertEqual(sample.scores["ParentUpgrade"].value, 0)
        self.assertEqual(sample.metadata["evaluation"]["completion"]["status"], "incomplete")
        self.config["agent"]["taskTimeoutSeconds"] = 3600
        with mock_endpoint("badjudge") as (endpoint, requests):
            log = await self.evaluate(endpoint)
        self.assertEqual(log.samples[0].scores["UpgradeQuality"].value, 0)


if __name__ == "__main__":
    unittest.main()
