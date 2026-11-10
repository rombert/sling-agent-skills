# Validation record — retained evidence reviewed 2026-11-09

## Outcome: full native and executable coverage complete; overall evaluation nonpassing

The standalone skills-arm migration completed hosted setup, solving, scoring,
automatic download and independent executable verification. Parent 52, Java 8
main/test targets, all six tests and required bundle metadata passed. The native
judge scored **9/10**; the sole missing point was transcript-based skill evidence,
while native activation metadata separately confirmed successful skill-tool use.
New generations enforce activation through a mandatory metadata audit instead
of an unsupported judge item. Historical scores remain unchanged. The full five-
project/both-arm batch subsequently completed native scoring in all ten slots,
with seven perfect scores and correct activation behavior in all ten. Independent
collection stopped after one verification failure and a subsequent download error.
Incremental/resumable collection is now implemented and the existing failure has
been adopted read-only into a durable ten-slot aggregate; nine full-batch
executable outcomes remained unverified at that offline checkpoint. The user
subsequently restored CLI access and explicitly authorized read-only collection
of those missing outcomes. All nine newly collected solutions passed independent
verification: **9 executable PASS, 1 preserved FAIL, 0 missing**. Native scores
remain perfect in **7/10**, activation audits pass **10/10**, and the combined
policy passes **6/10** slots. Scores, executable checks and activation audits are
distinct evidence; the batch is not an all-passing evaluation or proof of skill
effect.

### Completed full batch and collection interruption

Run `01a1b212-71c8-735e-88c2-3ac9991db884` is `completed`. Its frozen generation is
`target/evals/tessl/generations/6514ef39-3f5e-40be-be31-d6a8ee650f3c/`; `result.json`
and `native-01a1b212-71c8-735e-88c2-3ac9991db884.json` retain the native outcome.
The submission ledger is `postprocessing-failed`, not a failed remote solve.

| Scenario | Native with skills | Native without skills | Independent full-batch verification |
|---|---:|---:|---|
| discovery-impl | 8.75/9 | 9/9 | With skills: PASS; without skills: preserved FAIL |
| JCR packageinit | 8.5/9 | 9/9 | Both arms PASS |
| JCR JS nodetypes | 10/10 | 8/10 | Both arms PASS |
| JUnit healthcheck | 9/9 | 9/9 | Both arms PASS |
| discovery-standalone | 9/9 | 9/9 | Both arms PASS; separate earlier skills run remains historical evidence |

Native deductions were for unnecessary Mockito upgrades in the discovery-impl
and packageinit skills arms (packageinit also added `.sling-module.json`), and for
retaining old Mockito with a forbidden `--add-opens` workaround in JCR JS without
skills. No scores have been rewritten. Each skills arm has relevant native
`read` activation evidence; every no-skills arm has an empty `activatedSkills`.

Before remediation, only solution `01a1b212-7646-74f1-94f0-a7298f52e7b8`
(discovery-impl without skills) had completed independent verification. It
preserved Java 11 targets but failed
`TopologyEventTest>AbstractTopologyEventTest.testGetDuringDelay:234`, expecting
zero events and observing one: 45 tests, one failure, no final JAR. The build log
reports roughly one day and 18 hours elapsed. The cause is unresolved; this is
not classified as a confirmed model defect or a confirmed flaky test.

The next historical solution download failed with `getaddrinfo EAI_AGAIN tessl.io`, PostHog
network errors and a request to authenticate. Collection aborted before writing
a complete `verification-report.json`. Resume downloads/independent checks only
after connectivity/authentication is restored; **do not resubmit or rescore the
completed batch**. The initial offline remediation phase on 2026-11-09 made one read-only access check:
`tessl whoami` exited 1 with “You are not logged in” and “Please authenticate”.
No download was attempted in that phase, no interactive authentication or credential changes
were performed, and no new solve, judge, retry, polling or charge was initiated.
DNS connectivity was not independently established after the decisive login
blocker. The existing submission ledger remains `postprocessing-failed` and was
not edited.

### Incremental remediation and retained resume evidence — 2026-11-09

The collector now persists all native grades/activation metadata before the first
download, plus download/verification transitions, errors and incomplete coverage.
Each collection retains immutable report revisions and attempt directories; the
latest aggregate is updated atomically. Explicit resume validates frozen inputs,
native views, verifier/shared-check/dependency-lock identity, source-snapshot
checksums and verification receipts before reusing completed PASS **or FAIL**.
It refuses changed inputs and does not automatically retry verification errors.
The first failed remote download stops further remote reads in that invocation.

