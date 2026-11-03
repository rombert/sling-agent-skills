# Setting the mandatory sling.java.version property

Newer Sling parent POM versions require the property `sling.java.version` to be set explicitly. Older parent versions defaulted it (commonly to `8`); the newer parent no longer supplies a default, so the build fails with:

```
[ERROR] Rule 0: org.apache.maven.enforcer.rules.property.RequireProperty failed with message:
[ERROR] Property "sling.java.version" is required for this build and must be between 8 and 99.
```

This property controls the Java **API/class-file compliance level** the bundle is compiled against (via `--release`) — it is independent of the JDK used to run the build.

Before changing the parent, record the current value:

```bash
mvn -q help:evaluate -Dexpression=sling.java.version -DforceStdout
```

Check explicit `maven-compiler-plugin` `source`/`target`/`release` overrides before treating this property as the effective target. If the property is unresolved or overridden, inspect the effective compiler configuration; when inspecting old parent POMs, follow their actual `<parent>` coordinates rather than guessing artifact names.

Fix: add the property to the project's own `<properties>`, set to the original effective target recorded above:

```xml
<properties>
    <sling.java.version>8</sling.java.version>
</properties>
```

Do not default to a higher value (e.g. matching the JDK used to build) unless the project already required it — that would silently raise the bundle's minimum Java API requirement for consumers.
