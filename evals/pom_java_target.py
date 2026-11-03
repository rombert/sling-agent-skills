"""Read resolved compiler targets from a Maven effective POM, not the build JDK."""

import json
import re
import sys
import xml.etree.ElementTree as ET


def read_targets(filename):
    root = ET.parse(filename).getroot()
    ns = root.tag.partition("}")[0] + "}" if root.tag.startswith("{") else ""
    if root.tag != ns + "project":
        raise ValueError("Expected a single Maven effective project")

    def text(element, name, default=""):
        return element.findtext(ns + name, default).strip()

    properties = root.find(ns + "properties")
    props = {p.tag.removeprefix(ns): (p.text or "").strip() for p in properties} if properties is not None else {}

    def resolve(value):
        for _ in range(20):
            if "${" not in value:
                return value
            updated = re.sub(r"\$\{([^}]+)\}", lambda m: props.get(m[1], m[0]), value)
            if updated == value:
                break
            value = updated
        raise ValueError("Unresolved compiler target: " + value)

    def configuration(element):
        config = element.find(ns + "configuration")
        if config is None:
            return {}
        # Explicit command-line compiler target overrides need separate handling;
        # fail closed instead of incorrectly crediting an unchanged property.
        args = resolve(" ".join(config.itertext()))
        if re.search(r"(?:^|\s)(?:--release(?:=|\s)|-target(?:=|\s))", args):
            raise ValueError("Custom compiler target arguments cannot be graded safely")
        arguments = config.find(ns + "compilerArguments")
        if arguments is not None and any(arg.tag.removeprefix(ns) in ("target", "release") for arg in arguments):
            raise ValueError("Custom compiler target arguments cannot be graded safely")
        return {c.tag.removeprefix(ns): (c.text or "").strip() for c in config}

    plugins = root.find(ns + "build/" + ns + "plugins")
    compiler = next((p for p in plugins if text(p, "artifactId") == "maven-compiler-plugin"
                     and text(p, "groupId", "org.apache.maven.plugins") == "org.apache.maven.plugins"), None) if plugins is not None else None
    if compiler is None:
        raise ValueError("No active Maven compiler plugin in the effective POM")
    common = configuration(compiler)

    def target(config, test):
        choices = []
        if test:
            choices += [(config.get("testRelease"), "testRelease"), (props.get("maven.compiler.testRelease"), "maven.compiler.testRelease")]
        choices += [(config.get("release"), "release"), (props.get("maven.compiler.release"), "maven.compiler.release")]
        if test:
            choices += [(config.get("testTarget"), "testTarget"), (props.get("maven.compiler.testTarget"), "maven.compiler.testTarget")]
        choices += [(config.get("target"), "target"), (props.get("maven.compiler.target"), "maven.compiler.target")]
        for value, setting in choices:
            if not value:
                continue
            value = resolve(value)
            if value.startswith("1."):
                value = value[2:]
            if not re.fullmatch(r"[1-9]\d?", value):
                raise ValueError("Invalid compiler target: " + value)
            return {"target": int(value), "setting": setting}
        raise ValueError("No resolved compiler release/target; refusing to infer it from the build JDK")

    evidence = []
    executions = compiler.find(ns + "executions")
    if executions is not None:
        for execution in executions:
            goals = execution.find(ns + "goals")
            if goals is None:
                continue
            config = {**common, **configuration(execution)}
            for goal in goals:
                if goal.text not in ("compile", "testCompile"):
                    continue
                if text(execution, "phase") == "none":
                    raise ValueError("Compiler execution disabled")
                evidence.append({"kind": "test" if goal.text == "testCompile" else "main",
                                 "execution": text(execution, "id"), **target(config, goal.text == "testCompile")})
    for kind in ("main", "test"):
        if not any(e["kind"] == kind for e in evidence):
            evidence.append({"kind": kind, "execution": "implicit-default", **target(common, kind == "test")})
    return {"targets": {kind: sorted({e["target"] for e in evidence if e["kind"] == kind}) for kind in ("main", "test")},
            "evidence": evidence}


if __name__ == "__main__":
    print(json.dumps(read_targets(sys.argv[1])))
