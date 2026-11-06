# Tessl adapter

This adapter converts the **same calibrated real-repository catalog** as
Promptfoo into Tessl's native `task.md`, `criteria.json`, `scenario.json`, setup
scripts and explicit variants. It does not import the synthetic tasks or root
agent-context changes from `evals/tessl` (`b5edb0f`). That branch's native format
is retained, not its separate scenario facts. Inspect remains deferred.

## Prerequisites and conservative workflow

Install the shared Node dependencies with `npm ci`; select Java 21 for both
`java` and `mvn`. A local Git installation, network access to the pinned public
repositories, an authenticated Tessl CLI and an existing matching Tessl project
are needed. Local archive verification also requires `tar`. `tessl whoami`, `tessl workspace list`,
`tessl project repair --json`, and `tessl eval run --list-agents` are read-only
discovery commands. The adapter does **not** create, relink or repair projects.
Tessl requires Publisher-or-higher workspace access for evaluations.

```sh
make test-evals
make generate-eval PROVIDER=tessl ARM=with-skills SCENARIO=all

# Local clones, native plugin packing, bundle packaging, setup rehearsal and lint.
# No evaluation, scenario generation, feasibility judge or skill review calls.
ARM=with-skills TESSL_MAX_SOLVES=5 node evals/providers/tessl/prepare.cjs

# After checking VALIDATION.md and the local prerequisites:
make run-eval PROVIDER=tessl SCENARIO=all ARM=both RUNS=1 TESSL_MAX_SOLVES=10

make view-evals PROVIDER=tessl
# Or select a known run, rather than a potentially unrelated --last run:
TESSL_RUN_ID=<run-id> make view-evals PROVIDER=tessl
```

The run budget above is an **upper bound of ten solves**, not a credit price quote.
Each solve and its judge consume the workspace's shared credits. Five projects
with both arms and one repetition plan ten solves (`TESSL_MAX_SOLVES=10`). The
CLI quotes platform credits separately from variable AI usage. Use targeted
diagnostic runs to isolate a known setup issue before repeating a whole suite;
do not use unexplained retries as a substitute for inspecting retained results.

### Spending safeguards

- `TESSL_MAX_SOLVES` defaults to **1**. The preflight rejects a larger product of
  scenarios × selected arms × repetitions. Tessl permits 1–10 repetitions.
- Variants are explicit: only `with-skills`, `without-skills`, or both. The
  no-skill variant removes `context`; it is not an implicit extra baseline.
- There is no `--yes`, `--force`, `--quality-check`, retry loop, scenario
  generation, encrypted `.env` loading, or secret forwarding to the sandbox.
  The generated `runtime.env` contains only nonsecret runtime paths; it is passed
  through the native `--env-file` interface so setup and agent shells use the
  same Java environment. The user's `.env` is never read or uploaded.
  This describes adapter behavior: Tessl's internal recipe runner can retry
  setup tasks, and its CLI exposes no switch to disable those internal attempts.
- `--skip-forced-context-activation` is always set by the checked-in config.
  Neither variant sets `agentMustRead`; tasks are identical in both arms.
- `--wait --json` waits for completion. An exit-zero submission/pending response
  is **not** treated as a completed run. Detaching/timing out does not cancel
  server-side work. Inspect the saved run instead of resubmitting it.
- Before submission an exclusive ledger is written under
  `target/evals/tessl/submissions/`. The same catalog/config/skill/arm/repetition
  batch cannot be retried accidentally, even after regeneration. Failures with
  uncertain submission outcomes keep this protection. This is local protection,
  not a remote idempotency guarantee across different output directories or
  changed inputs. Deliberate reruns require inspecting prior results and making
  a separate, explicit spending decision; do not delete the ledger to retry.
- A native `SETUP_FAILED` response also writes `remote-setup-block.json`, which
  blocks changed generations/arms too. Cost-free generation, packing, rehearsal,
  viewing and independent verification remain available. Only after resolving
  the setup issue and obtaining a separate spending decision may an operator use
  `TESSL_RESUME_AFTER_SETUP_REVIEW=1`; the exact-batch duplicate guard still applies.
  Changing the output directory is not a workaround for this safety stop. A
  subsequently completed, explicitly authorized run resolves the stop and keeps
  its original failure record for audit.

