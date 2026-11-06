const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { generate: generateCommon } = require('../../generate.cjs');
const { settings } = require('../../options.cjs');
const { load, projectRoot } = require('../../shared/scenarios.cjs');
const { generate, rubric, digest } = require('./generate.cjs');
const { run, plan, args, completed, launch } = require('./run.cjs');
const { prepare, environment } = require('./prepare.cjs');
const { importSnapshot } = require('./verify.cjs');
const exec = promisify(execFile);

async function fixture(t, arm = 'with-skills') {
  const dir = await fs.mkdtemp('/tmp/opencode/sling-tessl-test-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const options = { ...settings({ EVAL_PROVIDER: 'tessl', ARM: arm }), output: dir };
  const generated = await generateCommon(options);
  return { dir, options, ...generated };
}

test('Tessl generation uses every shared prompt, pin, check and criterion without leaking answers into tasks', async (t) => {
  const { dir, manifest } = await fixture(t, 'both');
  assert.equal(manifest.scenarios.length, (await load()).scenarios.length);
  for (const scenario of manifest.scenarios) {
    const native = path.join(manifest.source, scenario.id);
    assert.equal(await fs.readFile(path.join(native, 'task.md'), 'utf8'), scenario.prompt);
    const criteria = JSON.parse(await fs.readFile(path.join(native, 'criteria.json')));
    assert.deepEqual(criteria, rubric(scenario));
    assert.deepEqual(criteria.checklist.slice(0, scenario.checks.length).map((item) => item.name), scenario.checks.map((check) => check.id));
    assert.ok(scenario.criteria.every((item) => criteria.checklist.some((native) => native.description === item.description)));
    const config = JSON.parse(await fs.readFile(path.join(native, 'scenario.json')));
    assert.deepEqual(config.include, ['./resources']);
    assert.deepEqual(config.setup, ['./init-repo.sh']);
    assert.ok((await fs.stat(path.join(native, 'init-repo.sh'))).mode & 0o111);
    assert.deepEqual(config.fixtures, {
      codebase: { type: 'commit', repoUrl: scenario.repository.url, ref: `refs/eval-fixtures/${scenario.id}`, installPath: '.' },
      java21: { type: 'directory', path: '../../toolchain', installPath: '.eval-toolchain' },
    });
    await assert.rejects(fs.access(path.join(native, 'resources', 'source.bundle')), { code: 'ENOENT' });
  }
  assert.deepEqual(manifest.variants.map((item) => item.label), ['with-skills', 'without-skills']);
  const [withSkills, withoutSkills] = manifest.variants;
  assert.equal(withSkills.agent, withoutSkills.agent);
  assert.equal(withSkills.model, withoutSkills.model);
  assert.equal(withSkills.agentMustRead, undefined);
  assert.deepEqual(withoutSkills.fixtures, { context: null });
  assert.equal(withSkills.fixtures, undefined);
  assert.equal(manifest.config.skipForcedContextActivation, true);
  assert.ok(manifest.artifacts['context/.tessl-plugin/plugin.json']);
  const plugin = JSON.parse(await fs.readFile(path.join(manifest.context, '.tessl-plugin/plugin.json')));
  assert.deepEqual(plugin.skills, ['skills/osgi-scr-migrator', 'skills/sling-release', 'skills/update-sling-parent-pom']);
  assert.equal((await exec('git', ['check-ignore', path.join(manifest.context, 'skills/update-sling-parent-pom/SKILL.md')],
    { cwd: manifest.generation }).catch((error) => ({ code: error.code }))).code, 1);
  assert.equal(await fs.readFile(path.join(manifest.context, 'skills/update-sling-parent-pom/SKILL.md'), 'utf8'),
    await fs.readFile(path.join(projectRoot, 'skills/update-sling-parent-pom/SKILL.md'), 'utf8'));
  const again = await generate({ scenarios: manifest.scenarios, arm: 'both', output: dir });
  assert.equal(again.manifest.fingerprint, manifest.fingerprint);
  assert.notEqual(again.manifest.source, manifest.source);
  const subset = await generate({ scenarios: [manifest.scenarios[0]], arm: 'with-skills', output: dir });
  assert.deepEqual(await fs.readdir(subset.manifest.source), [manifest.scenarios[0].id]);
});

test('Tessl accepts explicit single arms, uses provider-owned output and rejects unsupported settings', async (t) => {
  assert.match(settings({ EVAL_PROVIDER: 'tessl' }).output, /target\/evals\/tessl$/);
  for (const arm of ['with-skills', 'without-skills']) {
    const { manifest } = await fixture(t, arm);
    assert.deepEqual(manifest.variants.map((variant) => variant.label), [arm]);
  }
  assert.throws(() => settings({ EVAL_PROVIDER: 'tessl', RUNS: '11' }), /at most 10/);
  assert.throws(() => settings({ EVAL_PROVIDER: 'tessl', TESSL_MAX_SOLVES: '0' }), /positive integer/);
  assert.throws(() => settings({ EVAL_PROVIDER: 'tessl', REPO: 'other' }), /cannot override/);
});

test('Tessl budget, input-integrity and selection guards run before any fixture preparation or submission', async (t) => {
  const { options, manifest } = await fixture(t, 'both');
  let invoked = false;
  await assert.rejects(run(options, { invoke: () => { invoked = true; }, env: {} }), /explicit solve budget/);
  assert.equal(invoked, false);
  const count = manifest.scenarios.length * 2;
  assert.equal((await plan(options, { TESSL_MAX_SOLVES: String(count) })).solves, count);
  await assert.rejects(plan({ ...options, arm: 'with-skills' }, { TESSL_MAX_SOLVES: '100' }), /selections differ/);
  await fs.appendFile(path.join(manifest.source, manifest.scenarios[0].id, 'task.md'), '\nchanged');
  await assert.rejects(plan(options, { TESSL_MAX_SOLVES: '100' }), /input changed/);
});

async function fakeRun(t, response = { status: 'completed', runs: [{ id: 'test-run', status: 'completed' }] }, exitCode = 0) {
  const { options, manifest } = await fixture(t);
  const calls = [];
  const dependencies = { env: { TESSL_MAX_SOLVES: '100' }, prepare: async () => { calls.push(['prepare']); },
    collect: async () => { calls.push(['collect']); return { pass: true, credits: 10 }; },
    verifyContext: async () => { calls.push(['verify-context']); }, invoke: async (argv) => {
    calls.push(argv);
    if (argv[0] === '--version') return { code: 0, stdout: '0.119.0\n', stderr: '' };
    if (argv[0] === 'project') return { code: 0, stdout: JSON.stringify({ status: 'match' }), stderr: '' };
    if (argv[1] === 'lint') return { code: 0, stdout: '', stderr: '' };
    if (argv[0] === 'plugin') return { code: 0, stdout: 'Packed locally', stderr: '' };
    assert.deepEqual(argv, args(manifest, options.runs));
    return { code: exitCode, stdout: typeof response === 'string' ? response : JSON.stringify(response), stderr: 'retained diagnostics' };
  } };
  return { options, manifest, calls, dependencies };
}

test('Tessl runner submits exactly once, waits, preserves results and prevents duplicate batches across regeneration', async (t) => {
  const { options, manifest, calls, dependencies } = await fakeRun(t);
  assert.equal(await run(options, dependencies), 0);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['eval', 'lint'], ['plugin', 'pack'], ['verify-context'], ['prepare'], ['project', 'repair'], ['--version'], ['eval', 'run'], ['collect']]);
  const nativeArgs = calls.find((args) => args[0] === 'eval' && args[1] === 'run');
  assert.ok(nativeArgs.includes('--variant-json'));
  assert.ok(nativeArgs.includes('--wait'));
  assert.ok(nativeArgs.includes('--json'));
  assert.ok(nativeArgs.includes('--skip-forced-context-activation'));
  assert.ok(nativeArgs.includes('--env-file'));
  assert.match(await fs.readFile(path.join(manifest.generation, 'runtime.env'), 'utf8'), /JAVA_HOME=\/workspace\/solution\/\.eval-toolchain\/runtime\/jdk-21/);
  for (const flag of ['--force', '--skip-baseline', '--quality-check', '--yes']) assert.ok(!nativeArgs.includes(flag));
  assert.equal(JSON.parse(await fs.readFile(path.join(manifest.generation, 'result.json'))).status, 'completed');
  await generateCommon(options);
  await assert.rejects(run(options, dependencies), /already attempted/);
  assert.equal(calls.filter((args) => args[1] === 'run').length, 1);
});

