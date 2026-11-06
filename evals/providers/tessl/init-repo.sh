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
# No URL-based commit fixture: Tessl packs those from the current repository,
# not from the external Sling repository named by repoUrl.
test ! -e "${EVAL_RUNTIME_ROOT:?runtime environment is required}/fixture/installed-baseline.txt" || { echo 'Refusing to overwrite an already prepared sandbox Git repository' >&2; exit 1; }
bundle=$(realpath resources/source.bundle)
baseline=$(cat resources/baseline.txt)
test "${#baseline}" = 40
case "$baseline" in *[!0-9a-f]*) echo 'Invalid baseline SHA' >&2; exit 1;; esac
# Some sandbox images initialize a root repository before setup. Preserve its
# metadata rather than deleting it or depending on that platform-generated SHA.
# This is confined to the bundle-bearing sandbox root; a .git pointer or symlink
# could name another checkout and is not safe to move.
if [ -e .git ]; then
    test -d .git && test ! -L .git
    test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"
    test ! -e resources/platform-git
    mv .git resources/platform-git
fi
git init --quiet --initial-branch=main --object-format=sha1 --template= .
git config core.hooksPath /dev/null
git config core.autocrlf false
git config commit.gpgSign false
git config user.name 'Evaluation Agent'
git config user.email 'eval@example.invalid'
git bundle verify "$bundle"
git fetch --quiet "$bundle" HEAD
git -c advice.detachedHead=false checkout --quiet --detach "$baseline"
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