The existing discovery-impl no-skills failure was safely adopted, not rebuilt.
The read-only adoption matched its frozen scenario/check definition, source pin
and prepared baseline `8743059e9f26b26eb84a06a800071736271db208`, downloaded and
imported source trees, retained check results, effective main/test targets (11),
and failed Maven log. Imported-source snapshot SHA-256 is
`164444afa3f5050b5d31b316bdfcd6f148437409ec606a731a5d59fd133bd77f`.
Thirteen supporting files are checksum-pinned. The original `verification.json`,
logs, clone and failing test evidence are unchanged. This establishes matching
retained evidence, **not** an explanation of the anomalous elapsed time or a new
successful execution. The unresolved failure and no-final-JAR result remain.

The initial offline remediation retained the following evidence (all historical
checkpoints remain unchanged; the completed latest report is described below):

- The then-current `verification-report.json`: ten native records; **0 executable PASS, 1 completed
  executable FAIL, 9 missing**; `coverage.nativeComplete=true`,
  `coverage.complete=false`, `pass=false`; all native deductions unchanged and
  all ten activation audits passing.
- `collection/022add34-b8f8-45f3-9469-9927e732f42b/report-0022.json`: immutable
  finalized offline collection/adoption checkpoint. A subsequent offline explicit
  resume also succeeded in reusing the failed receipt without downloading or
  rebuilding; its immutable checkpoint is
  `collection/bb792921-f451-4f62-9ae8-2bd7b956c787/report-0022.json`.
- `legacy-evidence.json`: the explicit reviewed legacy solution-to-report mapping.
- `access-check-2026-11-09.json`: the access blocker and no-retry decision.
- `remediation-outcome-audit.json`: initial offline counts and then-current frozen/verifier
  bindings, reused failed receipt and original verification/ledger checksums.
- `collector-finalization-audit.json`: earlier development checkpoints were
  preserved intact after the last collector-only locking/resume fixes changed
  the verifier fingerprint. The original legacy failure was re-audited offline
  under the finalized collector, without repeating any build or download.

Both historical collection commands intentionally exited **1** because the evaluation was not
passing; this is not lost progress or another failed remote solve:

```sh
TESSL_MANIFEST=target/evals/tessl/generations/6514ef39-3f5e-40be-be31-d6a8ee650f3c/manifest.json \
  TESSL_LEGACY_EVIDENCE=target/evals/tessl/generations/6514ef39-3f5e-40be-be31-d6a8ee650f3c/legacy-evidence.json \
  TESSL_COLLECT_OFFLINE=1 RUNS=1 node evals/providers/tessl/collect.cjs

TESSL_MANIFEST=target/evals/tessl/generations/6514ef39-3f5e-40be-be31-d6a8ee650f3c/manifest.json \
  TESSL_COLLECT_RESUME=1 TESSL_COLLECT_OFFLINE=1 RUNS=1 \
  node evals/providers/tessl/collect.cjs
```

After the user restored existing Tessl CLI access, the explicitly permitted
`tessl whoami` check succeeded and this read-only download/isolated-cache
verification command completed the nine missing outcomes, not a paid launcher
or rescore:

```sh
TESSL_MANIFEST=target/evals/tessl/generations/6514ef39-3f5e-40be-be31-d6a8ee650f3c/manifest.json \
  TESSL_COLLECT_RESUME=1 RUNS=1 node evals/providers/tessl/collect.cjs
```

This preserved/reused the known failed solution and attempted only the nine
missing downloads/checks, with no automatic retries or renewed access failures.
New builds used Java **21.0.13** for Java and Maven **3.10.0** (confirmed by
retained runtime evidence), provider-owned settings and a separate writable
`verification-maven/repository` cache; no mutable shared Maven-cache hardlinks.
Exact source pins, catalog command, parent/bytecode/test/bundle checks and
1,200-second command timeout are unchanged. The original no-skills discovery
failure was not rebuilt.

Scoped offline regression command:

```sh
node --test evals/providers/tessl/*.test.cjs
```

Result after parent review: **62 passed, 1 opt-in rootless integration skipped,
0 failures** (63 tests, including 24 supporting-file mutation/removal subtests).
Coverage includes interrupted downloads, metadata-first persistence, incomplete
native/executable coverage, explicit resume, failed-result reuse, altered evidence
rejection, interrupted metadata recollection, later-slot receipt preservation
after an early download failure, locking, historical deductions, legacy
read-only adoption and isolated Java/Maven settings. Tests use mocks or disposable
local repositories, not paid solves or judges. The older standalone skills run
remains native **9/10**, independent **PASS**, with skill-tool activation; it is
not substituted for either full-batch standalone slot.

