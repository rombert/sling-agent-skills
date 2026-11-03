# Configuring the build timestamp

Preserve an existing valid `project.build.outputTimestamp`. Otherwise, set this fixed value in `pom.xml` before building. Do not use `1` or `2`: both represent timestamps in 1970, which newer `maven-remote-resources-plugin` versions reject.

```xml
  <project.build.outputTimestamp>1980-01-01T00:00:02Z</project.build.outputTimestamp>
```
