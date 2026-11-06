const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validate, projectRoot } = require('./scenarios.cjs');
const { readParent } = require('./parent-upgrade.cjs');
const { childEnvironment } = require('./process.cjs');

const exec = promisify(execFile);
const git = async (cwd, args, env) => (await exec('git', args, {
  cwd, env: childEnvironment(env), timeout: 120000, maxBuffer: 20 * 1024 * 1024,
})).stdout.trim();
const within = (root, directory) => directory.startsWith(root + path.sep);

async function runtime(javaMajor, { env } = {}) {
  const java = await exec('java', ['-version'], { env: childEnvironment(env), timeout: 10000 });
  const version = java.stdout + java.stderr;
  const major = Number(version.match(/version "(?:1\.)?(\d+)/)?.[1]);
  if (major !== javaMajor) throw new Error(`Scenario requires Java ${javaMajor}, got ${major || version.trim()}. Set JAVA_HOME and PATH before running`);
  const maven = await exec('mvn', ['-version'], { env: childEnvironment(env), timeout: 10000 });
  // Maven and java must run on the same JDK, not a wrapper-selected newer JDK.
  if (!new RegExp(`Java version: ${javaMajor}\\.`).test(maven.stdout + maven.stderr)) {
    throw new Error(`Maven must run on Java ${javaMajor}; check JAVA_HOME and PATH`);
  }
  return { java: version.trim(), maven: (maven.stdout + maven.stderr).trim() };
}

async function prepareFixture(scenario, runDir, { env } = {}) {
  const runGit = (cwd, args) => git(cwd, args, env);
  validate(scenario);
  const versions = await runtime(scenario.environment.java_major, { env });
  await fs.writeFile(path.join(runDir, 'environment.json'), JSON.stringify(versions, null, 2));
  await fs.writeFile(path.join(runDir, 'scenario.json'), JSON.stringify(scenario, null, 2));
  const workingDir = path.join(runDir, 'project');
  let source = scenario.repository.url;
  if (scenario.repository.local_path) {
    const root = await fs.realpath(path.join(projectRoot, 'repos'));
    source = await fs.realpath(path.resolve(projectRoot, scenario.repository.local_path));
    if (!within(root, source) || await runGit(source, ['rev-parse', '--show-toplevel']) !== source) {
      throw new Error('Fixture local_path must resolve to a repository root strictly below repos');
    }
    if (await runGit(source, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('The source repository must be clean');
    const normalize = (url) => url.replace(/\.git$/, '').replace(/\/$/, '');
    if (normalize(await runGit(source, ['remote', 'get-url', 'origin'])) !== normalize(scenario.repository.url)) {
      throw new Error('Fixture local_path origin does not match the scenario repository');
    }
  }
  await runGit(runDir, ['clone', '--quiet', '--no-checkout', '--no-local', '--no-hardlinks',
    '-c', 'core.autocrlf=false', source, workingDir]);
  await runGit(workingDir, ['checkout', '--quiet', '--detach', scenario.repository.revision]);
  if (await runGit(workingDir, ['rev-parse', 'HEAD']) !== scenario.repository.revision) throw new Error('Fixture revision mismatch');
  await runGit(workingDir, ['remote', 'remove', 'origin']);
  const initialParent = await readParent(path.join(workingDir, 'pom.xml'));
  const expected = scenario.fixture.initial_parent;
  if (initialParent.groupId !== expected.group_id || initialParent.artifactId !== expected.artifact_id || initialParent.version !== expected.version) {
    throw new Error(`Pinned fixture parent does not match declared initial_parent: ${JSON.stringify(initialParent)}`);
  }
  for (const [index, step] of (scenario.fixture.setup ?? []).entries()) {
    const patch = path.join(runDir, `setup-${index}.patch`);
    await fs.writeFile(patch, step.patch);
    await runGit(workingDir, ['apply', '--check', ...(step.options ?? []), patch]);
    await runGit(workingDir, ['apply', ...(step.options ?? []), patch]);
  }
  const preparedParent = await readParent(path.join(workingDir, 'pom.xml'));
  if (JSON.stringify(preparedParent) !== JSON.stringify(initialParent)) {
    throw new Error('Fixture setup must not perform the parent upgrade being evaluated');
  }
  // Setup is harness work, not an agent edit. Commit it only in the disposable
  // clone so diff grading and inherited-target checks use the prepared baseline.
  if (await runGit(workingDir, ['status', '--porcelain'])) {
    await runGit(workingDir, ['add', '--all']);
    const date = await runGit(workingDir, ['show', '-s', '--format=%cI', scenario.repository.revision]);
    await exec('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-gpg-sign', '-m', 'Prepare evaluation fixture'], {
      cwd: workingDir, timeout: 120000, env: {
        ...childEnvironment(env), GIT_AUTHOR_NAME: 'Scenario Fixture', GIT_COMMITTER_NAME: 'Scenario Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  }
  const baselineCommit = await runGit(workingDir, ['rev-parse', 'HEAD']);
  const repository = { name: scenario.repository.url.split('/').at(-1).replace(/\.git$/, ''),
    url: scenario.repository.url, revision: scenario.repository.revision,
    ...(scenario.repository.local_path ? { directory: scenario.repository.local_path } : {}) };
  await fs.writeFile(path.join(runDir, 'repository.json'), JSON.stringify(repository, null, 2));
  return { workingDir, baselineCommit, repository, initialParent, scenario, environment: versions };
}

module.exports = { prepareFixture, runtime };
