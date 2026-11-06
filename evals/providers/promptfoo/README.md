# Promptfoo adapter with pi.dev

Compare the same coding model with and without Agent Skills, using pi.dev for
both arms. Promptfoo runs the evaluations and grades the actual repository edits.

See the [shared infrastructure guide](../../README.md) for the catalog, directory
boundaries, common commands and the adapter interface. All paths in shell examples
below are relative to the repository root.

Requires Node.js 22.19+, Git, Java 21, Maven,
`LITELLM_API_KEY`, and the locally installed `pi` CLI.
The Pi integration is tested with **Pi 1.4.0** (`@earendil-works/pi-coding-agent`).
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
`PROVIDER=promptfoo` is currently the only framework adapter. Tessl and Inspect
are explicitly deferred, not silently mapped to Promptfoo.

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
Pi's own request retries are also disabled. The grading provider is configured
separately and is not affected by this coding-provider setting.

The configuration runs `pi-with-skills` and `pi-without-skills`. Builds remain
serial to avoid contention in the shared Maven repository. Invalid arm or
run-count values fail before invoking Promptfoo. `BACKEND` is no longer supported;
remove it from existing invocations or environment variables to run evaluations.

The equivalent direct Promptfoo command after generation is:

```sh
sops exec-env .env 'npx --yes promptfoo@0.125.1 eval --config target/evals/promptfoo.json --no-cache --repeat 1'
```

In `evals/providers/promptfoo/config.yaml`, change `providers[0].config.model` to select the coding model for **both**
arms; the second provider inherits the YAML anchor. The same applies to `apiBaseUrl`,
`temperature`, `maxTokens`, and `chatTemplateKwargs`. Labels are display names, not model selections.
The grading model is configured separately under `defaultTest.options.provider`.

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

## Shared scenario catalog and provider boundary

`evals/scenarios.yaml` is the sole source of repository URLs/revisions, fixture setup,
task text, exact target parents, bytecode/test/bundle expectations, and quality
criteria. `evals/shared/scenarios.cjs` validates it; this adapter's `generate.cjs` translates it to Promptfoo
without putting setup or expected answers into the coding prompt. The provider
receives scenario data as test context and prepares a fresh baseline with
`evals/shared/fixture.cjs`. `evals/shared/scenario-checks.cjs` independently reads actual build artifacts.

The four existing `repos/` checkouts are recorded as pinned `fixtures` awaiting
calibration. They are listed by `make list-evals`, but are not run or assigned
invented test expectations. In particular, a checkout already on parent 46 or
52 cannot be scored as an upgrade to parent 46. Promote each to a scenario only
after choosing and verifying a forward target and its exact expected outputs.
Hidden `.sling-*` test workspaces under `repos/` are not fixtures.

Adding a provider should reuse these facts, not copy the YAML into a second
hand-maintained test suite. Keep model/client settings in that provider's
template and map shared criteria to its native scoring facilities. Tessl's
documented scoring is judge-based; a future Tessl adapter must not imply native
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

## Pi harness

`pi-provider.cjs` launches `pi --mode json` in a fresh clone.
**Pi owns the model requests, native tools, and agent loop.** The small explicit
`pi-eval.ts` extension adds only evaluation controls: `finish_task`,
turn/text-only/repetition limits, and a native bash
wrapper that removes `LITELLM_API_KEY` and `GIT_*` from subprocess environments
and caps command timeouts. File editing, reading, searching, and shell execution
remain Pi's own implementations. HTTP retrieval uses shell tools such as `curl`.
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