## Native configuration and retained evidence

`EVAL_CONFIG` is a directory (default `target/evals/tessl`), not a JSON file.
`manifest.json` points to a new isolated generation containing native scenarios,
frozen skill files, `variants.json`, configuration and input hashes. Old
generations are retained, never deleted or recursively mixed into the next
suite. The runner rejects changed inputs and stale selections.

Each generation has a fresh local Git boundary (no source commits or remotes),
so Tessl's packer does not apply the harness repository's `/target` ignore rule
to the generated inputs. Both preflight commands run **`tessl plugin pack`**
locally before any evaluation call; lint alone does not detect excluded skill
files. Every frozen context file is then hash-checked inside the native archive.
No outer ignore rules are changed. All project skills are frozen and
included, matching Promptfoo's `skills_dir`, including the SCR helper skill.

Generation performs no clones, Maven builds, credential access, or model calls.
It does initialize the isolated local Git boundary and requires Git.
Preparation uses the shared `prepareFixture` implementation in disposable local
clones, creates a **Git bundle of the prepared baseline**, and rehearses the
native include/setup sequence. Only public source history and prepared fixture
changes are bundled. Expected answers, checks and rubrics are not included in
the sandbox's `resources/` directory. Credentials, `.env`, the harness repository
and source working-tree build outputs are not uploaded.

Do not use Tessl's `commit` fixture directly for external repositories: the CLI
packs refs from the **local harness repository**, despite the `repoUrl` field.
The included bundle preserves the original source SHA, prepared baseline SHA
and pre-task history. Setup imports it at the task root, preserves any platform
repository metadata under ignored resources, and refuses repeated setup or Git
pointers/symlinks to another checkout. The task prompt remains byte-for-byte equal
to the shared prompt. Fixture setup is not an agent change.

Tessl runs setup through **POSIX `sh`**, irrespective of its shebang. The sandbox
needs Git, realpath, tar, sha256sum, and its preinstalled Maven. Java 21 is
provided without root: `toolchain.json` pins a Linux/x64 Temurin archive and its
SHA-256. Preparation downloads it once into the local cache, verifies it, and
supplies one shared native directory fixture for the selected scenarios. Setup
verifies it again before extracting it into a writable runtime directory.
There is no sandbox download, apt invocation, sudo requirement or system-directory
write. Maven and JDK tools inherit the generated runtime environment; setup
asserts that both `java` and `mvn` actually run on Java 21.

Setup retains known harness inputs under the ignored, hidden
`.eval-toolchain/runtime/` directory, inside the writable solution. These inputs
do not contaminate RAT/legal-file checks and are excluded from snapshot import.
The local rehearsal uses `sh`; the rootless installer is also exercised in a
non-root, read-only-root container with network disabled. Runtime paths are
provider-specific and versioned in `toolchain.json`; they are not shared scenario
facts. The current JDK pin is Temurin **21.0.13+9**; hosted Maven patch versions
may differ from the local calibration environment.

After preparing a standalone generation, the opt-in container regression checks
the real pinned SDK, an initial Java-25 probe, POSIX command-cache invalidation,
missing setup env variables, a read-only parent workspace and `noexec /tmp`:

```sh
TESSL_ROOTLESS_TEST=1 node --test evals/providers/tessl/rootless.test.cjs
# Optional full offline reference build (POM from the calibrated standalone recipe):
TESSL_ROOTLESS_TEST=1 TESSL_REFERENCE_POM=/path/to/reference/pom.xml \
  node --test evals/providers/tessl/rootless.test.cjs
```

The image defaults to the locally installed `sling-llmao-pi:1.1.0-jdk21-v3`;
override `TESSL_ROOTLESS_IMAGE` to use another existing Linux image with Maven,
Git and POSIX sh. The test never pulls an image or submits an evaluation. It
retains its log and disposable workspace for diagnosis.

See [VALIDATION.md](VALIDATION.md) for actual hosted results, diagnosed setup
failures, credit usage and the scope of demonstrated parity. Passing local
checks alone does not establish remote runtime compatibility or skill effect.

