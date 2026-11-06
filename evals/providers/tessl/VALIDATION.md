# Validation record — 2026-11-06

## Outcome: first real migration independently verified; full catalog validation next

The standalone skills-arm migration completed hosted setup, solving, scoring,
automatic download and independent executable verification. Parent 52, Java 8
main/test targets, all six tests and required bundle metadata passed. The native
judge scored **9/10**; the sole missing point was transcript-based skill evidence,
while native activation metadata separately confirmed successful skill-tool use.
New generations enforce activation through a mandatory metadata audit instead
of an unsupported judge item. Historical scores remain unchanged. Full catalog/
both-arm validation is next, not yet demonstrated; scores, executable checks and
activation audits are distinct evidence.

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
| `01a1b1df-7317-708b-8417-f63c10cdaa81` | Native commit fixture with existing custom setup | Setup failed before model; local reproduction below | 10 |
| `01a1b1e1-3625-71dd-be86-efb852d4a8e1` | Native commit fixture, no custom setup | Solve and scoring completed; diagnostic 1/1; solution downloaded | 10.5185626 |
| `01a1b1e5-80b0-7395-9ef9-0999083ed08e` | Migration with native fixture and preserved Git metadata | Setup failed before model; final attempt could not read resources/baseline.txt | 10 |
| `01a1b1e8-a1ca-76a7-a948-fc94fd135920` | Combined native fixture/SDK/context trace | Completed; diagnostic 1/1; exposed checkout deletion of harness payload | 10.9268194 |
| `01a1b1f1-7247-71ce-9c6f-4fd3f21cf209` | Real standalone migration, skills arm | Native 9/10; independent checks PASS; native skill-tool activation confirmed | 13.0291564 |

Confirmed subtotal before the corrected scored run: **82.5383888 credits**.
Local CLI validation rejections created no remote run and are not extra charges.
Finalized charges across the table are **137.0129272 credits**, excluding the
nonterminal migration runs. Diagnostic scores are not calibrated migration passes.

### Corrected standalone run: scorer integration failure

Run `01a1b16f-1fbd-7732-91e4-89be5557efde` passed setup in **2,750 ms** and
completed one DeepSeek coding-agent attempt in **245,530 ms**, with **43 turns**
and **USD 1.810409** reported AI usage. This confirms hosted setup/solve execution,
not a passing migration: no assessment or downloadable solution was published.

The CLI reached its two-hour wait limit. A subsequent read-only view showed the
run still `pending`, with **57** native scoring-recipe attempts. Every attempt
failed `compute-diff` with:

```text
git add failed: fatal: not a git repository (or any of the parent directories): .git
```

All scoring-model steps were skipped with zero AI tokens. These retries are
platform-internal, not adapter resubmissions. At that inspection `credits` was
**2.8547634**, a provisional value on a nonterminal run, not a finalized total
or evidence that the ten-credit platform charge will be waived. The service
exposed no solution archive; `download-solutions` failed to find the solution.

The retained `native-current.json` contains the complete recipe history. Do not
retry this solve or launch the full catalog merely to escape the pending state.
A separate minimal scored diagnostic is testing explicit native commit-fixture
metadata; a Git repository created only by setup may not supply the scorer's
expected baseline contract. That hypothesis is not yet a confirmed fix.

The first native-fixture probe failed setup before reaching the scorer. Local
reproduction with an already-populated fixture repository showed why: moving
`.git` aside leaves its files untracked, and the subsequent checkout refuses to
overwrite them. Setup now preserves the native index/object store and imports
the original bundled history into that repository. It retains the platform's
starting SHA separately in `native-baseline.txt`. A regression covers both an
empty platform repository and a populated, single-commit native snapshot; all
12 Tessl adapter tests pass. No checkout force, reset or source-file deletion is
used. This fixes the reproduced setup conflict, not yet the scorer integration.

The no-custom-setup native commit-fixture control completed solving in 32,379 ms,
`compute-diff` in 18 ms, and scoring in 26,969 ms. It scored 1/1 and exposed a
downloadable full solution. This validates the native fixture/scorer path, not
the outcome of any parent migration.

Preparation now imports each bundled prepared-baseline ref into the isolated
generation's Git object store and declares it as the native `codebase` commit
fixture. The local rehearsal archives that ref and creates a populated synthetic
snapshot before running setup, matching the native lifecycle. Original source
history is imported into the existing repository. The tests verify deterministic
baseline identity, populated native repository handling and retained native SHA.
All 14 Tessl tests pass (one opt-in skipped), and the rootless container/reference
build passed separately against a populated fixture. The new scored standalone
generation is `3e99b1f6-2fc0-4d95-a34c-3bd4f5defbe9`.
That migration failed setup before any model tokens were used. Its final
reported stderr includes `cat: resources/baseline.txt: No such file or directory`.
Because native setup retries can change the sandbox between attempts, this alone
does not identify the first failing command. A separate diagnostic now captures
the initial file layout and a single traced setup attempt with all native Git,
SDK, include and skill-context inputs present. That diagnostic completed and its
downloaded setup log showed checkout succeeded, but deleted the tracked harness
inputs before `sh resources/runtime.sh` failed with exit 2. Native commit
`da6f3413` included the SDK, resources, `.claude`/`.agents` skill links, `.tessl`
plugin content and root framework metadata. Those paths are absent from the
original source commit, so ordinary checkout removed them, including the skills.

Setup now uses an index-only `read-tree`, verifies source-file equality, then
detaches HEAD at the original prepared baseline without changing the worktree.
The original history, harness resources, SDK and skill context all remain intact.
The regression tracks all installed inputs in the native snapshot and checks
that source mismatches fail without overwriting files. The rootless full reference
build additionally passed with the **actual native installed context archive**,
retaining skill links and metadata without weakening Maven checks. The corrected
standalone generation is `c39e85ce-20ac-4b30-8ff3-0374059ea0e5`.

### First real migration and activation evidence

Run `01a1b1f1-7247-71ce-9c6f-4fd3f21cf209` completed the entire pipeline. Its
retained `verification-report.json` has complete one-slot coverage, all shared
checks passing, and effective main/test targets preserved at 8. The only native
zero was `skill_usage`: the judge explicitly reported that its inputs lacked the
coding transcript. Meanwhile `solution.activation` contains
`activatedSkills: ["tessl__update-sling-parent-pom"]` and a matching
`activationMethods` entry with `via: "skill-tool"`.

This is an evidence-routing problem, not an unsuccessful migration or absent
activation. Future native rubrics omit that unobservable item, while the adapter
requires structured activation metadata separately (and forbids project skill
activation in the no-skills arm). Collection uses checksum-verified frozen
rubrics, so rereading an old run still reports its original 9/10 rather than
silently converting it to 9/9. No paid rescoring was performed. The legacy report
still correctly exits nonzero under its original full-native-score policy.

All five reference migrations also passed full builds and exact artifact checks
with the actual native context installed. The initial entirely offline,
read-only-cache container matrix passed standalone/packageinit but exposed cache
limitations for JCR/discovery and a missing explicit healthcheck timestamp on
Maven 3.9. Rechecks used isolated writable HOME/Maven caches and allowed the
catalog's declared network access; healthcheck received a normal POM
`project.build.outputTimestamp` based on its pinned source commit. All five then
passed without changing targets, test totals, metadata expectations or check
policies. See the updated calibration recipe and the retained
`native-context-reference-recheck.json` under generation
`6861ffab-aa40-41c9-aed0-f0245def1abd`.

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
