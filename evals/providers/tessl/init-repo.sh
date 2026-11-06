#!/bin/sh
# Tessl invokes setup with sh, regardless of the script's shebang.
set -eu
# The hosted runner's setup shell does not necessarily inherit the agent's
# --env-file variables. Derive equivalent paths before any fixture operation.
EVAL_RUNTIME_ROOT=${EVAL_RUNTIME_ROOT:-"$(pwd)/.eval-toolchain/runtime"}
JAVA_HOME=${JAVA_HOME:-"$EVAL_RUNTIME_ROOT/jdk-21"}
PATH="$EVAL_RUNTIME_ROOT/bin:$EVAL_RUNTIME_ROOT/jdk-21/bin:$PATH"
export EVAL_RUNTIME_ROOT JAVA_HOME PATH

# Only runs in the disposable evaluation sandbox, never in the source checkout.
# The native commit fixture supplies the prepared tree and scorer metadata;
# the bundle restores original source history instead of the synthetic snapshot.
test ! -e "${EVAL_RUNTIME_ROOT:?runtime environment is required}/fixture/installed-baseline.txt" || { echo 'Refusing to overwrite an already prepared sandbox Git repository' >&2; exit 1; }
bundle=$(realpath resources/source.bundle)
baseline=$(cat resources/baseline.txt)
test "${#baseline}" = 40
case "$baseline" in *[!0-9a-f]*) echo 'Invalid baseline SHA' >&2; exit 1;; esac
# Native snapshots include ALL installed inputs, including resources, SDK and
# skill context. Keep the object store and payload files. A normal checkout of
# the source revision would delete every tracked harness input absent there.
native_baseline=
if [ -e .git ]; then
    test -d .git && test ! -L .git
    test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"
    test -z "$(git status --porcelain --untracked-files=no)"
    native_baseline=$(git rev-parse --verify HEAD 2>/dev/null) || :
    printf '%s\n' "$native_baseline" > resources/native-baseline.txt
else
    git init --quiet --initial-branch=main --object-format=sha1 --template= .
fi
git config core.hooksPath /dev/null
git config core.autocrlf false
git config commit.gpgSign false
git config user.name 'Evaluation Agent'
git config user.email 'eval@example.invalid'
git bundle verify "$bundle"
git fetch --quiet "$bundle" HEAD
if [ -n "$native_baseline" ]; then
    # Replace only the disposable index/HEAD, never the worktree. Source files
    # must already match the imported prepared tree; refuse any mismatch.
    git read-tree "$baseline"
    git diff --quiet
    git update-ref --no-deref HEAD "$baseline"
else
    git -c advice.detachedHead=false checkout --quiet --detach "$baseline"
fi
test "$(git rev-parse HEAD)" = "$baseline"
mkdir -p .git/info
printf '\n/resources/\n/.eval-toolchain/\n/init-repo.sh\n/setup.sh\n' >> .git/info/exclude
sh resources/runtime.sh
# The prepared baseline already contains shared fixture setup. Do not apply it
# twice, nor count it as agent work. Keep the original SHA as separate evidence.
git rev-parse HEAD > resources/installed-baseline.txt
# Do not let harness scripts, archives or metadata contaminate RAT/legal checks.
# Preserve these known fixture inputs in the ignored, hidden toolchain fixture
# rather than deleting them or requiring write access to /workspace itself.
mv resources "$EVAL_RUNTIME_ROOT/fixture"
if [ -f init-repo.sh ]; then mv init-repo.sh "$EVAL_RUNTIME_ROOT/fixture/launcher.sh"; fi
test -z "$(git status --porcelain --untracked-files=no)"
exit 0