test('Tessl never treats detached, timed out, failed or malformed responses as completed and never retries', async (t) => {
  for (const [response, exitCode] of [[{ runs: [{ status: 'pending' }] }, 0], [{ status: 'failed' }, 1], ['not JSON', 0], [{}, 0]]) {
    const { options, dependencies, calls } = await fakeRun(t, response, exitCode);
    assert.equal(await run(options, dependencies), 1);
    await assert.rejects(run(options, dependencies), /already attempted/);
    assert.equal(calls.filter((args) => args[1] === 'run').length, 1);
  }
  assert.equal(completed({ status: 'completed', runs: [{ status: 'running' }] }), false);
});

test('Tessl preflight failures do not submit; unknown submission outcomes remain protected', async (t) => {
  for (const phase of ['lint', 'pack', 'prepare', 'repair', 'run']) {
    const { options, dependencies, calls, manifest } = await fakeRun(t);
    const invoke = dependencies.invoke;
    if (phase === 'prepare') dependencies.prepare = async () => { throw new Error('test preparation failure'); };
    else dependencies.invoke = async (args) => {
      if (args[1] === phase) { calls.push(args); throw new Error(`test ${phase} failure`); }
      return invoke(args);
    };
    await assert.rejects(run(options, dependencies), /test .*failure/);
    if (phase !== 'run') assert.equal(calls.filter((args) => args[1] === 'run').length, 0);
    else {
      const file = (await fs.readdir(path.join(options.output, 'submissions')))[0];
      assert.equal(JSON.parse(await fs.readFile(path.join(options.output, 'submissions', file))).state, 'submission-outcome-unknown');
      await assert.rejects(run(options, dependencies), /already attempted/);
    }
    await assert.rejects(fs.access(path.join(manifest.generation, 'result.json')), { code: 'ENOENT' });
  }
});

