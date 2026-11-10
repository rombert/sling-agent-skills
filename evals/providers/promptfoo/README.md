# Promptfoo adapter with pi.dev

Compare the same coding model with and without Agent Skills, using pi.dev for
both arms. Promptfoo runs the evaluations and grades the actual repository edits.

See the [shared infrastructure guide](../../README.md) for the catalog, directory
boundaries, common commands and the adapter interface. All paths in shell examples
below are relative to the repository root.

Requires Node.js 22.19+, Git, Java 21, Maven,
`LITELLM_API_KEY`, and the locally installed `pi` CLI.
The Pi integration is tested with **Pi 1.4.0 and 1.5.0**
(`@earendil-works/pi-coding-agent`); Promptfoo is pinned to **0.125.1**.
Project-local dependencies are pinned `yaml`, `saxes`, and `fflate` (installed
with `npm ci`); no Pi SDK is installed. The graders parse the actual parent and
effective POM XML in JavaScript, respecting XML namespaces and declared encodings.
Malformed XML and DTDs are rejected. The version-specific Maven wrappers documented
in the main README are available as optional tools.

## Generate and run

Run from the repository root. Generation is local: it does not clone fixtures,
run Maven, load credentials, or call a model. Execution needs Java 21 on both
`JAVA_HOME` and `PATH`; an incorrect runtime fails before the model is invoked.

```sh
npm ci
make list-evals
make generate-eval PROVIDER=promptfoo SCENARIO=jcr-js-nodetypes-parent-34-to-46 ARM=with-skills
npx --yes promptfoo@0.125.1 validate config --config target/evals/promptfoo.json

# Smallest real end-to-end smoke: one task, one arm, one repetition.
export JAVA_HOME=/path/to/jdk-21
export PATH="$JAVA_HOME/bin:$PATH"
make run-eval PROVIDER=promptfoo SCENARIO=jcr-js-nodetypes-parent-34-to-46 ARM=with-skills RUNS=1
```

`run-eval` regenerates configuration first. It uses an already exported
`LITELLM_API_KEY`, or loads the encrypted `.env` via `sops exec-env`. The key is
not copied into generated configuration. `run-evals` and `generate-evals` remain
aliases for the singular targets.

`SCENARIO=all` (the default) selects calibrated scenarios only; a comma-separated
list selects specific IDs. Unknown IDs and uncalibrated draft tasks are rejected.
`PROVIDER=promptfoo` selects this Pi-based adapter. Tessl and Inspect have their
own adapters; they are not silently mapped to Promptfoo.

Generated JSON lives at `target/evals/promptfoo.json` (override with
`EVAL_CONFIG`). Native Promptfoo results are retained at
`target/evals/results-<timestamp>.json` (override with `EVAL_RESULTS`). These
paths are ignored by Git. Never run `evals/providers/promptfoo/config.yaml` directly:
it is a provider-settings template, not a second source of tasks.

`REPO` and `PROMPTFOO_REPO` are rejected for generated runs: they would defeat
scenario revision pinning. Repositories come from the scenario catalog. A
`repository.local_path` may point to a clean checkout strictly under `repos/`,
whose origin must match the declared URL. Its pinned revision is cloned without
changing the source HEAD; otherwise the public URL is cloned. Symbolic refs,
dirty local sources, symlink escapes and project subdirectories are rejected.

Select the skills arm with `ARM=with-skills|without-skills|both` (`both` is the
default):

```sh
make run-eval ARM=with-skills     # Pi with skills only
make run-eval ARM=without-skills  # Pi without skills only
make run-eval                    # Both skills arms
```

Set `RUNS` to a positive integer to repeat each test for each selected arm
(`1` by default). For example:

```sh
make run-eval RUNS=3                # Three runs per skills arm (six per test)
make run-eval ARM=with-skills RUNS=3 # Three runs per test, with skills only
```

This passes `--repeat` to Promptfoo, keeping the individual results in one
evaluation record. Runs remain serial. The shared coding-provider setting
`maxRetries: 0` disables Promptfoo's whole-task retries, including on HTTP 429:
a failed coding attempt is recorded rather than restarted in a fresh clone.
Pi's own request retries are also disabled. The grading provider has its own
explicit `maxRetries: 0`; coding-provider settings alone do not disable grading
HTTP retries. Transport/rate-limit errors are execution errors, not evidence that
the model passed or failed the task. Do not automatically resubmit failed slots.

The configuration runs `pi-with-skills` and `pi-without-skills`. Builds remain
serial to avoid contention in the shared Maven repository. Invalid arm or
run-count values fail before invoking Promptfoo. `BACKEND` is no longer supported;
remove it from existing invocations or environment variables to run evaluations.

The equivalent direct Promptfoo command after generation is:

