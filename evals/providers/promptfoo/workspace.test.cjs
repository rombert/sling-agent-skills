const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { prepare, result } = require('./workspace.cjs');
const grade = require('./assertions/maven-verify.cjs');
const parentGrade = require('./assertions/parent-upgrade.cjs');
const skillGrade = require('./assertions/skill-usage.cjs');
const { run: runProcess, tail } = require('../../shared/process.cjs');
const { childEnvironment } = require('./environment.cjs');
const run = (command, args, options) => runProcess(command, args, { ...options, env: childEnvironment() });
const { toolKey } = require('./tool-key.cjs');

const exec = promisify(execFile);
const { projectRoot } = require('../../shared/scenarios.cjs');
const reposRoot = path.join(projectRoot, 'repos');
const restoredEnvs = new WeakMap();

test('tool repetition keys normalize nested object keys but preserve array order', () => {
  assert.equal(toolKey('read', { path: 'pom.xml', options: { end: 4, start: 1 } }),
    toolKey('read', { options: { start: 1, end: 4 }, path: 'pom.xml' }));
  assert.notEqual(toolKey('bash', { args: ['a', 'b'] }), toolKey('bash', { args: ['b', 'a'] }));
});
const pom = (version = '52', artifact = 'sling-bundle-parent', group = 'org.apache.sling') =>
  `<project><parent><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version></parent></project>\n`;

function setEnv(t, name, value) {
  if (!restoredEnvs.has(t)) restoredEnvs.set(t, new Set());
  const restored = restoredEnvs.get(t);
  if (!restored.has(name)) {
    restored.add(name);
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function fixture(t) {
  await fs.mkdir(reposRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(reposRoot, '.sling-eval-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  setEnv(t, 'PROMPTFOO_REPO', undefined);
  setEnv(t, 'PROMPTFOO_WORKSPACE_ROOT', path.join(root, 'runs'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await exec('git', ['init', '--quiet', source]);
  await fs.writeFile(path.join(source, 'pom.xml'), pom());
  // The local code-index daemon can discover these disposable repositories.
  // Ignore only its generated metadata in test fixtures, not real user changes.
  await fs.writeFile(path.join(source, '.gitignore'), 'target/\n.tokensave/\n');
  await exec('git', ['add', '.'], { cwd: source });
  await exec('git', ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture'], { cwd: source });
  const config = {
    working_dir: source,
    skills_dir: './skills',
    install_skills: true,
    mavenTimeoutMs: 2000,
  };
  return { root, source, config };
}

test('each call gets a fresh clone and ignored build outputs are not copied', async (t) => {
  const { source, config } = await fixture(t);
  await fs.mkdir(path.join(source, 'target'));
  await fs.writeFile(path.join(source, 'target', 'stale.txt'), 'stale');
  const first = await prepare(config);
  await fs.writeFile(path.join(first.workingDir, 'pom.xml'), 'changed');
  const second = await prepare(config);
  assert.notEqual(first.workingDir, second.workingDir);
  assert.equal(first.baselineCommit, second.baselineCommit);
  assert.match(await fs.readFile(path.join(second.workingDir, 'pom.xml'), 'utf8'), /<version>52/);
  await assert.rejects(fs.stat(path.join(second.workingDir, 'target')), { code: 'ENOENT' });
  assert.equal((await exec('git', ['remote'], { cwd: second.workingDir })).stdout, '');
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: source })).stdout, '');
});

test('workspace requires a Git repository strictly below repos, not a prefix lookalike or project subdirectory', async (t) => {
  const { root, source, config } = await fixture(t);
  for (const working_dir of [undefined, null, '', ' ', 42, 'repos', reposRoot, projectRoot,
    'repos/..', `${reposRoot}-outside/source`, '/tmp/opencode']) {
    await assert.rejects(prepare({ ...config, working_dir }), /subdirectory of repos/);
  }
  await fs.mkdir(path.join(source, 'nested'));
  await assert.rejects(prepare({ ...config, working_dir: path.join(source, 'nested') }), /root of a Git repository/);
  await assert.rejects(prepare({ ...config, working_dir: root }), /root of a Git repository/);
  for (const working_dir of [path.relative(projectRoot, source), `${path.relative(projectRoot, source)}/../source`]) {
    const state = await prepare({ ...config, working_dir });
    assert.equal(state.repository.directory, path.relative(projectRoot, source));
  }
});

test('workspace rejects symlink escapes but accepts aliases to repositories inside repos', async (t) => {
  const { root, source, config } = await fixture(t);
  const outside = await fs.mkdtemp('/tmp/opencode/sling-outside-repos-test-');
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await exec('git', ['clone', '--quiet', '--no-local', source, path.join(outside, 'source')]);
  const escape = path.join(root, 'escape');
  await fs.symlink(path.join(outside, 'source'), escape);
  await assert.rejects(prepare({ ...config, working_dir: escape }), /subdirectory of repos.*symlinks/);
  const alias = path.join(root, 'alias');
  await fs.symlink(source, alias);
  const state = await prepare({ ...config, working_dir: alias });
  assert.equal(state.repository.directory, path.relative(projectRoot, source));
});

test('repository override selects the checkout and records origin name and its exact revision before editing', async (t) => {
  const { root, source, config } = await fixture(t);
  const selected = path.join(root, 'different checkout');
  await exec('git', ['clone', '--quiet', '--no-local', source, selected]);
  await fs.writeFile(path.join(selected, 'marker.txt'), 'selected repository\n');
  await exec('git', ['add', '.'], { cwd: selected });
  await exec('git', ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'selected'], { cwd: selected });
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: selected })).stdout.trim();
  assert.notEqual(revision, (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim());
  setEnv(t, 'PROMPTFOO_REPO', path.relative(projectRoot, selected));
  for (const origin of ['https://github.com/apache/selected-module.git', 'git@github.com:apache/selected-module.git',
    'https://github.com/apache/selected-module/']) {
    await exec('git', ['remote', 'set-url', 'origin', origin], { cwd: selected });
    const state = await prepare(config);
    assert.deepEqual(state.repository, { name: 'selected-module', revision, directory: path.relative(projectRoot, selected) });
    assert.equal(state.baselineCommit, revision);
    assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: state.workingDir })).stdout.trim(), revision);
    assert.equal(await fs.readFile(path.join(state.workingDir, 'marker.txt'), 'utf8'), 'selected repository\n');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(state.runDir, 'repository.json'))), state.repository);
  }
  setEnv(t, 'PROMPTFOO_REPO', '');
  await assert.rejects(prepare(config), /must name a repository subdirectory/);
  setEnv(t, 'PROMPTFOO_REPO', '/tmp/opencode');
  await assert.rejects(prepare(config), /subdirectory of repos/);
});