Preparation logs, original pin, prepared baseline and runtime evidence are saved
in `preparation.json` and retained `/tmp/opencode/sling-tessl-fixture-*` clones.
The run record includes CLI version, exact arguments, solve count and generation.
`result.json` retains the native JSON response, and `run.stderr.log` diagnostics.
`EVAL_RESULTS` optionally selects a different native response output path.
Completed runs additionally retain the native view, credit usage, each downloaded
solution, and `verification-report.json`. The adapter independently rebuilds each
solution through the shared checks, preserving original bytecode and exact test
expectations. Native scores and executable outcomes remain separate report fields.
The run exits nonzero for missing/partial native assessments, any failed shared
check, incomplete coverage, or result-collection errors; a completed job alone
does not imply a passing evaluation. Collection errors can be fixed and re-run
locally without submitting another solve or judge.
Each generation retains its own `manifest.json` as well as the latest pointer.

## Parity and limitations

| Concern | Promptfoo | Tessl |
|---|---|---|
| Task, source pin, setup, target, expected artifacts | Shared catalog | Same shared catalog |
| Prepared baseline and original revision | Separate recorded values | Same, preserved in Git bundle |
| Skill arm vs no-skill arm | Explicit Pi configurations | Explicit native variants |
| Available project skill files | All project skills | Same frozen skill files |
| Coding model / harness | Qwen via Pi | DeepSeek V4.1 Flash via Claude harness |
| Native scoring | Executable assertions plus qualitative judge | Weighted checklist judge |
| Independent artifact checks | Shared checks in edited workspace | Same checks after downloading each solution |
| Skill activation | Required successful read metadata | Transcript-based rubric; native activation reporting where available |
| Retries | Disabled | No adapter retry or force flags; local duplicate ledger |

Tessl's supported model list does not include Promptfoo's `qwen3.8-27b`, and
Tessl does not expose Pi's request, temperature, compaction, or context-budget
controls. Both Tessl arms use the **same explicit model** in `config.json`;
the scorer is pinned there too. Do not compare provider scores as a controlled
model experiment or claim numeric equivalence between their scoring systems.
The CLI version is recorded rather than downloaded by the adapter. Development
used 0.118.1/0.119.0 (the installed launcher auto-updated). Native lint in 0.119.0
warns about the docs' `category` field but accepts the checklist; categories are
retained to match the published schema.

Removing `context` removes this project's skills, not Tessl's own platform tools
or native agent instructions. Pi's ambient-skill isolation is not a claimed
guarantee of Tessl's hosted harness.

Each shared executable check becomes one native checklist item. Additional
items cover inherited main/test Java targets, skill usage and every shared
qualitative criterion, all equally weighted. **These are judge scores, not
independent executable passes.** The rubric demands evidence and does not let a
successful summary substitute for a build.

The adapter collects completed-run solutions automatically. These read-only
commands are also available for manual inspection or verification:

```sh
# Recollect a completed run, without submitting another solve or judge:
TESSL_MANIFEST=/path/to/generation/manifest.json RUNS=1 \
  node evals/providers/tessl/collect.cjs

tessl eval list-solutions <run-id> --json
tessl eval download-solutions <run-id> --output target/evals/tessl/solutions

# Point at one FULL extracted repository, not the download's metadata root.
SCENARIO=<scenario-id> TESSL_SOLUTION_DIR=/path/to/full/solution \
  node evals/providers/tessl/verify.cjs
```

Keep native judge results and independently reproduced build outcomes separate.
The verification command reconstructs the prepared baseline, imports the full
solution into a separate disposable clone, independently checks inherited
compiler targets, rebuilds and checks exact artifacts/tests. It never trusts a
downloaded `.git` or stale `target/`. Missing tracked files count as deletions;
patch-only downloads are not full snapshots. Symlinks are refused. Its
`verification.json` explicitly has `nativeScore: null`: completion, activation
and git-action hygiene still require the native result and transcript.
A single repetition validates integration only; it does not establish skill
effect size, reliability, or a with/without comparison when only one arm ran.
