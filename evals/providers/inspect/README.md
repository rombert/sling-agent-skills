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
execution and viewing. Failed scores, execution errors or incomplete slot coverage
produce a nonzero exit. Coverage requires each selected sample/epoch exactly once,
the unchanged scenario identity, all five **named** scorers passing, explicit
completed status and a successful `finish_task` call/result in the native transcript.

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
Runs are serial; coding/grading request retries, refusal retries and caching are
disabled. The runner stops on the first native error rather than submitting more
samples against a broken or rate-limited gateway. Already prepared samples can
retain cancellation records; these are not model defects or completed attempts.
Failed scores alone do not trigger this error stop or any rerun.

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

Each finished invocation also writes a redacted `coverage-<eval-id>.json` beside
its native log, with selected scenario/arm/epoch rows, scores, completion,
transcript coverage, artifact paths, errors and missing/duplicate/unexpected
slots. Native display is disabled to avoid printing upstream error bodies. The
coverage report and adapter `error.json` include only error types/HTTP status;
native `.eval` error tracebacks may still contain sensitive upstream data and
must be reviewed locally before sharing. Inspect's retry counter can include an
initial failed request; local mock tests assert actual HTTP request counts.

Native sample hooks also append and fsync a redacted JSONL journal at sample
start, scoring, completion/error and run end. By default this is a unique
`progress-*.jsonl` in the log directory; `INSPECT_PROGRESS_JOURNAL` selects a new
explicit file. Existing journals are never overwritten. The journal exposes
per-slot progress without waiting for final aggregates or polling the gateway;
native realtime logs and full per-attempt artifacts remain the detailed record.

To inspect an interrupted log **offline**, use the pinned environment's reader
(the system Python's `zipfile` may not support the log's compression):

```sh
target/evals/inspect-venv/bin/python evals/providers/inspect/report.py \
  --config target/evals/inspect-full-validation-20261106.json --runs 1 \
  --log target/evals/inspect-full-validation-20261106/2026-11-06T16-27-41-00-00_sling-parent-upgrade_WYTs6bUz4pbaSnLpcAzMnZ.eval \
  --output target/evals/inspect-interrupted-coverage.json
```

This never resumes, rescores, calls models or rewrites native logs. It returns
nonzero unless the selected slots pass with a successful final native status.
The output file must be new. A `started` log can retain passing sample evidence
but is not a completed evaluation or proof of a running process.

For concurrent provider work, use a distinct writable Maven settings file and
local repository under ignored `target/evals/inspect-*`, not hardlinks to a
shared cache. Export `MAVEN_ARGS="--settings /absolute/private/settings.xml"` and
`MAVEN_OPTS="-Dmaven.repo.local=/absolute/private/repository"` (Maven 3.9+). Both
survive the Python shell and Node checks bridge credential filters. Verify the
effective paths with an offline minimal-POM Maven invocation before live work;
setting an unused environment variable is not isolation.

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

### Six-slot follow-up preparation (2026-11-09)

Only the three remaining scenarios are selected, both arms, one epoch:

```sh
make generate-eval PROVIDER=inspect \
  SCENARIO=discovery-standalone-parent-46-to-52,junit-healthcheck-parent-43-to-46,discovery-impl-parent-52-to-60 \
  ARM=both RUNS=1 EVAL_CONFIG=target/evals/inspect-remediation-20261109.json
```

The four passing JCR slots are deliberately excluded. Offline coverage replay
of the old full attempt reports four passes, three errors and three missing
slots, preserving the original native log and its `started` status. Private
Maven settings/repository preflight confirms Java 21.0.13 and Maven 3.10.0; this
matches the original local calibration runtime, not the hosted Maven 3.9 runtime.
The healthcheck Maven 3.9 timestamp caveat remains documented in
`evals/CALIBRATION.md`, not injected into coding prompts.

Preparation itself made no gateway calls. The parent subsequently authorized
one six-slot attempt, recorded below. No automatic retries, model fallbacks,
quota wait loops or replacement of old error evidence were authorized.

### Authorized six-slot attempt (2026-11-09)

The follow-up ran once with evaluation ID `6heDp2Sr2wDsxVgr2tv6JZ` and run ID
`6nhKDzDbE5wdpEEUWqBgQD`. Its native status is **`error`**, the command exited 1,
and elapsed wall time was **4313.777 seconds (1h 11m 54s)**. Durable artifacts,
isolated Maven cache, per-slot native journal and `final-review.json` are under
`target/evals/inspect-remediation-20261109/`. The native log is
`logs/2026-11-09T18-30-31-00-00_sling-parent-upgrade_geFRxJmShCJvKdv9Utm8WC.eval`.

| Selected scenario/arm | Outcome | Executable checks | SkillUsage | UpgradeQuality | Slot time |
|---|---|---|---|---|---|
| standalone / with skills | PASS | All three pass | 1 | 1 | 13m 30s |
| standalone / without skills | PASS | All three pass | 1 | 1 | 5m 07s |
| healthcheck / with skills | Incomplete | All 0, gated by missing completion | 1 | 0; no judge call | 33m 14s |
| healthcheck / without skills | HTTP 429 error | No scores | No score | No judge call | 19m 59s |
| discovery-impl / with skills | Cancelled by fail-fast | No scores | No score | No judge call | <1s |
| discovery-impl / without skills | Missing; not submitted | No scores | No score | No judge call | — |