```sh
sops exec-env .env 'npx --yes promptfoo@0.125.1 eval --config target/evals/promptfoo.json --no-cache --repeat 1'
```

In `evals/models.json`, change `coding.model` to select the coding model for **both**
arms and for both Promptfoo and Inspect. The gateway (`apiBaseUrl`), `temperature`,
`maxTokens`, `contextWindow` and `chatTemplateKwargs` are also selected there.
Labels are display names, not model selections. The grading model is selected
separately under `grading.model`. Pi-specific settings stay in this adapter's
`config.yaml`.

Pi explicitly sends `temperature: 0` and `max_tokens: 8192` by default.
`contextWindow: 131072` describes Pi's model metadata; it does not change the
server's context window. This value was verified in `llm.apache.org/v1/models`
for `qwen3.8-27b`; `qwen3-8b` instead
reports 40,960 input tokens. Set the correct context window when changing models:
the Pi adapter requires an explicit value and does not guess a model's capacity.

The shared `chatTemplateKwargs.enable_thinking: true` is sent as
`chat_template_kwargs: { enable_thinking: true }` in model requests,
enabling server-side thinking. The parameter was verified against `llm.apache.org`
with `qwen3.8-27b`; setting it to `false` disables reasoning content. Pi's
`--thinking off` and `reasoning: false` metadata remain unchanged: they avoid
Pi-specific reasoning-effort controls, but do not disable server-side thinking.
Review/remove this model-specific setting when switching models or endpoints;
unsupported request parameters are not silently retried without the setting.

Pi can reduce the effective output allowance as context grows. Its native
compaction is enabled to avoid starving a turn of output space; the actual
request limits are retained in diagnostics.

Validate the configuration and run the offline provider/grade tests without any
model calls or real Maven builds:

```sh
make generate-eval
npx --yes promptfoo@0.125.1 validate config --config target/evals/promptfoo.json
make test-evals
```

An opt-in integration test invokes the **real installed Pi**, using only a local
OpenAI-compatible streaming mock. No paid model calls or Maven builds are made:

```sh
PI_EVAL_INTEGRATION=1 node --test evals/providers/promptfoo/pi-provider.test.cjs
```

Set `PI_EVAL_COMMAND` to test another Pi executable, or
`PI_EVAL_KEEP_ARTIFACTS=1` to retain the test workspaces for debugging.

An additional opt-in native Promptfoo test uses an echo coding provider and a
loopback grading endpoint returning HTTP 503. It verifies that the generated
grading configuration makes exactly one HTTP request, without paid model calls:

```sh
PROMPTFOO_EVAL_INTEGRATION=1 node --test evals/providers/promptfoo/grading-provider.test.cjs
```

When other providers are building concurrently, use a separate writable Maven
repository and settings file. Export `MAVEN_ARGS="--settings /absolute/path/to/settings.xml"`
with that file's `<localRepository>` pointing to the private cache; both Pi's
shell tools and the independent checks inherit it. Do not hardlink a mutable
cache to `~/.m2`. Keep the catalog's `mvn clean verify` command unchanged. Use
explicit, unique `EVAL_CONFIG`, `EVAL_RESULTS`, and `PROMPTFOO_WORKSPACE_ROOT`
paths for each live batch so retained evidence is not overwritten.

## Shared scenario catalog and provider boundary

`evals/scenarios.yaml` is the sole source of repository URLs/revisions, fixture setup,
task text, exact target parents, bytecode/test/bundle expectations, and quality
criteria. `evals/shared/scenarios.cjs` validates it; this adapter's `generate.cjs` translates it to Promptfoo
without putting setup or expected answers into the coding prompt. The provider
receives scenario data as test context and prepares a fresh baseline with
`evals/shared/fixture.cjs`. `evals/shared/scenario-checks.cjs` independently reads actual build artifacts.

All five projects now have calibrated scenarios, including the four pinned
`repos/` checkouts. See [calibration evidence](../../CALIBRATION.md) for forward
targets, baseline classifications, and exact outputs. In particular, checkouts
already on 46 or 52 have genuine forward upgrades, not tasks targeting 46.
Hidden `.sling-*` test workspaces under `repos/` are not fixtures.

Adding a provider should reuse these facts, not copy the YAML into a second
hand-maintained test suite. Keep model/client settings in that provider's
template and map shared criteria to its native scoring facilities. Tessl's
documented scoring is judge-based; the Tessl adapter does not imply native
executable grading support that the framework does not provide.

### Import and smoke-test provenance

The Promptfoo harness was imported by cherry-picking the evaluation commits from
`evals/promptfoo`. Skill-only commits `87e3d9b`, `84ac630`, and `99c033d` were not
imported; the explicit-parent-version skill change was already on `master`.
Mixed commit `db21585` was imported intact, including its timestamp guidance, so
that skill adjustment can be separated later without obscuring import history.