test('a remote SETUP_FAILED response blocks further spending even after changing generation or arms', async (t) => {
  const response = [{ evalRunId: 'native-failed-run', status: 'failed', failure: {
    kind: 'EVAL_PARTIAL_FAILURE', reasons: [{ kind: 'SETUP_FAILED', count: 5 }] } }];
  const { options, dependencies, calls } = await fakeRun(t, response, 1);
  assert.equal(await run(options, dependencies), 1);
  const changed = { ...options, arm: 'without-skills' };
  await generateCommon(changed);
  await assert.rejects(run(changed, dependencies), /submissions are blocked/);
  assert.equal(calls.filter((args) => args[1] === 'run').length, 1);
  const record = JSON.parse(await fs.readFile(path.join(options.output, 'remote-setup-block.json')));
  assert.deepEqual(record.evalRunIds, ['native-failed-run']);
});

test('Tessl fixture packaging rehearses real bundle/include/setup semantics without network or model calls', async (t) => {
  const root = await fs.mkdtemp(path.join(projectRoot, 'repos', '.sling-tessl-fixture-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const git = async (args, cwd = source) => (await exec('git', args, { cwd })).stdout.trim();
  await git(['init', '--quiet']);
  await git(['remote', 'add', 'origin', 'https://github.com/apache/fixture.git']);
  await fs.writeFile(path.join(source, '.gitignore'), '.tokensave/\n');
  await fs.writeFile(path.join(source, 'pom.xml'), '<project><parent><groupId>org.apache.sling</groupId><artifactId>sling</artifactId><version>34</version></parent></project>\n');
  await git(['add', '.']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture']);
  const revision = await git(['rev-parse', 'HEAD']);
  const scenario = structuredClone((await load()).scenarios[0]);
  scenario.repository = { url: 'https://github.com/apache/fixture.git', revision, local_path: path.relative(projectRoot, source) };
  scenario.fixture.setup = [{ type: 'git_apply', patch: 'diff --git a/prepared.txt b/prepared.txt\nnew file mode 100644\n--- /dev/null\n+++ b/prepared.txt\n@@ -0,0 +1 @@\n+fixture setup\n' }];
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  for (const [name, text] of [['java', 'openjdk version "21.0.13"'], ['mvn', 'Apache Maven 3.10.0\nJava version: 21.0.13']]) {
    await fs.writeFile(path.join(bin, name), `#!${process.execPath}\nconsole.log(${JSON.stringify(text)});\n`, { mode: 0o755 });
  }
  const original = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${original}`;
  t.after(() => { process.env.PATH = original; });
  const { manifest } = await generate({ scenarios: [scenario], arm: 'with-skills', output: path.join(root, 'generated') });
  const toolchain = async () => {
    const dir = path.join(manifest.generation, 'toolchain');
    await fs.writeFile(path.join(dir, 'jdk.tar.gz'), 'Not needed on the preinstalled-Java-21 test path');
    return dir;
  };
  const first = (await prepare(manifest, { toolchain }))[0];
  const second = (await prepare(manifest, { toolchain }))[0];
  for (const item of [first, second]) t.after(() => fs.rm(item.runDir, { recursive: true, force: true }));
  assert.equal(first.baselineCommit, second.baselineCommit);
  assert.notEqual(first.baselineCommit, revision);
  assert.equal(first.nativeFixture.revision, first.baselineCommit);
  assert.equal(await git(['rev-parse', first.nativeFixture.ref], manifest.generation), first.baselineCommit);
  assert.equal(await git(['rev-parse', 'HEAD'], first.rehearsal), first.baselineCommit);
  assert.equal(await fs.readFile(path.join(first.rehearsal, 'prepared.txt'), 'utf8'), 'fixture setup\n');
  assert.equal(await git(['status', '--porcelain'], first.rehearsal), '');
  assert.equal(await git(['rev-parse', 'HEAD']), revision);
  await assert.rejects(fs.access(path.join(source, 'prepared.txt')), { code: 'ENOENT' });
  const native = path.join(manifest.source, scenario.id, 'init-repo.sh');
  await assert.rejects(exec('sh', [native], { cwd: first.rehearsal,
    env: { ...process.env, EVAL_RUNTIME_ROOT: first.runtimeRoot } }), /Refusing to overwrite/);
  await assert.rejects(fs.access(path.join(first.rehearsal, 'resources')), { code: 'ENOENT' });
  // Rehearse a platform that initializes a Git repo before installing includes.
  const platform = path.join(root, 'platform-sandbox');
  await fs.mkdir(platform);
  await fs.cp(path.join(manifest.source, scenario.id, 'resources'), path.join(platform, 'resources'), { recursive: true });
  await git(['init', '--quiet'], platform);
  const platformRuntime = path.join(root, 'platform-runtime');
  await exec('sh', [native], { cwd: platform, env: { ...process.env, EVAL_RUNTIME_ROOT: platformRuntime } });
  assert.equal(await git(['rev-parse', 'HEAD'], platform), first.baselineCommit);
  assert.ok((await fs.stat(path.join(platform, '.git'))).isDirectory());
  // A native commit fixture has tracked source files and a synthetic commit,
  // unlike the empty platform repository above. Moving its .git would make the
  // checkout fail with "untracked working tree files would be overwritten".
  const populated = path.join(root, 'populated-sandbox');
  await fs.mkdir(populated);
  await fs.writeFile(path.join(populated, '.gitignore'), '.tokensave/\n');
  await fs.writeFile(path.join(populated, 'pom.xml'), await fs.readFile(path.join(source, 'pom.xml')));
  await fs.writeFile(path.join(populated, 'prepared.txt'), 'fixture setup\n');
  await fs.cp(path.join(manifest.source, scenario.id, 'resources'), path.join(populated, 'resources'), { recursive: true });
  await fs.mkdir(path.join(populated, '.eval-toolchain'));
  await fs.writeFile(path.join(populated, '.eval-toolchain/input-marker'), 'SDK fixture\n');
  await fs.mkdir(path.join(populated, '.claude/skills/fixture-skill'), { recursive: true });
  await fs.writeFile(path.join(populated, '.claude/skills/fixture-skill/SKILL.md'), 'Native context\n');
  await git(['init', '--quiet'], populated);
  await git(['add', '.'], populated);
  await git(['-c', 'user.name=Native Fixture', '-c', 'user.email=native@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'Native fixture snapshot'], populated);
  const nativeHead = await git(['rev-parse', 'HEAD'], populated);
  const populatedRuntime = path.join(root, 'populated-runtime');
  await exec('sh', [native], { cwd: populated, env: { ...process.env, EVAL_RUNTIME_ROOT: populatedRuntime } });
  assert.equal(await git(['rev-parse', 'HEAD'], populated), first.baselineCommit);
  assert.equal(await git(['status', '--porcelain', '--untracked-files=no'], populated), '');
  assert.equal(await fs.readFile(path.join(populated, '.eval-toolchain/input-marker'), 'utf8'), 'SDK fixture\n');
  assert.equal(await fs.readFile(path.join(populated, '.claude/skills/fixture-skill/SKILL.md'), 'utf8'), 'Native context\n');
  assert.equal(await git(['cat-file', '-t', nativeHead], populated), 'commit');
  assert.equal((await fs.readFile(path.join(populatedRuntime, 'fixture/native-baseline.txt'), 'utf8')).trim(), nativeHead);
  // An index-only baseline import must still reject mismatched source content,
  // without checking it out over the differing file.
  const mismatched = path.join(root, 'mismatched-sandbox');
  await git(['clone', '--quiet', '--no-local', first.rehearsal, mismatched], root);
  const changedPom = (await fs.readFile(path.join(mismatched, 'pom.xml'), 'utf8')).replace('34', '35');
  await fs.writeFile(path.join(mismatched, 'pom.xml'), changedPom);
  await fs.cp(path.join(manifest.source, scenario.id, 'resources'), path.join(mismatched, 'resources'), { recursive: true });
  await git(['add', '--all'], mismatched);
  await git(['-c', 'user.name=Native Fixture', '-c', 'user.email=native@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'Mismatched native snapshot'], mismatched);
  const mismatchedHead = await git(['rev-parse', 'HEAD'], mismatched);
  await assert.rejects(exec('sh', [native], { cwd: mismatched, env: { ...process.env,
    EVAL_RUNTIME_ROOT: path.join(root, 'mismatched-runtime') } }));
  assert.equal(await fs.readFile(path.join(mismatched, 'pom.xml'), 'utf8'), changedPom);
  assert.equal(await git(['rev-parse', 'HEAD'], mismatched), mismatchedHead);
});

test('Tessl secrets never enter repository/build child environments', () => {
  assert.deepEqual(environment({ PATH: '/bin', JAVA_HOME: '/jdk21', TESSL_TOKEN: 'secret', TESSL_ORG: 'private',
    LITELLM_API_KEY: 'secret', GIT_DIR: '/other', MAVEN_REPOSITORY_TOKEN: 'maven' }), {
    PATH: '/bin', JAVA_HOME: '/jdk21', MAVEN_REPOSITORY_TOKEN: 'maven' });
});

test('independent verification imports full snapshots including deletions, not downloaded Git or stale outputs', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/sling-tessl-import-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'snapshot'), destination = path.join(root, 'verification-clone');
  await fs.mkdir(source);
  await fs.mkdir(destination);
  const git = (args) => exec('git', args, { cwd: destination });
  await git(['init', '--quiet']);
  await fs.writeFile(path.join(destination, 'deleted.txt'), 'original');
  await fs.writeFile(path.join(destination, 'changed.txt'), 'original');
  await git(['add', '.']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-gpg-sign', '-m', 'baseline']);
  const before = (await git(['rev-parse', 'HEAD'])).stdout;
  await fs.writeFile(path.join(source, 'changed.txt'), 'edited');
  await fs.writeFile(path.join(source, 'new.txt'), 'new');
  await fs.mkdir(path.join(source, '.git'));
  await fs.writeFile(path.join(source, '.git/config'), 'untrusted');
  await fs.mkdir(path.join(source, 'target'));
  await fs.writeFile(path.join(source, 'target/stale'), 'stale');
  await fs.mkdir(path.join(source, '.eval-toolchain'));
  await fs.symlink('/etc', path.join(source, '.eval-toolchain/not-project-code'));
  await importSnapshot(source, destination);
  assert.equal((await git(['rev-parse', 'HEAD'])).stdout, before);
  assert.equal(await fs.readFile(path.join(destination, 'changed.txt'), 'utf8'), 'edited');
  assert.equal(await fs.readFile(path.join(destination, 'new.txt'), 'utf8'), 'new');
  await assert.rejects(fs.access(path.join(destination, 'deleted.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(destination, 'target')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(destination, '.eval-toolchain')), { code: 'ENOENT' });
  await assert.rejects(importSnapshot(source, source), /must be separate/);
  await fs.symlink('/etc', path.join(source, 'escape'));
  await assert.rejects(importSnapshot(source, destination), /Unsafe solution path/);
});

test('rootless runtime bootstrap checks the pinned archive and persists Java 21 without apt or sudo', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/sling-tessl-runtime-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), input = path.join(root, 'input/jdk/bin');
  await fs.mkdir(bin);
  await fs.mkdir(input, { recursive: true });
  await fs.mkdir(path.join(root, 'resources'));
  await fs.mkdir(path.join(root, '.eval-toolchain'));
  await fs.writeFile(path.join(input, 'java'), `#!${process.execPath}\nconsole.error('openjdk version "21.0.13"');\n`, { mode: 0o755 });
  const script = async (name, body) => fs.writeFile(path.join(bin, name), `#!${process.execPath}\n` +
    `const fs=require('node:fs'),path=require('node:path');\n${body}\n`, { mode: 0o755 });
  await script('sudo', "throw new Error('sudo must never be invoked');");
  await script('apt-get', "throw new Error('apt must never be invoked');");
  await script('java', `console.error('openjdk version "25.0.1"');`);
  await script('mvn', "console.log('Apache Maven 3.9.12\\nJava version: '+(fs.existsSync(path.join(process.env.JAVA_HOME,'bin/java'))?'21.0.13':'25.0.1'));");
  const archive = path.join(root, '.eval-toolchain/jdk.tar.gz');
  await exec('tar', ['-czf', archive, '-C', path.join(root, 'input'), 'jdk']);
  await fs.writeFile(path.join(root, '.eval-toolchain/sha256.txt'), digest(await fs.readFile(archive)) + '\n');
  const runtimeRoot = path.join(root, 'installed');
  const env = { ...process.env, EVAL_RUNTIME_ROOT: runtimeRoot, JAVA_HOME: path.join(runtimeRoot, 'jdk-21'),
    PATH: `${runtimeRoot}/bin:${runtimeRoot}/jdk-21/bin:${bin}${path.delimiter}${process.env.PATH}` };
  const runtime = path.join(__dirname, 'runtime.sh');
  await exec('sh', [runtime], { cwd: root, env });
  assert.match(await fs.readFile(path.join(runtimeRoot, 'bin/mvn'), 'utf8'), /export JAVA_HOME=.*jdk-21/);
  assert.match(await fs.readFile(path.join(root, 'resources/environment.txt'), 'utf8'), /Java version: 21\./);
  await fs.writeFile(archive, 'corrupted input');
  const badRoot = path.join(root, 'bad-runtime');
  await assert.rejects(exec('sh', [runtime], { cwd: root, env: { ...env, EVAL_RUNTIME_ROOT: badRoot,
    JAVA_HOME: path.join(badRoot, 'jdk-21'), PATH: `${bin}${path.delimiter}${process.env.PATH}` } }));
});

test('native CLI transport retains complete UTF-8 output and diagnostics with real subprocess exit codes', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/sling-tessl-cli-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'tessl'), `#!${process.execPath}\n` +
    `const b=Buffer.from(JSON.stringify({status:'completed',text:'résumé'}));\n` +
    `for(const byte of b) process.stdout.write(Buffer.from([byte]));\nprocess.stderr.write('test diagnostics\\n');\nprocess.exitCode=7;\n`, { mode: 0o755 });
  const original = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${original}`;
  t.after(() => { process.env.PATH = original; });
  const stdoutFile = path.join(root, 'stdout.json'), stderrFile = path.join(root, 'stderr.log');
  const result = await launch(['test-only'], { stdoutFile, stderrFile });
  assert.equal(result.code, 7);
  assert.equal(JSON.parse(result.stdout).text, 'résumé');
  assert.equal(await fs.readFile(stdoutFile, 'utf8'), result.stdout);
  assert.equal(await fs.readFile(stderrFile, 'utf8'), result.stderr);
  await assert.rejects(launch(['test-only'], { stdoutFile, stderrFile }), { code: 'EEXIST' });
});