Both standalone passes include independent `mvn clean verify`, six tests with
no failures/errors/skips, 13 major-52 class files, unchanged inherited compiler
targets, exact parent coordinates and expected bundle metadata. Both have
explicit native completion transcripts. The healthcheck with-skills agent hit
the consecutive text-only turn limit without `finish_task`; its quality zero
is **not** a negative judge verdict, and completion-gated executable zeros do
not establish an independent build failure. The no-skills healthcheck's HTTP
429 remains a transport/quota error, not a model score failure.

Fail-fast stopped the batch after that error. The cancelled discovery-impl
sample has **zero native model events**; the other arm has no retained sample.
No retries or replacement attempts were submitted. The four old passing JCR
slots were neither rerun nor rewritten. Six of the ten distinct catalog/arm
slots now have passing retained evidence across the old and new attempts; the
other four do not. This still does not establish reliability or skill effects.

Read-only preflight listed both configured models successfully. The quota-info
endpoint was unavailable (HTTP 404), so quota availability was not established
before execution. Runtime remained Java 21.0.13 / Maven 3.10.0, using the
verified private writable Maven settings/cache; catalog expectations and coding
prompts were unchanged. The process exited and no Inspect processes remained
when the gateway slot was released. Remaining execution requires new parent
authorization, not an automatic resume.

After a separate provider exposed a host-skill control problem, retained Inspect
native transcripts and current audited tool calls were also reviewed for
successful outside skill reads, including obvious Bash reads. **No successful
host-skill exposure was observed** in the two historical passing no-skills JCR
samples or either current no-skills sample. With-skills document reads matched
their installed copies. Historical no-skills commands did inspect host Maven
caches; unrestricted Bash and command-pattern auditing are not an OS-sandbox
guarantee. `SkillUsage=1` alone was not used as evidence of no exposure. Audits
are retained separately; historical native logs and scores remain unchanged.

### Discovery-only first-model-solve continuation (2026-11-09)

Read-only inspection confirmed that the earlier cancelled discovery-impl
with-skills sample had zero model events, assistant messages and recorded
tokens; the without-skills slot had no retained sample. The parent authorized
these two genuinely unattempted model solves only, with unchanged scenarios,
models, budgets, assertions and skills. New one-slot configs and private Maven
settings/cache were prepared under
`target/evals/inspect-discovery-continuation-20261109/`, with separate arm logs
and native progress journals. Old cancellation/missing records remain intact.

The clock check at 20:51:11 UTC was past the reported 20:46:06 UTC quota reset.
One authenticated read-only model-list check returned HTTP 200; it did **not**
establish quota headroom. There was no paid probe or repeat quota-info request.

Only **with skills** was submitted. Evaluation ID `Fr9eHgxxeG2zQNevGS4hd3`, run
ID `Ji6aDjntREJPEetZm5Mdsa`, ended in **APIConnectionError**, native status
`error`, command exit 1. Its log is
`with-skills/logs/2026-11-09T20-53-18-00-00_sling-parent-upgrade_hv6itirwuoakgtgkDQV6rB.eval`
under the continuation directory. `with-skills/review.json` and
`combined-review.json` retain the redacted review.

- 63 coding model events: 62 successful and one errored; zero grading events
  and zero explicit retry events. Reported coding usage was 1,842,335 input plus
  22,348 output tokens (1,864,683 total).
- **No native scores** were produced: executable, activation and quality are
  unscored, not zero-valued model failures. The required skill's full read is
  audited, but no SkillUsage score was generated. Independent checks never ran.
- No skip-flag candidates were found in this transcript. The only flagged Bash
  skill-path access was a directory listing inside the advertised per-attempt
  skill copy, not a host skill. A retrospective command audit of both older
  retained batch logs also found no skip-flag candidates. These are bounded
  transcript audits, not universal shell-isolation guarantees.
- The transport-error stop condition prevented the separate **without-skills**
  invocation. It remains unsubmitted, with no first model solve. There was no
  retry, no rescoring, and no healthcheck, JCR or standalone rerun.
- Runtime evidence confirms Java 21.0.13 / Maven 3.10.0. The launcher recorded
  1362.052 seconds monotonic elapsed (22m 42s); recorded UTC timestamps span
  20:53:16.023491 to 21:38:59.660091 (45m 44s). The approximately 23-minute
  discrepancy is unexplained; neither original timing record was rewritten.

Combined distinct-slot evidence remains **six passing**, with **one
incomplete**, **two transport errors**, and **one unsubmitted** slot. A new
native attempt is not a new successful result, nor does the earlier cancellation
become a completed model solve. All historical outcomes remain preserved. The
process exited, no Inspect processes remained, and the gateway was released;
no work is queued for automatic execution.
