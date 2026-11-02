# Parent POM upgrade comparison

Run from the repository root:

```sh
make run-evals
# or:
sops exec-env .env 'npx promptfoo@0.125.1 eval --no-cache'
```

Requires Node.js 22+, Python 3 (standard library only), Git, Java, Maven, and
`LITELLM_API_KEY`. Python parses the actual parent XML for deterministic checks.
The version-specific Maven wrappers documented in the main README are available
as optional tools.

Change `providers[0].config.model` to select the coding model for **both** variants
(the second inherits the YAML anchor). Provider `label` values are display names
only and do not select a model. The grading model is configured separately under
`defaultTest.options.provider`.

Validate the configuration and run the offline provider/grade tests without any
model calls or real Maven builds:

```sh
npx promptfoo@0.125.1 validate config
node --test evals/evals.test.cjs
```

Promptfoo runs `provider.cjs` directly: no external coding agent, SDK, or MCP
server is involved. It calls the configured model on `https://llm.apache.org/v1`
and feeds tool results back into the conversation. Tools support project file listing, reading,
exact-text replacement, writing, Maven commands, HTTPS fetches, and skill reads.
This is necessary because Promptfoo's ordinary function callbacks return tool
results as output rather than running a complete editing loop.

The model must explicitly call `finish_task` with `status: completed` or
`status: blocked` and a truthful summary. A plain-text response such as "Let me
try another approach" is progress narration: the provider asks it to continue,
rather than treating that text as completion. Three consecutive text-only turns,
more than three identical tool calls without edits, or the 80-turn budget end
the task as `incomplete`. Blocked/incomplete tasks are failed assertions, not
successful evaluations or transport errors. API/transport failures remain errors.

The two variants have identical prompts, model settings and tools:

- **With skills:** installs the complete local `skills/` directory into a private
  skill store. The system message advertises skill names/descriptions; the model
  loads instructions using `read_skill({"name":"update-sling-parent-pom"})` and
  supporting files using `read_skill_file`. Skill names are documents, not tool
  functions. The provider does not silently load a skill after an invalid call.
- **Without skills:** the skill store is empty. No global skills or coding-agent
  configuration are loaded.

Each call clones the current committed state of
`repos/sling-org-apache-sling-discovery-impl/`. The source must have no tracked or
untracked changes; ignored build outputs are not copied. The source checkout is
never reset, cleaned, staged, or edited. Each clone has its remote removed.

Four assertions grade each result:

1. **ParentUpgrade:** parses the baseline and edited `pom.xml`, requires explicit
   task completion and a strictly newer numeric release of `org.apache.sling:sling`
   or `org.apache.sling:sling-bundle-parent`. Unchanged parents, downgrades,
   snapshots, unrelated artifacts, and malformed POMs fail. This check proves a
   version increase, not that it is the latest published release.
2. **SkillUsage:** the skills variant must successfully load
   `update-sling-parent-pom`; the no-skills variant must not load any skill.
3. **UpgradeQuality:** `gemma4-26b`, through the same LiteLLM endpoint, reviews the actual diff,
   fetched sources, and final summary for upgrade quality.
   The latest applicable release and appropriate migration fixes are judged here.
4. **MavenVerify:** `maven-verify.cjs` independently executes exactly `mvn clean verify` in the
   edited clone, using the current Java environment. Exit zero is required;
   timeouts, missing workspaces, and command failures do not pass. This does not
   silently substitute `mvn21` or skip tests. If the task is blocked/incomplete
   or the parent-upgrade check fails, Maven is not run and this assertion fails
   with an explicit reason, avoiding an expensive build of an unchanged checkout.

To limit wasted tokens, HTTP results (including errors) are reused within a run,
HTML is converted to text with useful links retained, and tool messages are
capped at `toolOutputChars`. After `recentToolTurns`, older verbose tool messages
are replaced with compact excerpts; loaded skill instructions remain available.
This is not LLM-based compaction. Full tool results remain in the transcript on
disk, and the model can reread project files or retrieve a cached URL result.
The grader receives deduplicated, bounded source excerpts instead of repeated
raw HTML. These limits and the loop safeguards are configurable in the provider.

Builds run serially to avoid competing for the local Maven repository. Each
Maven command has a 20-minute timeout. Failed and successful runs retain their
edited checkout, tool transcript (`tool-calls.json`), raw model responses
(`model-responses.jsonl`), explicit completion (`completion.json`), patch, summary
and full Maven logs under
`/tmp/opencode/sling-skill-eval-*` (or `$PROMPTFOO_WORKSPACE_ROOT`). The location
is included in response metadata. Nothing is cached by the custom provider;
`--no-cache` also keeps grader results fresh.

The temporary path name does not imply an OpenCode dependency. These are local
workspace copies, **not an OS sandbox**: Maven executes project/plugin code and
HTTPS requests use the host network. Use disposable containers for untrusted
projects. Run artifacts may contain source code or fetched data; inspect them
before sharing.
