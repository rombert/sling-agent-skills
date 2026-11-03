# Individual management of OSGi dependencies

Migrate these aggregate dependencies when present in the POM or reported by Enforcer as banned during `mvn validate`; changing their version or scope does not resolve the ban:
- org.osgi:osgi.core
- org.osgi:osgi.cmpn

Inspect OSGi imports/usages in main and test sources, remove the aggregates, and add only the required individual dependencies not already declared. Preserve existing annotation dependencies rather than duplicating them; do not add every artifact below or wait for compilation to fail.

Common package-to-artifact mappings (all use groupId `org.osgi`):

| Package | ArtifactId |
| --- | --- |
| `org.osgi.framework.*` | `org.osgi.framework` |
| `org.osgi.util.tracker.*` | `org.osgi.util.tracker` |
| `org.osgi.service.component.annotations.*` | `org.osgi.service.component.annotations` |
| `org.osgi.service.metatype.annotations.*` | `org.osgi.service.metatype.annotations` |

Omit versions for parent-managed artifacts and set explicit scopes: `provided` for main-code dependencies, `test` for test-only dependencies (see [deps-scope.md](./deps-scope.md)). For example, `org.osgi.framework.Constants` requires:

```xml
<dependency>
    <groupId>org.osgi</groupId>
    <artifactId>org.osgi.framework</artifactId>
    <scope>provided</scope>
</dependency>
```

Run `mvn validate`, then `mvn clean verify`; add further required chapter dependencies if compilation identifies an omission.

Individual dependencies already managed in the parent POM:

- org.osgi:org.osgi.framework
- org.osgi:org.osgi.util.tracker
- org.osgi:org.osgi.dto
- org.osgi:org.osgi.service.url
- org.osgi:org.osgi.resource
- org.osgi:org.osgi.service.cm
- org.osgi:org.osgi.service.component
- org.osgi:org.osgi.service.event
- org.osgi:org.osgi.service.http
- org.osgi:org.osgi.service.http.whiteboard
- org.osgi:org.osgi.service.log
- org.osgi:org.osgi.namespace.contract
- org.osgi:org.osgi.namespace.extender
- org.osgi:org.osgi.namespace.implementation
- org.osgi:org.osgi.namespace.service
- org.osgi:org.osgi.namespace.unresolvable
- org.osgi:org.osgi.annotation.versioning
- org.osgi:org.osgi.annotation.bundle
- org.osgi:org.osgi.service.component.annotations
- org.osgi:org.osgi.service.metatype.annotations
