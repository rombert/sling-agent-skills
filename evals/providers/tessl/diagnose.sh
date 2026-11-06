#!/bin/sh
# Hosted setup probe only: return success so its diagnostic files are retained
# even when the real setup fails. Never use this as a calibrated task's setup.
mkdir -p diagnostics
{
    printf 'cwd=%s\n' "$(pwd)"
    printf 'setup_bash_version=%s\n' "${BASH_VERSION-unset}"
    printf 'PATH=%s\nJAVA_HOME=%s\n' "$PATH" "${JAVA_HOME-unset}"
    printf 'HOME=%s\nEVAL_RUNTIME_ROOT=%s\n' "$HOME" "${EVAL_RUNTIME_ROOT-unset}"
    id
    uname -a
    cat /etc/os-release
    find . -maxdepth 2 -type f | sort | head -80
    for tool in sh bash git java mvn apt-get sudo mise timeout; do command -v "$tool" || :; done
    java -version 2>&1 || :
    mvn -version 2>&1 || :
    ls -la /usr/lib/jvm /opt/java /opt/java/openjdk /usr/local/bin/java /usr/local/bin/mvn 2>&1 || :
    ls -ld /workspace /workspace/solution "$HOME" 2>&1 || :
} > diagnostics/environment.txt 2>&1
timeout 30s sh -x resources/original-init-repo.sh > diagnostics/setup.log 2>&1
printf 'setup_exit=%s\n' "$?" >> diagnostics/environment.txt
exit 0
