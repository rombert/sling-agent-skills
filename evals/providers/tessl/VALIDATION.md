# Validation record — 2026-11-06

## Outcome: hosted validation in progress

The provider, native conversion and five-project catalog are implemented and
locally verified. Hosted setup failures have been diagnosed and reproduced;
a corrected scored standalone run is in progress. Full catalog/both-arm parity
is not yet demonstrated. Native judge scores and independent executable checks
are always separate evidence, not interchangeable grading systems.

## Troubleshooting and credit record

The user authorized targeted diagnostics and full validation within an
approximately 6,000-credit budget. Charges below are actual `eval view` values,
not platform quotes. No automatic adapter retries or rescoring were used.

| Run ID | Purpose | Result | Charged credits |
|---|---|---|---:|
| `01a1b149-31fb-733b-a2a1-bddf4944d63a` | Five-project skills arm | Setup failed before models | 50 |
| `01a1b154-b21d-7422-a4e0-e5abfd9ec5b2` | Unscored setup diagnostic | Completed; exposed shell/sudo assumptions | 10.5922648 |
| `01a1b15e-a6a2-70ec-ae60-9ea2c42df437` | Rootless standalone attempt | Setup failed before model | 10 |
| `01a1b163-447f-7787-a081-22374d3a711e` | Unscored rootless diagnostic | Completed; exposed cached Java path | 11.946124 |

Confirmed subtotal before the corrected scored run: **82.5383888 credits**.
Local CLI validation rejections created no remote run and are not extra charges.

Actual hosted diagnostic logs confirm:

- Setup executes through POSIX `sh`, as `uid=1001(agent)` on Ubuntu 26.04.
- The preinstalled runtime is Java 25.0.4.1 and Maven 3.9.12; passwordless sudo
  is unavailable. Bash syntax and apt/root provisioning were unsuitable.
- `--env-file` variables are present during setup. `/workspace` is writable in
  this image; the current runtime nevertheless stays in the writable solution's
  hidden `.eval-toolchain/runtime/` fixture to avoid relying on parent access.
- The checksum-pinned Temurin 21.0.13+9 SDK extracted successfully. The remaining
  failure was `dash` retaining the pre-install `/usr/bin/java` path: Java probes
  still reported 25 while Maven used 21. `hash -r` after provisioning fixes it.
- The container regression reproduced that exact failure with an initial
  Java-25 probe, then passed after the fix, including a full standalone reference
  `clean verify` build, six tests and legal-file checks. Its root and workspace
  parent were read-only, network disabled, user non-root, cache read-only and
  `/tmp` mounted `noexec`. Setup env variables were deliberately omitted.

The diagnostics and downloaded logs are retained under
`target/evals/tessl-diagnostics/`. The corrected standalone generation is
`target/evals/tessl/generations/67f27ad8-7d8c-4c6e-846e-2071966db61a/`.
The prepared five-project/both-arm generation is
`target/evals/tessl/generations/f43510ef-b9f3-48cb-a4a1-87659fab8e99/`.

## Initial all-project failure (historical)

- Run: `01a1b149-31fb-733b-a2a1-bddf4944d63a`
- Label: `sling-a1c93d4593a6`
- Scope: five catalog projects, `with-skills`, one repeat each; no baseline.
- Native result: `5 of 5 repeats failed: SETUP_FAILED x5`.
- Charged platform credits: **50**, as reported by `eval view`.
- Model usage: **0 input tokens, 0 output tokens, USD 0 AI cost** in all five
  recipe records. This does **not** mean the platform credits were refunded.
- No solutions or assessments were produced; their archive keys are null.

The native runner itself reports three attempts of the failed **setup task**.
These are platform-internal attempts, not adapter retries or coding-model solves.
The CLI exposes no switch to disable those internal task retries. The adapter
submitted one remote batch and did not invoke `eval retry` or `--force`.

## Evidence

The retained generation is:

`target/evals/tessl/generations/da374bf1-f3b7-4c1e-adb9-b0fe82bebd5a/`

It contains frozen native inputs, context archive, prepared source bundles,
setup rehearsal evidence, `result.json`, `run.stderr.log` and the captured native
view. The submission ledger and remote-setup block are retained under
`target/evals/tessl/`. These are generated local artifacts, not portable source
inputs. Read-only inspection:

```sh
tessl eval view 01a1b149-31fb-733b-a2a1-bddf4944d63a --json
tessl eval list-solutions 01a1b149-31fb-733b-a2a1-bddf4944d63a --json
```

The exposed error says only that `./init-repo.sh` failed with exit 1 in
`solution/`; it does not include that script's stderr or a failing line. Metrics
list setup duration as zero, so they cannot identify the failing command.
The recipe skipped solving, activation capture and solution cleanup.

The initial hosted image reported Java **25.0.4.1**, Maven **3.9.12**, Node **24.22.2**,
Python **3.14.4**, Claude Code **2.1.287**, and recipe runner **0.1.0**. Its setup
failure metadata listed a **one-minute** limit. Later diagnostics above supplied
the previously missing setup logs and identified the actual failing commands.

The remote-setup safety stop remains in place until an explicitly reviewed,
authorized corrected run completes. Exact-batch duplicate protection is never
removed to retry. Result downloading and independent verification are read-only
and do not submit new solves or judges.

## Local checks completed before submission

- Entire offline suite passed (70 tests at submission; one opt-in integration
  skipped). Subsequent diagnosis identified intermittent Promptfoo test failures:
  the local index daemon created untracked `.tokensave/` metadata in disposable
  test repositories. Test fixtures now ignore that generated metadata, without
  relaxing the cleanliness guard for real source repositories. The guard's error
  also includes path/status evidence instead of hiding the cause.
  The final offline suite after this fix and the remote-setup spending-stop test
  now passes **73 tests**, with two opt-in integrations skipped and no failures.
  The rootless container/reference-build regression passed separately.
- Installed Pi/local streaming mock integration passed separately, with no paid
  model call.
- Both adapters generated all five scenarios; native Promptfoo config validated.
- Native Tessl lint accepted all five scenarios. It warns that the documented
  checklist `category` field is extra; the service strips it from stored rubrics.
- Native `plugin pack` succeeded; all **30 frozen context input hashes** matched
  entries in the actual archive. All three project skills matched Promptfoo's
  available skill set.
- All five Git bundle/include/setup sequences rehearsed successfully locally,
  using the preinstalled Java-21 path. The alternate runtime installer was
  unit-tested with mocked commands, not claimed as a hosted-image validation.
- All five reference solutions passed independent effective-main/test-target
  checks, `mvn clean verify`, exact test totals, bytecode and bundle metadata in
  newly prepared disposable clones. See `target/evals/catalog-verification.json`
  and the portable [calibration recipes](../../CALIBRATION.md).

## Earlier local packaging rejection

An earlier invocation printed a 50-platform-credit quote but failed locally
before creating any remote run: the harness's `/target` ignore rule stripped
the generated skill files. The read-only workspace run list contained only its
two pre-existing October 30 runs, confirming no new run from that invocation.
The local rejection and the one submitted batch are separate ledger records.

The packaging issue was resolved with an isolated generated Git boundary,
mandatory local `plugin pack`, and per-file archive hash checks. No outer ignore
rules were changed. Do not count this local rejection as another remote batch,
or the 50-credit quote as a second charge.