On 2026-11-06 the generated JCR parent-34-to-46 configuration passed a real
Promptfoo smoke evaluation (`eval-FaI-2026-11-06T13:38:29`): one with-skills task,
one repetition, no retries, all five native assertions passing. Independent
verification confirmed 29 Java tests, 39 JavaScript specs, Java 8 bytecode and
the expected bundle metadata. Duration was 6m 34s; usage was 513,190 tokens
including the single rubric grading call. This is a functional integration
smoke test, not a with/without-skills benchmark or a reliability estimate.

### Interrupted five-project matrix: 2026-11-09

Evaluation `eval-nUr-2026-11-09T16:10:38` was stopped at the user's request.
Its aggregate JSON was not exported. A read-only SQLite recovery of this exact
evaluation recovered seven persisted native result rows; retained Pi events
confirm the eighth attempt was cancelled, not completed. No recovery model calls,
judges, builds, rescoring, or retries were performed.

| Scenario | With skills | Without skills | Independent executable evidence |
| --- | --- | --- | --- |
| JCR JS nodetypes 34→46 | Native 5/5 PASS; parent skill read | Output-limit ERROR, turn 13; no assertions | With: 29 Java + 39 Jasmine tests; 25 major-52 classes; bundle PASS. Without: not checked. |
| Discovery standalone 46→52 | Native 5/5 PASS; parent skill read | Native 5/5 PASS; no observed skill read | Both: 6 tests; 13 major-52 classes; bundle PASS. |
| JCR packageinit 52→60 | Native 5/5 PASS; parent skill read | Native 5/5 PASS, but **contaminated** by a host skill read | Both: 6 tests; 4 major-52 classes; bundle PASS. |
| JUnit healthcheck 43→46 | Native 5/5 PASS; parent and SCR skills read | **Cancelled** after 37 complete model turns; host skills read | With: 3 tests; 6 major-52 classes; bundle PASS. Without: not independently checked. |
| Discovery impl 52→60 | Unattempted | Unattempted | None from this evaluation. |

Here “5/5” means all five persisted native assertions passed, including the
separate qualitative judge; it is not inferred from a successful build. All six
executable passes also have retained before/after effective-POM comparisons
confirming **main and test targets both stayed Java 8**, plus exact parent,
nonempty class sets, predetermined test totals and bundle checks. Historical
native scores remain unchanged. The packageinit no-skills PASS is **not valid
clean no-skills benchmark evidence**: it read the parent skill from the host's
Copilot cache. The cancelled healthcheck no-skills attempt read the parent and
SCR skills from the host checkout. Discovery suppression is not filesystem
isolation.

The provider now records successful **uninstalled** native `SKILL.md` reads,
including partial reads, and fails SkillUsage for contamination in either arm.
Previously it tracked only installed private skill paths and missed these reads.
Continuation also uses the separately versioned native file boundary documented
below; it does not retroactively change these scores. Neither control is an OS
sandbox: arbitrary shell reads are not comprehensively detected. Strong host
filesystem isolation remains a prerequisite for claiming an uncontaminated
comparative benchmark.

The JCR no-skills error was an unrecovered `length` response with 8,192 output
tokens (8,010 reasoning tokens), effective `max_tokens=8192`, and only about
27,716/131,072 context tokens. It was not context starvation, an HTTP/auth error,
or a grading failure. Explicit grading `maxRetries: 0` was already present in
this matrix and does not remedy output truncation. No automatic rerun is planned.

Actual runtimes were Node 24.22.1, Pi 1.5.0, Promptfoo 0.125.1, Maven 3.10.0,
and Java 21.0.13. Coding used `qwen3.8-27b`, temperature 0, max output 8,192,
context metadata 131,072, server-side thinking enabled; the six qualitative
judges used `gemma4-26b`, all through `https://llm.apache.org/v1`.
Persisted coding usage was 5,545,202 tokens and judging usage 56,381. The
cancelled attempt adds at least 1,424,405 reported tokens from complete messages;
its interrupted final stream is not included in that lower bound.

Ignored recovery artifacts under `target/evals/`:

- `promptfoo-full-validation-20261109.config.json`, `.log`, and `-workspaces/`:
  original retained evidence, not overwritten by recovery.
- `promptfoo-full-validation-20261109.native-rows.recovered.json`: seven persisted
  native rows from a read-only/query-only SQLite transaction, with sensitive
  headers redacted. This is not a completed native aggregate export.
- `promptfoo-full-validation-20261109.recovered-audited.json`: ten-slot inventory,
  exact eval/result/attempt identities, source and prepared-baseline SHAs,
  frozen scenarios, assertion outcomes, executable checks, activation evidence,
  usage, hashes and continuation provenance.