test('workspace copies all skills privately and the no-skills arm needs no skill directory', async (t) => {
  const { config } = await fixture(t);
  const state = await prepare(config);
  assert.deepEqual(state.skills.map((skill) => skill.name).sort(),
    ['osgi-scr-migrator', 'sling-release', 'update-sling-parent-pom']);
  for (const skill of state.skills) {
    assert.deepEqual(Object.keys(skill).sort(), ['directory', 'name']);
    assert.equal(skill.directory, path.join(state.runDir, 'skills', skill.name));
    assert.equal(await fs.readFile(path.join(skill.directory, 'SKILL.md'), 'utf8'),
      await fs.readFile(path.join(config.skills_dir, skill.name, 'SKILL.md'), 'utf8'));
  }
  const baseline = await prepare({ ...config, install_skills: false, skills_dir: '/does/not/exist' });
  assert.deepEqual(baseline.skills, []);
  await assert.rejects(fs.stat(path.join(baseline.runDir, 'skills')), { code: 'ENOENT' });
});

test('workspace rejects skill directories missing SKILL.md', async (t) => {
  const { root, config } = await fixture(t);
  const skills_dir = path.join(root, 'invalid-skills');
  await fs.mkdir(path.join(skills_dir, 'missing-instructions'), { recursive: true });
  await assert.rejects(prepare({ ...config, skills_dir }), { code: 'ENOENT' });
});