### Parent review follow-up: compatibility and new-receipt support binding

The collector's newly introduced ten-repetition restriction was removed. It now
requires a positive safe integer, consistent with common `RUNS` parsing, and a
mocked eleven-repetition collection regression passes. This changes completed
result collection only, not the pre-existing paid-launcher budget policy.

New independent receipts now bind their actual `verification.json`, frozen
scenario/repository metadata, Java/Maven version and runtime/cache configuration,
scenario-check results, build log and retained effective-POM/comparison/log files.
The verifier's on-disk result and scenario checks must match its returned result.
Tests mutate and remove each of twelve supporting files individually, verify that
resume fails closed without downloads/builds, reject absent support inventories
and required files, and preserve a legitimate early rejection without inventing
unexecuted Maven/target artifacts. Fake verifiers explicitly produce labelled
mock evidence; they do not claim a real build.

`parent-review-migration.json` records the explicit reviewed migration: the old
schema-2 verifier binding was **rejected**, its latest aggregate was archived
unchanged alongside its immutable checkpoint revisions, and the original
discovery-impl failure was adopted read-only again under the updated verifier.
The frozen manifest, native response/view, original failure and submission ledger
checksums were pinned before migration. Offline collection and explicit offline
resume retained **1 known FAIL and 9 missing** before any restored-access call.
No incompatible schema-2 receipt was silently accepted, and no build/download was
repeated during migration.

### Restored access: existing completed-result collection finished

After the user explicitly confirmed restored login, the one permitted
`tessl whoami` access check exited **0** (“You are logged in to Tessl”).
`access-restored-2026-11-09.json` retains this decision separately from the earlier
failed check. The existing completed batch was resumed with the documented
`TESSL_COLLECT_RESUME=1` command, without another native view, solve, submission or
rescore. The known no-skills discovery failure is reused, not rebuilt.

Status rechecked at **2026-11-09 16:52:24 UTC**: collection is finished, with
**no active collector/download/verification process, no active slot and no
generation lock**. The resumed collection ran from **16:22:23.776 UTC** to
**16:29:46.750 UTC**, approximately **7 minutes 23 seconds**. Its last progress
was complete ten-slot executable coverage, followed by successful fully offline
reuse of all ten receipts. There is no remaining authentication/transport blocker;
the nonpassing result is the preserved executable failure plus native deductions.

All nine newly downloaded solutions passed `mvn clean verify`, exact parent,
inherited main/test compiler targets, bytecode, test totals and bundle metadata
checks. They used Java **21.0.13**, Maven **3.10.0** on that same Java 21, the
generation-owned `verification-maven/` settings/repository, and the unchanged
**1,200,000 ms** catalog command timeout. No build was skipped, relaxed or retried.
Native deductions, including the no-skills JCR JS model's forbidden `--add-opens`
workaround, remain native failures even though its executable checks passed.

Final executable outcomes, relative to the frozen generation:

| Scenario | Arm | Solution ID | Attempt | Executable outcome / exact test totals |
|---|---|---|---|---|
| discovery-impl | without-skills | `01a1b212-7646-74f1-94f0-a7298f52e7b8` | `attempt-OyU7Y5` | Preserved FAIL: Java 11, 45 tests / 1 failure, no JAR; no rerun |
| discovery-impl | with-skills | `01a1b212-7635-7756-9fb9-7a630d6d374b` | `attempt-B3V8Ab` | PASS: Java 11, 45 tests |
| JCR packageinit | without-skills | `01a1b212-7664-71a9-a38e-1ac70532c3e9` | `attempt-lzpLb9` | PASS: Java 8, 6 tests |
| JCR packageinit | with-skills | `01a1b212-7656-7431-ada5-d6611ab00ab7` | `attempt-4UM9h6` | PASS: Java 8, 6 tests |
| JCR JS nodetypes | without-skills | `01a1b212-7686-711f-bbd1-afc30a3d2dc9` | `attempt-GtY3Pp` | PASS: Java 8, 29 Java + 39 JavaScript tests |
| JCR JS nodetypes | with-skills | `01a1b212-7673-70ad-9bd7-72fad67e87c1` | `attempt-KcpBM0` | PASS: Java 8, 29 Java + 39 JavaScript tests |
| JUnit healthcheck | without-skills | `01a1b212-76a2-7746-8ccf-4dc62112568a` | `attempt-6Xrg62` | PASS: Java 8, 3 tests |
| JUnit healthcheck | with-skills | `01a1b212-7694-73d7-b08c-c12fd33e8be9` | `attempt-K5kSR4` | PASS: Java 8, 3 tests |
| discovery-standalone | without-skills | `01a1b212-76c1-745b-aca4-63ce579767f2` | `attempt-XJgqWr` | PASS: Java 8, 6 tests |
| discovery-standalone | with-skills | `01a1b212-76b2-73f6-9d24-00204e137cd5` | `attempt-jnN1mv` | PASS: Java 8, 6 tests |