- `promptfoo-native-boundary-v1-readiness-20261109.json`: separate continuation
  harness-control version, source/config hashes, native API evidence, offline
  regression results, immutable-evidence verification and explicit limitations.
- `promptfoo-native-boundary-v1-four-slots-readiness-20261109.json`: subsequent
  authorization snapshot adding **exactly one** replacement control attempt,
  for **four total prepared slots** under `native-file-boundary-v1`. The earlier
  readiness snapshot and all 85 previously hashed evidence/config/skill files
  remain unchanged. Live gateway authorization is still required.
- `promptfoo-continuation-20261109-healthcheck-without-skills.config.json`: only
  the cancelled slot, as a new attempt; no session resume or retry-cache reuse.
- `promptfoo-continuation-20261109-discovery-impl-both.config.json`: only the two
  unattempted slots. Its with-skills provider references the retained original
  skill copy; both continuation configs otherwise retain original task objects,
  prompts, model settings and rubrics unchanged.
- `promptfoo-continuation-20261109-packageinit-without-skills-replacement-attempt2.config.json`:
  the user's explicitly approved **one additional** packageinit no-skills control,
  `RUNS=1`, separately labelled attempt 2. It preserves the original scenario,
  assertions, model and provider budgets; only the subset and non-prompt evaluation
  description differ. Its unique `.results.json` and `/tmp/opencode/` workspace
  paths are recorded in the four-slot readiness manifest. The original
  contaminated attempt's native score and evidence remain preserved; a new
  attempt is not automatically a clean control, especially with unrestricted Bash.

The three continuation configs validate offline, but **live continuation remains
gated on explicit parent authorization**. Do not regenerate them with
`make run-eval`, which would replace their targeted configuration. Use the
existing `node evals/run.cjs` launcher with explicit `EVAL_CONFIG`, unique
`EVAL_RESULTS`, the matching `SCENARIO`/`ARM`, `RUNS=1`, Java 21 and the private
Maven settings. The four selected slots are cancelled healthcheck no-skills
attempt 2, both unattempted discovery-impl arms, and the separately approved
packageinit no-skills replacement attempt 2. The original contaminated packageinit
result is not overwritten or silently resubmitted. The legitimate JCR no-skills
output-limit error remains excluded, with no rerun authorized. No Promptfoo live
execution is authorized until the parent explicitly releases the gateway from
Inspect and grants it to this provider.

After Inspect released the gateway, the parent conditionally granted these four
attempts, subject to quota readiness. **No attempt was submitted:** the retained
Inspect HTTP 429 reported a 500,000-token limit, 40,279 remaining and reset at
2026-11-09 19:43:21 UTC. That reset had elapsed, but the authenticated read-only
model listing supplied no current quota figures. HTTP 200 on that endpoint is
not proof of available generation quota. The already-unavailable quota-info
endpoint was not repeated, and no paid probe was made. The durable outcome is
`target/evals/promptfoo-continuation-quota-blocked-20261109.json`: all four slots
remain unsubmitted, the gateway is released, and nothing is queued for automatic
resume. The original 85 hashed files were reverified unchanged.

### Authorized packageinit replacement control: completed

After parent quota review explicitly allowed **one** real attempt despite the
absence of current quota figures, packageinit without skills **attempt 2** ran
under `native-file-boundary-v1`: `eval-fJl-2026-11-09T19:51:24`, native result
`d6f452b1-bb8d-45bc-bc63-c2754000d615`. It completed in **290.899 seconds** with
all five native assertions passing (score 1), including the qualitative judge.
Independent verification confirmed `mvn clean verify`, exact parent 60, all six
tests with zero failures/errors/skips, four major-52 class files, expected bundle
metadata, and preserved effective Java 8 main/test targets.

No skills were installed or loaded; the native boundary had no skill roots and
recorded zero denials. No successful uninstalled native skill read or obvious
Bash host-skill read was observed. Bash commands read project files, Maven
artifacts and downloaded public POMs, not host skill documents. This is observed
activation evidence, **not an OS-sandbox or universal clean-control guarantee**.
The original contaminated attempt and its native score remain unchanged.

The run used the same `qwen3.8-27b` generation settings, Pi 1.5.0, Promptfoo
0.125.1, Java 21.0.13, Maven 3.10.0 and private Promptfoo Maven repository.
Coding used **518,919 tokens** across 23 reported model calls; the single
`gemma4-26b` judge used **11,498 tokens** (530,417 total). No retries, other
continuation slots or historical rescoring were submitted.

