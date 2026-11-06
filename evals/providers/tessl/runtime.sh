#!/bin/sh
set -eu

java21() { java -version 2>&1 | grep -Eq 'version "21\.'; }
maven21() { mvn -version 2>&1 | grep -Eq 'Java version: 21\.'; }
if ! java21 || ! maven21; then
    # The native env file persists these paths into agent and Maven processes;
    # init-repo.sh derives them for setup too. Never apt-install or use sudo.
    test "$JAVA_HOME" = "${EVAL_RUNTIME_ROOT:?}/jdk-21"
    case "$EVAL_RUNTIME_ROOT" in /workspace/solution/.eval-toolchain/runtime|/tmp/opencode/*) :;; *) echo 'Unsafe runtime root' >&2; exit 1;; esac
    maven=$(command -v mvn)
    expected=$(cat .eval-toolchain/sha256.txt)
    printf '%s  %s\n' "$expected" .eval-toolchain/jdk.tar.gz | sha256sum --check --status
    mkdir -p "$JAVA_HOME" "$EVAL_RUNTIME_ROOT/bin"
    tar -xzf .eval-toolchain/jdk.tar.gz -C "$JAVA_HOME" --strip-components=1
    printf '#!/bin/sh\nexport JAVA_HOME="%s"\nexec "%s" "$@"\n' "$JAVA_HOME" "$maven" > "$EVAL_RUNTIME_ROOT/bin/mvn"
    chmod 755 "$EVAL_RUNTIME_ROOT/bin/mvn"
    # dash caches the system java found by the pre-install probe. A newly
    # extracted executable earlier on the unchanged PATH does not invalidate it.
    hash -r
fi
mkdir -p "${EVAL_RUNTIME_ROOT:?}"
{ java -version; mvn -version; } > resources/environment.txt 2>&1
if ! java21 || ! maven21; then cat resources/environment.txt >&2; exit 1; fi