Each attempt is retained at `verification/<solution-id>/<attempt>/`, including
the original `verification.json`, check results, effective POMs, logs and runtime
evidence. The new collector receipt is `collection-verification.json`. Each new
receipt binds **12 supporting files**; the preserved legacy failure binds **13**.
Downloaded snapshots are retained under the completed collection directory's
`downloads/<solution-id>/`, separately from verification clones.

Final immutable checkpoints:

- Completed collection:
  `collection/e11be1ba-0f27-41fa-9383-ce8765097a7c/report-0049.json`.
- Subsequent fully offline reuse of all ten completed outcomes:
  `collection/c44f6430-02a0-4683-bce2-7fab12728f68/report-0022.json`.
- `completed-batch-outcome-audit.json`: per-slot results, complete coverage,
  current frozen/verifier bindings, all-ten offline reuse and unchanged original
  failure, manifest/native response/view and submission-ledger checksums.

The latest `verification-report.json` has **10/10 native and executable coverage,
9 executable PASS, 1 executable FAIL, 0 missing, no collection errors**. All ten
activation audits pass; seven native scores are perfect. Combined policy passes
six slots and `pass=false` correctly remains. The collection exits **1** for this
nonpassing evaluation, not for missing coverage or transport failure. No paid
submission, solve, scoring or model call was made; charges remain unchanged.

Safe repeat inspection requires no Tessl connectivity and performs no builds:

```sh
TESSL_MANIFEST=target/evals/tessl/generations/6514ef39-3f5e-40be-be31-d6a8ee650f3c/manifest.json \
  TESSL_COLLECT_RESUME=1 TESSL_COLLECT_OFFLINE=1 RUNS=1 \
  node evals/providers/tessl/collect.cjs
```

This command was executed after collection and reused all ten results while
checking **121 supporting-file hashes**. No further downloads or builds are
needed. The original failure's cause remains unresolved; do not rerun it merely
to obtain a pass. The original ledger remains `postprocessing-failed` unchanged,
with final collection evidence retained independently in this generation.

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
| `01a1b212-71c8-735e-88c2-3ac9991db884` | Five projects, both arms, one repetition | Native and executable coverage complete; 9 executable PASS, 1 preserved FAIL | 157.2458338 |

Confirmed subtotal before the corrected scored run: **82.5383888 credits**.
Local CLI validation rejections created no remote run and are not extra charges.
Finalized charges across the table are **294.258761 credits**, including the
full batch's **157.2458338 credits**. The older nonterminal run's provisional
2.8547634 credits remain excluded; its current remote status was not rechecked.
Diagnostic scores are not calibrated migration passes.

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

### Full-batch local preflight storage fix

The first ten-solve batch command stopped in local rehearsal `git add --all`
with a disk-quota error, **before** the submission ledger and paid native eval
call. It incurred no new solve charge and was not a remote retry. Repeated local
snapshots had duplicated the 200-MB SDK both as archive files and Git blobs.

Rehearsals now link the checksum-verified immutable SDK archive where supported
and share one SDK blob in the retained generation's Git object store. Tests and
the real five-project preflight confirmed the complete snapshots can read that
blob without writing duplicate per-rehearsal SDK objects. Existing verified
duplicate archives were atomically coalesced without changing their bytes or
paths; source, results and logs were retained. No native fixture or task changed.
Generation `6514ef39-3f5e-40be-be31-d6a8ee650f3c` passed the corrected five-project
local preflight and is prepared for the ten-solve, both-arm native batch.
The subsequent launch passed local preparation and wrote submission ledger
`fe9d143df7c77c584e97dbfadd4324a428059e6d56647f9985813a18ee7a76de-1.json`.
The CLI quoted **100 platform credits plus variable AI usage**, not a finalized
charge. The batch covers all five scenarios, both explicit arms, one repetition
each. The subsequent completion, actual charge and interrupted independent
collection are recorded above. Do not resubmit this fingerprint on timeout;
inspect the retained native response and collect results read-only.
The relevant offline suites now pass **30 tests**, with one opt-in skipped.

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