Native results and final review are retained under
`target/evals/promptfoo-continuation-20261109-packageinit-without-skills-replacement-attempt2`
with `.results.json`, `.final-review.json`, `.log`, `.progress.jsonl` and execution
start/finish records. The workspace is
`/tmp/opencode/promptfoo-continuation-20261109-packageinit-without-skills-replacement-attempt2-workspaces/sling-skill-eval-2A1IAb`.
All 85 prior hashed files were reverified unchanged. At that point the gateway
was released and the other three prepared slots remained gated for parent
review. JCR's original output-limit error remains excluded.

### Separately authorized three-slot continuation: completed

The parent subsequently authorized discovery impl with skills, discovery impl
without skills, and healthcheck without skills, in that order. Each used a
**separate one-slot native CLI invocation**, with immutable selected scenario
objects, generation settings, budgets and rubrics under `native-file-boundary-v1`.
No retries or historical rescoring were submitted.

| Slot | Native outcome | Elapsed | Coding / judging tokens |
| --- | --- | --- | --- |
| Discovery impl with skills, attempt 1 | All five assertions PASS | 775.796 s | 215,430 / 20,745 |
| Discovery impl without skills, attempt 1 | All five assertions PASS; auxiliary skip-flag caveat below | 722.390 s | 746,770 / 21,204 |
| Healthcheck without skills, attempt 2 | HTTP 429 ERROR; no assertions or independent checks ran | 1,194.045 s | 3,948,302 / 0 |

Both discovery slots independently passed `mvn clean verify`, exact parent 60,
all **45** expected tests with zero failures/errors/skips, **49 major-55** class
files, expected bundle metadata, and preserved effective **Java 11 main/test**
targets. With skills loaded the declared parent skill and read references only
from its private copy. Neither no-skills slot showed a successful native skill
read or an obvious Bash host-skill read in the available transcript. All three
recorded zero native boundary denials. Bash remains unrestricted; these are
observations, not a filesystem-isolation or universal clean-control guarantee.

**Protocol caveat:** discovery impl without skills used `-DskipTests` while
building a copied parent-52 comparison project at `/tmp/ab52` for manifest
comparison. The final edited project was independently verified without skip
flags, with all 45 expected tests passing. Its native five scores remain
unchanged, but this auxiliary use conflicts with the blanket no-skip-flags
instruction: do not claim perfect protocol compliance or hide it behind the
native qualitative PASS. Per-slot `.protocol-review.json` records retain this
evidence. The other three new attempts had no explicit Maven skip flags observed.

A subsequent **offline provenance review** recovered the actual retained
UpgradeQuality `metadata.renderedGradingPrompt` for discovery without skills
(SHA-256 `9022ba2f497c6eaaa2ccf27b5a23a0c044804d61aad06f2a28fee4d063b29a8e`).
Neither `-DskipTests` nor `/tmp/ab52` occurs in those retained judge messages.
The decoded output contains six source records and seven Git-action records;
the comparison commands at tool indices 26 and 27 qualified for neither channel.
This is an **adapter evidence-routing omission**, not proof that the judge
overlooked fully supplied command evidence. It does not establish what a judge
would decide with a different input. Original grades and inputs remain unchanged.

For **future inputs only**, `commandEvidence.version=bounded-command-evidence-v1`
adds at most eight deduplicated Bash records, prioritizing check-option mentions,
Git mutation mentions, copy/worktree commands and Maven commands, with recent
records first within each priority. It reserves a 16,000-character combined
command/serialized-result text budget alongside the unchanged actual diff,
source and Git evidence. Selection inspects command inputs, not fetched tool
output. Records are explicitly untrusted; echoed/quoted mentions are not proof
of execution, and no regex match produces a pass/fail verdict. No rubric,
assertion count, expected result or model budget changed, and no retrospective
judge call or evaluation was made. Existing live-run receipts retain their
original source hashes; this future evidence transformation has its own version.

Healthcheck's error occurred on reported model call 72: HTTP **429**, token limit
**500,000**, remaining **0**, reported reset **2026-11-09 20:46:06 UTC**. The final
failed call reported zero usage. It did not record completion; the native zero
is an execution error, **not a negative model-quality judgment**. No retry,
wait-for-reset continuation, paid probe or other submission followed. The
credential-safe `.transport-review.json` retains numeric diagnostics without
repeating the upstream error body.

Native evaluation/result identities:

- Discovery with: `eval-Og6-2026-11-09T19:59:54` /
  `6022a571-62d0-4392-8f57-530a6b326b7c`.
- Discovery without: `eval-4Gk-2026-11-09T20:13:03` /
  `61f762d5-eef3-478e-a5c1-130c06e67735`.
- Healthcheck without: `eval-Hwp-2026-11-09T20:25:16` /
  `e1aa7900-c85c-457a-8167-38113a820008`.

