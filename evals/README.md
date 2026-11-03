# Parent POM upgrade comparison: CJS and Pi

Run from the repository root:

```sh
make run-evals
# or:
sops exec-env .env 'npx promptfoo@0.125.1 eval --no-cache'
```

Requires Node.js 22.19+, Python 3 (standard library only), Git, Java, Maven,
`LITELLM_API_KEY`, and the locally installed `pi` CLI for the Pi variants.
The Pi integration is tested with **Pi 1.4.0** (`@earendil-works/pi-coding-agent`).
It does not install an SDK or depend on a project-local Node package.
Python parses the actual parent XML for deterministic checks. The version-specific
Maven wrappers documented in the main README are available as optional tools.

Select the backend with `BACKEND=pi|native|all` (`all` is the default):

```sh
make run-evals BACKEND=pi      # Pi-backed variants, with and without skills
make run-evals BACKEND=native  # Native CJS variants, with and without skills
make run-evals BACKEND=all     # All four variants (also: make run-evals)
```

Select the skills arm with `ARM=with-skills|without-skills|both` (`both` is the
default), independently of the backend:

```sh
make run-evals ARM=with-skills                  # Both backends, with skills only
make run-evals ARM=without-skills               # Both backends, without skills only
make run-evals BACKEND=pi ARM=with-skills        # Pi with skills only
make run-evals BACKEND=native ARM=both          # Native CJS, both arms
```

Set `RUNS` to a positive integer to repeat each test for each selected provider/arm
(`1` by default). For example:

```sh
make run-evals BACKEND=pi RUNS=3                 # Three runs per skills arm (six per test)
make run-evals BACKEND=pi ARM=with-skills RUNS=3 # Three runs per test, with skills only
```

This passes `--repeat` to Promptfoo, keeping the individual results in one
evaluation record. Runs remain serial; no retries are added for failures.

`native` means the original CJS tool loop, not Pi's native tools. The default
configuration runs `cjs-with-skills`, `cjs-without-skills`, `pi-with-skills`, and
`pi-without-skills`. Selecting `all` includes them in one evaluation run; builds
remain serial to avoid contention in the shared Maven repository. Invalid backend,
arm, or run-count values fail before invoking Promptfoo.

The equivalent direct Promptfoo commands for a single backend are:

```sh
sops exec-env .env 'npx promptfoo@0.125.1 eval --no-cache --filter-providers "^pi-"'
sops exec-env .env 'npx promptfoo@0.125.1 eval --no-cache --filter-providers "^cjs-"'
```

Change `providers[0].config.model` to select the coding model for **all four**
variants; the others inherit the YAML anchor. The same applies to `apiBaseUrl`,
`temperature`, `maxTokens`, and `chatTemplateKwargs`. Labels are display names, not model selections.
The grading model is configured separately under `defaultTest.options.provider`.

Both backends now explicitly send `temperature: 0` and `max_tokens: 8192` by
default. Earlier CJS runs omitted the output limit; rerun that baseline when
comparing results. `contextWindow: 131072` describes Pi's model metadata; it does
not change the server's context window or add a CJS request parameter. This value
was verified in `llm.apache.org/v1/models` for `qwen3.8-27b`; `qwen3-8b` instead
reports 40,960 input tokens. Set the correct context window when changing models:
the Pi adapter requires an explicit value and does not guess a model's capacity.

The shared `chatTemplateKwargs.enable_thinking: true` is sent as
`chat_template_kwargs: { enable_thinking: true }` by **both** coding backends,
enabling server-side thinking. The parameter was verified against `llm.apache.org`
with `qwen3.8-27b`; setting it to `false` disables reasoning content. Pi's
`--thinking off` and `reasoning: false` metadata remain unchanged: they avoid
Pi-specific reasoning-effort controls, but do not disable server-side thinking.
Review/remove this model-specific setting when switching models or endpoints;
unsupported request parameters are not silently retried without the setting.

Pi can reduce the effective output allowance as context grows, even when
`maxTokens` is shared. Its native compaction is enabled to avoid starving a turn
of output space; the actual request limits are retained in diagnostics. This is
still a harness comparison, not a guarantee of identical effective budgets.

Validate the configuration and run the offline provider/grade tests without any
model calls or real Maven builds:

```sh
npx promptfoo@0.125.1 validate config
node --test evals/*.test.cjs
```

An opt-in integration test invokes the **real installed Pi**, using only a local
OpenAI-compatible streaming mock. No paid model calls or Maven builds are made:

```sh
PI_EVAL_INTEGRATION=1 node --test evals/pi-provider.test.cjs
```

Set `PI_EVAL_COMMAND` to test another Pi executable, or
`PI_EVAL_KEEP_ARTIFACTS=1` to retain the test workspaces for debugging.

## Backends

### CJS tool loop

Promptfoo runs `provider.cjs` directly. It calls the configured model on
`https://llm.apache.org/v1` and feeds tool results back into the conversation.
Tools support project file listing, reading, exact-text replacement, writing,
Maven commands, HTTPS fetches, and skill reads. No external agent, SDK, or MCP
server is involved. Promptfoo's ordinary function callbacks alone do not run a
complete editing loop.

### Pi harness

`pi-provider.cjs` launches `pi --mode json` in the same kind of fresh clone.
**Pi owns the model requests, native tools, and agent loop.** It does not delegate
tools back to `tools.cjs`. The small explicit `pi-eval.ts` extension adds only
evaluation controls: `finish_task`, turn/text-only/repetition limits, and a native bash
wrapper that removes `LITELLM_API_KEY` and `GIT_*` from subprocess environments
and caps command timeouts. File editing, reading, searching, and shell execution
remain Pi's own implementations. HTTP retrieval uses shell tools such as `curl`.
Set `piCommand` in a Pi provider's config to use a different executable path;
the default is `pi` from `PATH`.

