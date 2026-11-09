# Inspect adapter

Run the shared real-repository scenarios with **native Inspect ReAct agents,
registered tools, five scorers and `.eval` logs**. This does not launch Pi or
Promptfoo. The two skills arms use identical coding models, prompts and tools;
only skill availability differs. Comparisons with Promptfoo also change the
agent harness, not just the evaluation framework.

## Prerequisites and commands

Install the shared Node dependencies with `npm ci`. Install
[uv](https://docs.astral.sh/uv/), and select Java 21 for **both** `java` and `mvn`.
Python 3.11+ is required; uv resolves the Python environment using the committed
`pyproject.toml` and `uv.lock`, with Inspect pinned to **0.3.287**. The private
environment lives under ignored `target/evals/inspect-venv`. Initial dependency
installation may access package registries; offline tests never call the gateway.

```sh
make generate-eval PROVIDER=inspect \
  SCENARIO=jcr-js-nodetypes-parent-34-to-46 ARM=with-skills

make test-evals   # Node adapter and existing provider/shared tests
make test-inspect # Native Python tests, including a local mock model endpoint

# Real execution: calls the coding and grading models, clones and builds.
export JAVA_HOME=/path/to/jdk-21
export PATH="$JAVA_HOME/bin:$PATH"
make run-eval PROVIDER=inspect \
  SCENARIO=jcr-js-nodetypes-parent-34-to-46 ARM=with-skills RUNS=1

make view-evals PROVIDER=inspect
```

Generation is offline, credential-free and does not require Python. It translates
`evals/scenarios.yaml` into `target/evals/inspect.json` (override `EVAL_CONFIG`).
`run-eval` regenerates it. `SCENARIO`, `ARM` and `RUNS` have their common meanings;
Inspect epochs implement repetitions, preparing a fresh clone each time. No
evaluation is retried in a fresh clone. Native logs go to
`target/evals/inspect-logs`; `EVAL_RESULTS` overrides this **directory** for both
execution and viewing. Failed scores or execution errors produce a nonzero exit.

## Same Apache gateway, models and credential

`evals/models.json` is the single maintained selection for Promptfoo and Inspect:

- Gateway: `https://llm.apache.org/v1`.
- Coding: `qwen3.8-27b`, temperature 0, output limit 8192, context 131072.
- Coding request body: `chat_template_kwargs: { enable_thinking: true }`.
- Quality grading: `gemma4-26b`, one call combining the scenario's criteria.

Inspect uses its **OpenAI-compatible Chat Completions provider** with names such
as `openai-api/litellm/qwen3.8-27b`. The `litellm` namespace reads the existing
`LITELLM_API_KEY` directly; this is not Inspect's separate `litellm-proxy`
integration and does not require proxy model-info discovery. The base URL is
always explicitly supplied. No OpenAI-hosted endpoint or model fallback is used.

Execution uses an exported `LITELLM_API_KEY`, otherwise the existing encrypted
`.env` through `sops exec-env`. **Do not edit `.env`, add aliases, or create a
plaintext decrypted copy.** No key is placed in generated config, CLI arguments
or model API logs. Model keys and inherited `GIT_*` context are filtered from
fixture/check/shell subprocess environments; unrelated Maven credentials remain.

## Agent, skills and limits

Inspect owns model requests, the ReAct loop and summary compaction. Small
registered file/edit/bash tools bind operations to the prepared project, audit
complete skill reads, sanitize subprocess environments and retain full command
logs. No personal agent configuration, MCP servers or skills are discovered.
File tools reject paths outside the project/installed skills and writes to skills.
The shell is unrestricted host Bash, just as local builds execute host code.

The with-skills arm copies the complete `skills/` tree into the private run
directory. Only names, descriptions and document paths are advertised; the
model must load instructions using `read_file`. Only successful whole-file reads
of an installed `SKILL.md` receive SkillUsage credit. Shell reads are not credited.
The without-skills arm installs and advertises no skills.

`config.json` controls 80 turns, three consecutive text-only turns, at most three
identical tool calls without edits, and a one-hour agent timeout. Commands use
the scenario's timeout (currently 20 minutes). Calls to `finish_task` must provide
`completed` or `blocked` and a nonempty summary. Narration is not completion.
Blocked, missing-completion, stalled and timed-out tasks fail completion-dependent
checks. API errors remain native sample errors and retain diagnostic artifacts.
Runs are serial; coding request retries, refusal retries and caching are disabled.

Summary compaction uses the coding model, with the shared context window minus
the configured 16384-token reserve as its threshold. Inspect logs retain the
original transcript and summarization usage. This is native Inspect compaction,
not an assertion that it behaves identically to Pi's compaction.

## Scoring and artifacts

`ParentUpgrade`, `JavaTarget` and `ScenarioChecks` call the existing shared Node
helpers through a narrow JSON bridge. They check actual parent coordinates,
resolved bytecode targets and independent `mvn clean verify` artifacts; Python
does not reimplement XML/Maven grading. Missing completion and invalid parents
gate the expensive verification commands. `SkillUsage` uses audited reads and
the scenario's required skill. `UpgradeQuality` judges the actual diff, bounded
shell evidence and summary against the scenario's criteria. Judge verdicts may
be bare JSON or one complete JSON code fence; malformed, ambiguous or incorrectly
typed verdicts still fail closed. Incomplete tasks do not trigger a grading call.

Per-attempt artifacts live under `/tmp/opencode/sling-inspect-eval-*` (override
`INSPECT_WORKSPACE_ROOT`). They retain prepared provenance, runtime versions,
completion, tool calls, full shell logs, patch, checks and errors. The location
is also in the native sample metadata. Original fixture checkouts are never
edited, staged, committed, cleaned or reset.

**Local execution is not an OS sandbox.** An unrestricted shell can access host
files and network; credential filtering is not protection against malicious
project code or deliberate host inspection. Use a disposable machine/container
for untrusted projects. Inspect artifacts before sharing them.

## Live validation (2026-11-06)

A single real `jcr-js-nodetypes-parent-34-to-46` with-skills attempt ran through
the Apache gateway in 10m 33s, using Java 21.0.13 and Maven 3.10.0. Native run ID:
`eFNhjVy8R2gzarhsjMEp5n`. Artifacts are under
`target/evals/inspect-validation-20261106` and
`/tmp/opencode/sling-inspect-eval-7g_ls1rz`.

ParentUpgrade, SkillUsage, JavaTarget and ScenarioChecks all passed. Independent
verification confirmed 29 Java tests, 39 JavaScript specs, 25 Java-8 class files
and the expected bundle metadata. The coding agent completed in 41 turns.
Reported usage was 1,100,317 coding tokens and 4,135 grading tokens; no HTTP
retries were reported.

The quality judge also returned `pass: true`, but wrapped its JSON in a code
fence. The original parser rejected that format, so the **original native log
retains UpgradeQuality=0 and the command returned nonzero**. The parser now
accepts one complete JSON fence, with unit and native-mock regression coverage.
Replaying the saved response through the corrected scorer offline returned 1;
`offline-quality-replay.json` records that replay separately. The original log
was not rewritten, and the replay made no additional model calls.

### Subsequent full-catalog attempt (reviewed 2026-11-09)

The newer retained log in `target/evals/inspect-full-validation-20261106/`, named
`2026-11-06T16-27-41-00-00_sling-parent-upgrade_WYTs6bUz4pbaSnLpcAzMnZ.eval`,
has evaluation ID `eUr6dBQWawxyJLK3MBDgPV`. Its generated config selects all five
scenarios, both arms, one epoch. The log remains `started`, with seven retained
sample records and no final aggregate results; it is incomplete, not evidence
that the process is still running or that the full batch passed.

| Scenario | With skills | Without skills |
|---|---|---|
| JCR JS nodetypes | All five scorers pass | All five scorers pass |
| discovery-standalone | API connection error; no scores | API connection error; no scores |
| JCR packageinit | All five scorers pass | All five scorers pass |
| JUnit healthcheck | HTTP 429 token-rate limit; no scores | No retained sample |
| discovery-impl | No retained sample | No retained sample |

The four passing samples include actual shared Java-target/build/artifact
verification, not just judge verdicts. JCR JS retained 29 Java tests, 39 Jasmine
specs and major-52 bytecode; packageinit retained six tests and major-52 bytecode.
All four have the expected skill-read behavior: the required skill was read in
skills arms and no skill was read in no-skills arms. These fresh native results
also demonstrate the corrected quality parser, without changing the original
smoke log's score.

Completing the six slots without passing evidence requires follow-up execution
once gateway connectivity and quota permit, with explicit selections and no
automatic paid retries. The cause of the unfinished aggregate log has not been
established. One repetition and two successfully covered projects do not support
a reliability estimate or a causal claim about skill effectiveness.
