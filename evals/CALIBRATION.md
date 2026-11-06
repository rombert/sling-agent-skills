# Real-repository scenario calibration

All five tasks use immutable source SHAs in `scenarios.yaml`. The original four
submodules were not edited; calibration used disposable clones. No model calls
or Tessl credits were used to derive these expected outcomes.

## Verified matrix (Java 21)

| Scenario | Parent migration | Prepared baseline `clean verify` | Main/test bytecode | Tests after migration |
|---|---|---|---|---|
| jcr-js-nodetypes | sling:34 → sling-bundle-parent:46 | Fails: old Surefire cannot detect Java 21 | Java 8 / major 52 | 29 Java + 39 Jasmine, no failures/errors/skips |
| discovery-standalone | bundle-parent:46 → 52 | Passes, six tests | Java 8 / major 52 | 6, no failures/errors/skips |
| jcr-packageinit | bundle-parent:52 → 60 | Passes, six tests | Java 8 / major 52 | 6, no failures/errors/skips |
| junit-healthcheck | sling:43 → sling-bundle-parent:46 | Three tests pass; ianal legal-file verification fails under restricted reflection | Java 8 / major 52 | 3, no failures/errors/skips |
| discovery-impl | bundle-parent:52 → 60 | Passes, 45 default-selected tests | Java 11 / major 55 | 45, no failures/errors/skips |

For the four newly calibrated fixtures, local Maven was 3.10.0 and Java was
21.0.13. Full effective POMs at baseline and target were inspected: `release`
takes precedence over the inherited legacy source/target properties. Do not
mistake the healthcheck POM's inherited `maven.compiler.target=1.7` for its actual
Java target: its compiler execution explicitly uses `release=8`.

Later rootless checks use Maven 3.9 (the hosted runner uses 3.9.12). Do not assume
that the initial Maven 3.10 result makes every reference POM portable unchanged:
healthcheck requires an explicit reproducible-build timestamp on Maven 3.9, as
described below. Runtime differences do not change bytecode or test expectations.

## Reproducible reference recipes

Clone each catalog URL, detach at its full catalog SHA, then apply only the
corresponding migration below. Select Java 21 for both `java` and `mvn`.
Always finish with **`mvn clean verify`**, without skip flags, JVM module opens,
or parent-plugin overrides. Read actual Surefire XML, class headers and the
built bundle; summaries alone are not verification. The shared executable
checks encode the exact paths, expected test totals and artifact metadata.

### JCR JavaScript NodeTypes

Apply the catalog's Jasmine fixture patch before beginning the task and commit
it only in the disposable clone as the prepared baseline. The parent boundary
is 46: 40–45 retain ianal's reflection failure; 46 replaces its legal checker.
Migrate Felix bundle instructions to Bnd, rename the Sling Maven plugin, use
Mockito Core 4.11.0 and migrate the two `Matchers.anyInt` imports to
`ArgumentMatchers.anyInt`. Keep Java 8 and all 39 JavaScript specs. Only the
unreleased module's baseline skip is accepted. Reference upstream revision:
`e06e10b580f41747a366762083a4e5f34e5cce98`.

### Discovery standalone

Change parent 46→52 and add `sling.java.version=8` explicitly because parent 52
defaults to Java 11. Add `provided` scopes for SLF4J API and the OSGi framework,
and `test` scopes for SLF4J Simple and JUnit. Replace aggregate `osgi.core` with
`org.osgi.framework`; the new parent's Enforcer correctly bans the aggregate.
No source or Bnd changes are necessary. Both DS and metatype descriptors remain
present. The reference build produced 13 main/test class files at major 52.

### JCR package init

Change parent 52→60, retain existing `sling.java.version=8`, and run
`mvn spotless:apply` using parent-managed formatting. The two Java files need
formatting only. The existing Mockito 2.21.0 works in this suite on Java 21;
there is no evidence-based need to upgrade it for this task. The initializer's
DS service and metatype remain present. Four main/test class files use major 52.

### JUnit healthcheck

Change both parent artifact and version to `sling-bundle-parent:46`, remove
`packaging=bundle`, and remove Felix bundle/SCR plugins. The bundle parent's
Enforcer bans the SCR plugin and annotations: disabling Enforcer is not a fix.
Use provided OSGi component/metatype annotation dependencies and migrate the
single annotated production class:

- DS `@Component(service=HealthCheck.class, configurationPolicy=REQUIRE)`.
- Preserve the `TestsManager` reference and unchanged executable methods,
  including the existing `@Activate` method taking a map.
- `@Designate(factory=true)` with an OCD retaining the original class-name PID.
- Preserve `hc.name`, multi-valued `hc.tags`, `hc.mbean.name`,
  `test.package.or.class`, and `test.method` in the OCD. The reference uses
  underscore-to-dot method naming with empty defaults; do not rename properties.
- Bnd preserves `Sling-Test-Regexp: .*Test` and optional imports for
  `org.apache.http.*`, `org.apache.sling.testing.tools.http`, and
  `org.junit.internal.*`, followed by `*`.
- The old export patterns match no classes; the built bundle has no exports.

For Maven 3.9, also declare `project.build.outputTimestamp` in the POM to satisfy
the new parent's Enforcer rule. A deterministic value is the pinned source
commit's timestamp, `2025-08-06T12:20:02Z`. Set this as a normal migration property,
not an Enforcer skip or a command-line workaround. The initial Maven 3.10
reference passed without this explicit property; the rootless Maven 3.9 check
exposed the omission. No expected tests, metadata or compiler targets change.

Do not replace SCR annotations by simply dropping configuration factory or
metatype behavior. The reference preserves generated DS and metatype descriptors
under the original PID. Six main/test class files use major 52. This is a genuine
legacy-to-bundle-parent migration; merely changing `sling:43` to `sling:46` is
not the requested result even though that narrower change can build.

### Discovery implementation

Change parent 52→60 and run `mvn spotless:apply`. Mandatory formatting affects
33 Java files; no semantic edits or dependency upgrades are needed. Both parents
use Java 11 bytecode by default. Preserve all seven DS descriptors, metatype and
the optional webconsole import directive. The reference produces 49 main/test
classes at major 55.

The baseline already excludes the `Slow` category. Retain that exact default
selection (45 tests), the `includeSlowTests` profile, heap settings and JaCoCo
argument wiring. This is not permission to add further exclusions or shorten
test waits. A full slow-category run is not part of this scenario's default
verification contract.

## Evidence and limits

Initial local logs/effective POMs and edited reference workspaces are retained at
`/tmp/opencode/tessl-calibration/`; the JCR parent-boundary record is at
`/tmp/opencode/jcr-java21-boundary-9Y0P4SOA/BOUNDARY.md`. These are local evidence
paths, not portable inputs. The immutable pins, recipes and expected values above
and in the catalog are the portable reproduction contract. Reference source
changes are never uploaded to a task as fixture setup or model guidance.

No no-commit instruction was imposed on the human calibration process. The
**agent tasks do forbid staging/commits**, including formatting commits; evaluate
agent git actions separately from disposable harness baseline preparation.
One successful local solution establishes feasibility and expected results, not
LLM reliability, score equivalence across providers or skill effect size.