Each run gets a private `PI_CODING_AGENT_DIR` with generated `models.json` and
`settings.json`. A custom provider, `apache-evals`, uses the shared Promptfoo
endpoint and model ID via `openai-completions`, with the same temperature and
output limit. The key is referenced as `$LITELLM_API_KEY`: it is not copied into
configuration files or passed on the command line. The selected model, endpoint,
generation settings, and Pi version are recorded in response metadata.

The existing local Pi provider can be selected with
`--provider localllm-apache-llmao --model qwen3.8-27b`, but it is registered by the
`pi-localllm-provider` extension, not built-in configuration. Disabling extension
discovery would remove it unless explicitly loaded. Its saved temperature may
also differ from the CJS adapter. Generating private config avoids dependence on
personal extensions, saved credentials, and model defaults while reusing the
**same endpoint/model/key configuration** supplied to the CJS evaluation.

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

Compaction adds model calls that the CJS history-rewrite approach does not make.
Reported summarization usage is included in Promptfoo's token totals, and
reported reasoning tokens are recorded as a breakdown of output, not added twice.
Compaction events, usage, and recovered attempts are retained in `diagnostics.json`
and response metadata. A length/error attempt successfully recovered through
Pi's native compaction does not fail the whole run; unrecovered failures still do.

## Completion and skill usage

The model must explicitly call `finish_task` with `status: completed` or
`status: blocked` and a truthful summary. A plain-text response such as "Let me
try another approach" is progress narration: the provider asks it to continue,
rather than treating that text as completion. Three consecutive text-only turns
or the 80-turn budget end either backend as `incomplete`. Both also stop
after more than three identical tool calls without edits (`maxToolRepeats`). Pi has a one-hour
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

Within each backend, the two skill variants have identical user prompts, model
settings, and tools:

- **With skills:** installs the complete local `skills/` directory into a private
  skill store. The system message advertises skill names/descriptions; the model
  loads instructions using `read_skill({"name":"update-sling-parent-pom"})` in
  CJS, or Pi's native `read` of the copied `SKILL.md`. Supporting references use
  `read_skill_file` in CJS or `read` in Pi. Skill names are documents, not tool
  functions. Neither backend silently loads a skill after an invalid call.
- **Without skills:** the skill store is empty. No global skills or coding-agent
  configuration are discovered.

For Pi's SkillUsage assertion, only a successful native `read` of the installed
skill's entire `SKILL.md` counts (no `offset`/`limit`). The prompt asks the model
to use that auditable route; shell reads or partial reads are not credited.

Across backends this is a **harness comparison**, not identical conversations:
system prompts, tool schemas, native output truncation, HTTP handling, and
context management differ. Pi's native tools also have broader capabilities
than the CJS tools. Neither backend is an OS sandbox.

Each call clones the current committed state of
`repos/sling-org-apache-sling-discovery-impl/`. The source must have no tracked or
untracked changes; ignored build outputs are not copied. The source checkout is
never reset, cleaned, staged, or edited. Each clone has its remote removed.

Five assertions grade each result:

1. **ParentUpgrade:** parses the baseline and edited `pom.xml`, requires explicit
   task completion and a strictly newer numeric release of `org.apache.sling:sling`
   or `org.apache.sling:sling-bundle-parent`. Unchanged parents, downgrades,
   snapshots, unrelated artifacts, and malformed POMs fail. This check proves a
   version increase, not that it is the latest published release.
2. **SkillUsage:** the skills variant must successfully load
   `update-sling-parent-pom`; the no-skills variant must not load any skill.
3. **JavaTarget:** `java-target.cjs` generates Maven effective POMs for a separate
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
4. **UpgradeQuality:** `gemma4-26b`, through the same LiteLLM endpoint, reviews the actual diff,
   reference-fetch evidence, and final summary for upgrade quality.
   For Pi, this includes bounded shell command results involving URLs or HTTP
   clients, not a guarantee that every URL mentioned by a command was fetched.
   The latest applicable release and appropriate migration fixes are judged here.
5. **MavenVerify:** `maven-verify.cjs` independently executes exactly `mvn clean verify` in the
   edited clone, using the current Java environment. Exit zero is required;
   timeouts, missing workspaces, and command failures do not pass. This does not
   silently substitute `mvn21` or skip tests. If the task is blocked/incomplete
   or the parent-upgrade check fails, Maven is not run and this assertion fails
   with an explicit reason, avoiding an expensive build of an unchanged checkout.

In CJS, to limit wasted tokens, HTTP results (including errors) are reused within a run,
HTML is converted to text with useful links retained, and tool messages are
capped at `toolOutputChars`. After `recentToolTurns`, older verbose tool messages
are replaced with compact excerpts; loaded skill instructions remain available.
This is not LLM-based compaction. Full tool results remain in the transcript on
disk, and the model can reread project files or retrieve a cached URL result.
The grader receives deduplicated, bounded source excerpts instead of repeated
raw HTML. These limits and the loop safeguards are configurable in the provider.
Pi instead uses its native tool-output handling and LLM compaction, without these
CJS caches or history rewrites. Compaction usage contributes to its token totals.

Builds run serially to avoid competing for the local Maven repository. Each
Maven command has a 20-minute timeout, also used as the maximum for Pi shell
commands. Task results retain their edited checkout, tool transcript
(`tool-calls.json`), explicit completion (`completion.json`), patch, summary, and
independent Maven verification log when verification runs. CJS also retains raw model responses
(`model-responses.jsonl`) and Maven tool logs. Pi retains the full event stream
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