test('workspace result retains actual edits, new files, skill reads and bounded shell evidence', async (t) => {
  const { source, config } = await fixture(t);
  const state = await prepare(config);
  state.completion = { status: 'completed', summary: 'Upgraded the parent.' };
  await fs.writeFile(path.join(state.workingDir, 'pom.xml'), pom('99'));
  await fs.mkdir(path.join(state.workingDir, 'src'));
  await fs.writeFile(path.join(state.workingDir, 'src', 'new.txt'), 'new file\n');
  const command = 'curl https://example.invalid/metadata';
  const toolCalls = [
    { name: 'read', input: { path: 'pom.xml' }, output: 'not reference material' },
    { name: 'bash', input: { command }, output: 'old result' },
    { name: 'bash', input: { command }, output: 'Release 99 ' + 'x'.repeat(5000) },
    { name: 'bash', input: { command: 'wget https://example.invalid/missing' }, is_error: true, output: '404' },
    { name: 'bash', input: { command: 'git diff --stat' }, output: '1 file changed' },
  ];
  const skillCalls = [{ name: 'update-sling-parent-pom', is_error: false }, { name: 'other', is_error: true }];
  const response = await result(state, { toolCalls, skillCalls, turns: 4, tokenUsage: { total: 48 }, harness: 'pi' });
  const output = JSON.parse(response.output);
  assert.equal(response.cached, false);
  assert.equal(response.tokenUsage.total, 48);
  assert.equal(output.status, 'completed');
  assert.equal(output.finalParent.version, '99');
  const repository = { name: 'source', revision: state.baselineCommit, directory: path.relative(projectRoot, source) };
  assert.deepEqual(output.repository, repository);
  assert.deepEqual(response.metadata.repository, repository);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(state.runDir, 'repository.json'))), repository);
  assert.deepEqual(output.loadedSkills, ['update-sling-parent-pom']);
  assert.match(output.diff, /\+.*<version>99/);
  assert.match(output.diff, /src\/new.txt/);
  assert.equal(output.sources.length, 2);
  assert.equal(output.sources[0].command, command);
  assert.match(output.sources[0].output, /Release 99/);
  assert.match(output.sources[0].output, /truncated/);
  assert.ok(output.sources[0].output.length < 4500);
  assert.equal(output.sources[1].is_error, true);
  assert.deepEqual(output.gitActions, { count: 1, truncated: false, commands: [{ command: 'git diff --stat', is_error: false }] });
  assert.equal(await fs.readFile(path.join(state.runDir, 'changes.patch'), 'utf8'), response.metadata.workspaceDiff);
  assert.equal(await fs.readFile(path.join(state.runDir, 'summary.txt'), 'utf8'), state.completion.summary);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(state.runDir, 'completion.json'))), state.completion);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(state.runDir, 'tool-calls.json'))), toolCalls);
  assert.match(await fs.readFile(path.join(source, 'pom.xml'), 'utf8'), /<version>52/);
  await assert.rejects(fs.stat(path.join(source, 'src', 'new.txt')), { code: 'ENOENT' });
});

test('dirty source is rejected without modifying user work', async (t) => {
  const { source, config } = await fixture(t);
  await fs.writeFile(path.join(source, 'local.txt'), 'user work');
  await assert.rejects(prepare(config), /must be clean/);
  assert.equal(await fs.readFile(path.join(source, 'local.txt'), 'utf8'), 'user work');
  await fs.unlink(path.join(source, 'local.txt'));
  await fs.writeFile(path.join(source, 'pom.xml'), 'uncommitted changes');
  await assert.rejects(prepare(config), /must be clean/);
  assert.equal(await fs.readFile(path.join(source, 'pom.xml'), 'utf8'), 'uncommitted changes');
});

test('Maven grader checks exit status in the edited workspace, not model text', async (t) => {
  const { root, source, config } = await fixture(t);
  const state = await prepare(config);
  state.completion = { status: 'completed', summary: 'Upgraded.' };
  await fs.writeFile(path.join(state.workingDir, 'pom.xml'), pom('99'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'mvn'), `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), key: process.env.LITELLM_API_KEY }));\n` +
    `console.log('Fake Maven log'); process.exit(Number(process.env.TEST_MAVEN_EXIT || 0));\n`, { mode: 0o755 });
  setEnv(t, 'PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  setEnv(t, 'LITELLM_API_KEY', 'must-not-reach-maven');
  setEnv(t, 'TEST_MAVEN_EXIT', '0');
  const context = { providerResponse: { metadata: state } };
  assert.equal((await grade('The build failed!', context)).pass, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(state.workingDir, 'invocation.json'), 'utf8')), { args: ['clean', 'verify'] });
  await assert.rejects(fs.stat(path.join(source, 'invocation.json')), { code: 'ENOENT' });
  setEnv(t, 'TEST_MAVEN_EXIT', '1');
  const failed = await grade('BUILD SUCCESS', context);
  assert.equal(failed.pass, false);
  assert.match(failed.reason, /exited 1/);
  assert.match(failed.reason, /Fake Maven log/);
  assert.equal((await grade('BUILD SUCCESS', {})).pass, false);
  setEnv(t, 'PATH', bin);
  await fs.unlink(path.join(bin, 'mvn'));
  assert.equal((await grade('BUILD SUCCESS', context)).pass, false);
});

test('long-running commands time out and retain their logs', async (t) => {
  const { root } = await fixture(t);
  const log = path.join(root, 'timeout.log');
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: root, log, timeoutMs: 100,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.ok(await fs.stat(log));
});