`target/evals/promptfoo-continuation-consolidated-20261109.json` combines these
three outcomes with the separate packageinit replacement: **four new attempts,
three native passes, one transport error**, with 5,429,421 reported coding tokens
and 53,447 judging tokens (5,482,868 total). Per-slot configs, `.results.json`,
`.final-review.json`, `.protocol-review.json`, logs and progress/execution records
use the prefixes `promptfoo-continuation-20261109-discovery-impl-with-skills-attempt1`,
`...-discovery-impl-without-skills-attempt1`, and
`...-healthcheck-without-skills-attempt2` under `target/evals/`. Workspaces remain
under their corresponding `/tmp/opencode/<prefix>-workspaces/` directories.

The effective ten-distinct-slot inventory now contains **eight native PASS
slots and two ERROR gaps**: original JCR no-skills output truncation and the new
healthcheck no-skills HTTP 429. This includes the disclosed discovery protocol
caveat and is a **mixed original/new-harness series**, not one identical-harness
causal skills benchmark. The original contaminated packageinit control is still
preserved and excluded as a clean control. All 85 prior hashed files and seven
historical native scores were reverified unchanged. All four newly authorized
attempts have terminated; **the gateway is released and nothing is queued**.

## Pi harness

`pi-provider.cjs` launches `pi --mode json` in a fresh clone.
**Pi owns the model requests, native tools, and agent loop.** The small explicit
`pi-eval.ts` extension adds only evaluation controls: `finish_task`,
turn/text-only/repetition limits, and a native bash
wrapper that removes `LITELLM_API_KEY` and `GIT_*` from subprocess environments
and caps command timeouts. A native `tool_call` preflight hook enforces file-tool
path boundaries. File editing, reading, searching, and shell execution remain
Pi's own implementations. HTTP retrieval uses shell tools such as `curl`.
Set `piCommand` in the provider config to use a different executable path;
the default is `pi` from `PATH`.

Each run gets a private `PI_CODING_AGENT_DIR` with generated `models.json` and
`settings.json`. A custom provider, `apache-evals`, uses the endpoint, model ID,
temperature, and output limit from the evaluation config via `openai-completions`.
The key is referenced as `$LITELLM_API_KEY`: it is not copied into configuration
files or passed on the command line. The selected model, endpoint,
generation settings, and Pi version are recorded in response metadata.

Generating private config avoids dependence on personal extensions, saved
credentials, and model defaults, keeping both skills arms reproducible.

Ambient extensions, MCP servers, skills, prompt templates, themes, project
configuration, and AGENTS/CLAUDE context-file discovery are disabled. The only
loaded extension is `pi-eval.ts`; skills are explicitly supplied only in the
with-skills variant. Sessions are not resumed or saved. Startup networking,
telemetry, cache warming, and transient-error retries are disabled. Native
compaction is enabled, including Pi's bounded compact-and-retry recovery for
context-clamped responses.

### Native file boundary: `native-file-boundary-v1`

This new continuation control uses Pi's supported **pre-execution `tool_call`
hook**, verified against the installed **Pi 1.5.0** documentation and native
tools. It blocks calls or mutates `event.input.path` to the checked canonical
path. It does not replace Pi's file tools or agent loop. The same policy applies
in both arms:

- `read`, `grep`, `find`, `ls`: only the disposable project and each explicitly
  copied skill directory are readable/searchable. No-skills has no skill roots.
  Other host locations, including the Copilot cache, checkout skills, other
  attempts, private Pi configuration and Maven cache, are denied to these tools.
- `edit`, `write`: only project files are writable. Copied skills and the
  project's `.git` metadata are read-only to native file tools.
- Existing symlinks are resolved before checking the boundary. Missing write
  targets are checked through their existing ancestors; dangling symlinks and
  escapes are denied. Reads must resolve to an existing allowed target; Pi's
  alternate-filename fallback is not used to bypass the check. Ordinary relative,
  absolute, `@`, `~` and `file://` spellings are checked and canonicalized.
- Denied calls return an error before content is read or a write executes. A
  blocked host-skill read is not credited as successful skill exposure. The
  post-hoc fail-closed audit remains in place for successful uninstalled reads.

The provider records the configured version/roots in `pi-agent/eval.json` and
response `metadata.harnessControls.nativeFileBoundary`. The extension emits an
`eval-controls` acknowledgement before the first normal provider request;
`diagnostics.controls` retains the initialized policy. Denials are retained as
`eval-file-boundary` events and `diagnostics.fileBoundaryDenials`; approved
canonical paths are retained as `eval-file-access` events. The common system
instructions explain the new boundary and prohibit using Bash to circumvent it.
Original scenario prompts, generation settings and rubrics are unchanged. Report
continuation under this **new harness-control version**, not as identical to the
interrupted original harness.

