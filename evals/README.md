# Shared evaluation infrastructure

Real-repository scenarios live in [`scenarios.yaml`](scenarios.yaml). The top-level
Makefile selects a provider adapter to generate its native configuration and run
evaluations. Promptfoo, Tessl and Inspect have adapters.

**Tessl hosted validation:** setup and a coding-agent attempt completed, but the
native scorer is blocked before judging (`compute-diff` cannot find Git metadata).
Full catalog/both-arm parity is not yet demonstrated. See the
[validation record](providers/tessl/VALIDATION.md) for demonstrated scope,
remaining limitations and actual credit usage.

## Layout and dependency boundary

```text
evals/
  scenarios.yaml                 # Shared tasks, pins, setup, checks and criteria
  models.json                    # Apache gateway and Promptfoo/Inspect model selection
  options.cjs                    # Common command-line/environment selections
  generate.cjs, run.cjs, view.cjs # Provider-neutral entry points
  shared/                        # Catalog, fixtures, Maven/XML/artifact checks
  providers/
    index.cjs                    # Explicit adapter registry
    promptfoo/
      index.cjs                  # Adapter entry point
      config.yaml                # Pi/client/native framework settings
      generate.cjs, run.cjs       # Native config, CLI and credential handling
      assertions/                # Promptfoo context → plain shared check state
      pi-provider.cjs, pi-eval.ts # Pi client, controls and result conversion
      workspace.cjs              # Pi skill installation and Promptfoo response
      *.test.cjs, README.md       # Adapter-specific tests and documentation
    tessl/
      generate.cjs, config.json  # Native scenarios, checklist and explicit variants
      prepare.cjs, *.sh          # Git bundle packaging and sandbox setup rehearsal
      run.cjs                   # Solve budget, submission ledger, wait and results
      collect.cjs, verify.cjs   # Native scores and separate shared artifact checks
    inspect/
      generate.cjs, run.cjs      # Generated selections, uv and credential handling
      tasks.py, runtime.py       # Native Inspect ReAct agent, tools and scorers
      bridge.cjs                 # Plain JSON → existing shared fixture/check helpers
      pyproject.toml, uv.lock    # Pinned Python runtime dependencies
```

Dependencies flow from **commands → adapter → shared helpers**, never from shared
helpers into an adapter. Tests beside each implementation cover that layer;
`boundaries.test.cjs` guards against provider contexts, credentials and imports
leaking into shared code.

Shared functions accept plain evaluation state (`workingDir`, `runDir`, pinned
repository, prepared `baselineCommit`, completion and scenario), plus an optional
child-process environment. They do not consume Promptfoo response objects. The
shared process helper removes inherited Git context; each adapter is responsible
for removing its own model credentials before launching fixture/build commands.
Shared outcomes contain pass/fail, reasons and check evidence; native scores and
component-result packaging are added only by the provider's assertion adapters.

## Common commands

Requires Node.js 22.19+; install pinned tooling dependencies with `npm ci`.
Runtime tools such as Git, Java 21 and Maven are checked when preparing fixtures.
Provider-specific clients and credentials are described in that adapter's guide.

```sh
npm ci
make list-evals
make generate-eval PROVIDER=promptfoo SCENARIO=jcr-js-nodetypes-parent-34-to-46 ARM=with-skills

# Java 21 must be selected for both java and Maven before running.
export JAVA_HOME=/path/to/jdk-21
export PATH="$JAVA_HOME/bin:$PATH"
make run-eval PROVIDER=promptfoo SCENARIO=jcr-js-nodetypes-parent-34-to-46 ARM=with-skills RUNS=1

make test-evals
make test-inspect # Python suite; requires uv, no gateway calls or real Maven builds
```

`run-eval` regenerates configuration first. Generation is local: no model calls,
fixture cloning, Maven builds or credentials are required. The plural target
names remain aliases. `view-evals` delegates to the selected adapter too.

Common selections:

| Variable | Meaning | Default |
|---|---|---|
| `PROVIDER` | Registered framework adapter | `promptfoo` |
| `SCENARIO` | One ID, comma-separated IDs, or all calibrated scenarios | `all` |
| `ARM` | `with-skills`, `without-skills`, or `both` | `both` |
| `RUNS` | Positive repetition count per task/arm | `1` |
| `EVAL_CONFIG` | Native config file or directory | Adapter default (`target/evals/promptfoo.json` for Promptfoo) |

Unknown providers, duplicate/unknown scenario IDs and invalid selections fail
before execution. Generated files are ignored by Git. Do not edit them or run
an adapter's settings template directly.

## Catalog and fixture semantics

The catalog is the sole source of prompts, immutable source revisions, exact
target parents, fixture setup, bytecode/test/bundle expectations and quality
criteria. Provider settings must not duplicate those scenario facts. Setup and
expected results are harness data, not answers inserted into the coding prompt.

Each run gets a disposable clone at the declared source SHA. Any setup is
checkpointed only in that clone before the task. The source revision and prepared
baseline are recorded separately; diffs and inherited-bytecode checks compare
against the prepared baseline. Original fixture checkouts are never edited,
staged, committed, cleaned or reset.

All five projects are calibrated: the JCR JavaScript bundle plus the four pinned
`repos/` checkouts. See [CALIBRATION.md](CALIBRATION.md) for baseline classifications,
forward targets and exact verified results. Hidden `.sling-*` test workspaces are
not fixtures. Add future inventory under `fixtures` until it has concrete,
verified expectations; never invent runnable targets or test totals.

## Adding a provider

1. Add `providers/<name>/index.cjs` and register it in `providers/index.cjs`.
2. Declare `defaultOutput` and implement `generate({ scenarios, arm, output })`,
   which writes native files and returns `{ output, ... }`. The shared command
   does not impose a file format or single-file layout. Implement `run(options)`
   and `view()` returning exit codes, and optional `validateOptions(env)` for
   provider-only options.
3. Keep client settings, credential loading, native CLI flags, context
   conversion, scoring/rubric translation and provider tests in that directory.
4. Reuse shared fixture/check functions where the framework permits them. Do not
   copy shared task facts into a second maintained suite or assume every native
   scoring system supports executable checks.

Tessl's documented scoring is judge-based; its adapter preserves that
distinction rather than claim executable grading replaces its native score.

Promptfoo and Inspect consume the same gateway, coding/grading model IDs and
coding generation settings from `models.json`. This file contains no credentials.
Pi and Inspect retain their own agent/tool loops and context-management settings;
cross-provider comparisons are not identical-agent experiments. Tessl retains its
separate hosted model selection.

Provider guides: [Promptfoo/Pi](providers/promptfoo/README.md),
[Tessl](providers/tessl/README.md), [Inspect](providers/inspect/README.md).