test('process helpers retain stdout/stderr, bound log tails and strip model/Git environment', async (t) => {
  const { root } = await fixture(t);
  const log = path.join(root, 'process.log');
  setEnv(t, 'LITELLM_API_KEY', 'must-not-reach-child');
  setEnv(t, 'GIT_DIR', '/does/not/exist');
  const result = await run(process.execPath, ['-e',
    'console.log(JSON.stringify({ cwd: process.cwd(), key: process.env.LITELLM_API_KEY, git: process.env.GIT_DIR }));' +
    'console.log("x".repeat(14000)); process.stderr.write("end");'], { cwd: root, log });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  const full = await fs.readFile(log, 'utf8');
  assert.deepEqual(JSON.parse(full.split('\n')[0]), { cwd: root });
  assert.ok(full.length > 14000);
  assert.equal((await tail(log)).length, 12000);
  assert.equal(await tail(log, 3), 'end');
});

test('process helper cancels commands without reporting a timeout', async (t) => {
  const { root } = await fixture(t);
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: root, log: path.join(root, 'aborted.log'), signal: AbortSignal.timeout(100),
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGKILL');
});

test('parent assertion reads actual XML and rejects unchanged, downgraded, snapshot and unrelated parents', async (t) => {
  const { config } = await fixture(t);
  const metadata = await prepare(config);
  metadata.completion = { status: 'completed', summary: 'Trust me!' };
  const context = { providerResponse: { metadata } };
  for (const invalid of [pom(), pom('51'), pom('66-SNAPSHOT'), pom('99', 'unrelated'), pom('99', 'sling', 'other.group')]) {
    await fs.writeFile(path.join(metadata.workingDir, 'pom.xml'), invalid);
    assert.equal((await parentGrade('Claimed upgrade', context)).pass, false);
  }
  await fs.writeFile(path.join(metadata.workingDir, 'pom.xml'),
    `<?xml version="1.0"?><project xmlns="http://maven.apache.org/POM/4.0.0"><!-- <parent><version>1000</version></parent> --><parent><groupId>org.apache.sling</groupId><artifactId>sling</artifactId><version>66</version></parent></project>`);
  assert.equal((await parentGrade('', context)).pass, true);
  metadata.completion.status = 'blocked';
  assert.equal((await parentGrade('', context)).pass, false);
  metadata.completion.status = 'completed';
  await fs.writeFile(path.join(metadata.workingDir, 'pom.xml'), '<project><build><parent><version>999</version></parent></build></project>');
  assert.equal((await parentGrade('', context)).pass, false);
});

test('completed-without-edits cannot trigger a successful baseline Maven build', async (t) => {
  const { config } = await fixture(t);
  const metadata = await prepare(config);
  metadata.completion = { status: 'completed', summary: 'Done!' };
  const verification = await grade('', { providerResponse: { metadata } });
  assert.equal(verification.pass, false);
  assert.match(verification.reason, /Parent was not upgraded/);
  await assert.rejects(fs.stat(path.join(metadata.runDir, 'maven-verify.log')), { code: 'ENOENT' });
});

test('blocked and incomplete tasks cannot trigger Maven verification even after an upgrade', async (t) => {
  const { config } = await fixture(t);
  const metadata = await prepare(config);
  await fs.writeFile(path.join(metadata.workingDir, 'pom.xml'), pom('99'));
  for (const status of ['blocked', 'incomplete']) {
    metadata.completion = { status, summary: 'Unable to finish.' };
    const verification = await grade('BUILD SUCCESS', { providerResponse: { metadata } });
    assert.equal(verification.pass, false);
    assert.match(verification.reason, /Maven not run: Task did not complete/);
    await assert.rejects(fs.stat(path.join(metadata.runDir, 'maven-verify.log')), { code: 'ENOENT' });
  }
});

test('skill assertion requires successful relevant skill reads only in the skills arm', () => {
  const check = (metadata) => skillGrade('', { providerResponse: { metadata } }).pass;
  assert.equal(check(undefined), false);
  for (const skillCalls of [[], [{ name: 'update-sling-parent-pom', is_error: true }], [{ name: 'other-skill' }]]) {
    assert.equal(check({ skillsInstalled: true, skillCalls }), false);
  }
  assert.equal(check({ skillsInstalled: true, skillCalls: [{ name: 'update-sling-parent-pom' }] }), true);
  assert.equal(check({ skillsInstalled: false, skillCalls: [] }), true);
  assert.equal(check({ skillsInstalled: false, skillCalls: [{ name: 'any-skill', is_error: true }] }), true);
  assert.equal(check({ skillsInstalled: false, skillCalls: [{ name: 'any-skill' }] }), false);
});