**This is not OS/filesystem isolation.** Bash remains unrestricted, can read or
modify host files and skills, and can race or bypass path preflight checks.
Hardlinks and concurrent filesystem manipulation are not security-contained.
Full shell command/results remain in the transcript, but no general shell-read
detector or absence-of-contamination guarantee is claimed. Native boundary
success must not be presented as a sandboxed comparative benchmark.

Offline native-Pi tests replay the observed Copilot-cache and checkout skill
paths in both arms, plus an existing synthetic host skill with a sentinel. They
verify boundary errors and that sentinel content never reaches the next model
request, while normal project tools and declared copied-skill reads work and
skill/Git-metadata writes do not. Helper tests cover canonicalization, traversal,
prefix lookalikes, symlink escapes, dangling links and new write paths.

### Pi context management

`piCompaction` controls Pi's native LLM summarization. The configured 131,072-token
context uses `reserveTokens: 16384` and `keepRecentTokens: 20000`: compaction starts
when estimated context exceeds 114,688 tokens, well before Pi's 4,096-token safety
margin would squeeze the next output allowance down to one token. Recent context
is retained alongside a generated summary; the full raw transcript stays on disk.
Without explicit compaction budgets, the adapter uses `maxTokens + 8192` for the
reserve and Pi's normal 20,000-token recent-history budget. Smaller contexts may
need an explicitly smaller recent-history budget.

When enabled, the reserve must be at least `maxTokens + 4096`, less than the
context window, and the recent-token budget must fit below the compaction
threshold. Set `piCompaction.enabled: false` only when intentionally testing
without compaction; increasing `maxTokens` alone does not fix context starvation.

Compaction adds model calls. Reported summarization usage is included in
Promptfoo's token totals, and reported reasoning tokens are recorded as a
breakdown of output, not added twice.
Compaction events, usage, and recovered attempts are retained in `diagnostics.json`
and response metadata. A length/error attempt successfully recovered through
Pi's native compaction does not fail the whole run; unrecovered failures still do.

## Completion and skill usage

The model must explicitly call `finish_task` with `status: completed` or
`status: blocked` and a truthful summary. A plain-text response such as "Let me
try another approach" is progress narration: the provider asks it to continue,
rather than treating that text as completion. Three consecutive text-only turns
or the 80-turn budget end the task as `incomplete`. Pi also stops
after more than three identical tool calls without edits (`maxToolRepeats`). It has a one-hour
wall-clock limit (`piTimeoutMs`); expiration is `incomplete`. External cancellation
and API/transport failures remain errors. Blocked/incomplete tasks are failed
assertions, not successful evaluations.

Repetition keys normalize JSON object-key order and count across alternating
cycles, not just consecutive calls. Pi blocks the fourth identical call before
execution, records `eval-stall` in the event stream, and ends the task as
`incomplete` with a stalled-loop reason. Counts survive native compaction.
Successful native `edit`/`write` calls reset counts, as do actual project changes
made by shell commands (including formatter changes and new untracked files).
Ignored build outputs and downloads outside the project do not reset them.
This is a no-progress safeguard, not a guarantee that a model completes the task.

The adapter checks Pi's terminal events and model stop reasons, not just its exit
code: JSON mode can exit zero after a model error. A deliberate abort at the
completion boundary is distinguished from external cancellation. Pi 1.4 can emit
an empty, zero-usage cancellation tail after that boundary; this is not counted
as another model request.

Unrecovered model errors include the turn, input/output/reasoning usage,
configured output limit, effective request limit and context estimate when
available, and the artifact directory. `error.json` retains the error and usage;
`diagnostics.json` records per-turn usage, effective normal-turn request limits,
and compaction outcomes. Summarization requests are tracked through compaction
events because Pi does not expose them through the normal-turn request hook.

The two skills arms have identical user prompts, model settings, and tools:

- **With skills:** installs the complete local `skills/` directory into a private
  skill store. Pi advertises skill names/descriptions; the model loads
  instructions with its native `read` of the copied `SKILL.md` and supporting
  references. Skill names are documents, not tool functions.
- **Without skills:** the skill store is empty. No global skills or coding-agent
  configuration are discovered.

For the SkillUsage assertion, only a successful native `read` of the installed
skill's entire `SKILL.md` counts (no `offset`/`limit`). The prompt asks the model
to use that auditable route; shell reads or partial reads are not credited.
Successful native reads of an uninstalled host `SKILL.md`, even partial reads,
are retained separately as contamination and fail SkillUsage in either arm.

## Workspaces and grading

Each call clones the exact scenario revision, applies any declared fixture setup,
and removes the remote. Setup is checkpointed **only in the disposable clone**
before the agent starts. `repository.revision` is always the original pinned
source SHA; `baselineCommit` is the prepared baseline and can differ when setup
was needed. `repository.json`, `scenario.json`, setup patches and
`environment.json` retain the provenance and exact Java/Maven versions. The
agent's diff and the inherited-bytecode comparison exclude fixture preparation.
The original checkout is never staged, committed, reset, cleaned or edited.

Five assertions grade each result:

1. **ParentUpgrade:** parses the baseline and edited `pom.xml`, requires explicit
   task completion and a strictly newer numeric release of `org.apache.sling:sling`
   or `org.apache.sling:sling-bundle-parent`. Unchanged parents, downgrades,
   snapshots, unrelated artifacts, malformed POMs and a newer-but-wrong release
   fail. The final coordinates must exactly match the scenario's parent check.
2. **SkillUsage:** the skills variant must successfully load
   `update-sling-parent-pom`; the no-skills variant must not load any skill.
3. **JavaTarget:** `assertions/java-target.cjs` delegates to the shared Java target
   check, which generates Maven effective POMs for a separate
   pristine clone at `baselineCommit` and the edited workspace, using the same
   current Java/Maven environment. It compares resolved main/test compiler
   bytecode targets, including inherited properties and execution overrides.
   `release` takes precedence over legacy `target`; `1.8` and `8` are equivalent.
   Raising **or lowering** the original target fails, even if a build succeeds.
   A higher JDK required to run Maven/Bnd does not justify raising the bytecode
   target. Unknown/unresolved targets, unsupported custom target arguments, or
   effective-POM failures fail closed instead of guessing from the build JDK.
   This checks currently active profiles, not every possible profile/JDK matrix.
   Both effective POMs, Maven logs, and a structured comparison remain under
   `java-target-*` in the run directory. These two model-resolution commands add
   grading time but do not run a full build or make LLM calls.
4. **ScenarioChecks:** independently executes exactly `mvn clean verify` in the
   edited clone and evaluates the scenario's exact bytecode, test-report and
   bundle-manifest expectations. Empty class sets, missing reports, changed test
   totals and mismatched bundle headers fail closed. Results remain in
   `scenario-checks.json`; full build output is in `maven-verify.log`.
   Blocked/incomplete tasks and invalid parent upgrades fail without running
   Maven. This does not substitute a different JVM, add skip flags, or treat a
   model's claimed build success as evidence.
5. **UpgradeQuality:** `gemma4-26b`, through the same LiteLLM endpoint, reviews the actual diff,
   reference-fetch evidence, and final summary for upgrade quality.
   This includes bounded shell command results involving URLs or HTTP
   clients, not a guarantee that every URL mentioned by a command was fetched.
   The rubric is generated from the scenario's criteria and exact requested
   parent, not a generic "latest release" instruction. All criteria are combined
   in one native rubric to avoid multiple judging calls per run.

The assertion files in `assertions/` are the only layer translating Promptfoo's
`context.providerResponse.metadata` into shared check arguments. Shared code takes
plain evaluation state and has no Promptfoo API or credential dependency.
`environment.cjs` removes this adapter's model credential before the shared
fixture and verification helpers launch Maven or Git.

Pi manages tool-output truncation and context compaction. The grader receives
deduplicated, bounded shell evidence; full tool results remain in the run artifacts.

## Artifacts and isolation limits

Builds run serially to avoid competing for the local Maven repository. Each
Maven command has a 20-minute timeout, also used as the maximum for Pi shell
commands. Task results retain their edited checkout, tool transcript
(`tool-calls.json`), explicit completion (`completion.json`), patch, summary, and
independent Maven verification log when verification runs. Pi retains the full event stream
(`pi-events.jsonl`), stderr (`pi-stderr.log`), structured diagnostics
(`diagnostics.json`), and private generated config. Failures also retain
`error.json` with the error and accumulated usage.
Transport failures retain the workspace and available raw logs, but may not have
completion/diff artifacts. Artifacts are stored under
`/tmp/opencode/sling-skill-eval-*` (or `$PROMPTFOO_WORKSPACE_ROOT`). The location
is included in response metadata. Nothing is cached by the custom provider;
`--no-cache` also keeps grader results fresh.

The temporary path name does not imply an OpenCode dependency. These are local
workspace copies, **not an OS sandbox**: Maven executes project/plugin code and
HTTPS requests use the host network. Use disposable containers for untrusted
projects. Run artifacts may contain source code or fetched data; inspect them
before sharing. Pi's unrestricted shell/file tools can access the host, including
personal configuration if explicitly requested; disabling discovery is not
filesystem isolation. Credential removal from child environments is not a
security boundary against malicious project code.
