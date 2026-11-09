const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { generate } = require('../../generate.cjs');
const { settings } = require('../../options.cjs');
const { childEnvironment } = require('./environment.cjs');
const { run, view } = require('./run.cjs');
const { dispatch } = require('./bridge.cjs');
const models = require('../../models.json');
const exec = promisify(execFile);

function setEnv(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

async function temporary(t) {
  const root = await fs.mkdtemp('/tmp/opencode/sling-inspect-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Inspect generation shares models with Promptfoo and expands arms without leaking answers into prompts', async (t) => {
  const root = await temporary(t);
  const options = settings({ EVAL_PROVIDER: 'inspect', SCENARIO: 'jcr-js-nodetypes-parent-34-to-46' });
  assert.match(options.output, /target\/evals\/inspect.json$/);
  const { config, output } = await generate({ ...options, output: path.join(root, 'inspect.json') });
  assert.deepEqual(JSON.parse(await fs.readFile(output)), config);
  assert.deepEqual(config.samples.map((sample) => sample.arm), ['with-skills', 'without-skills']);
  assert.equal(config.samples[0].scenario.prompt, config.samples[1].scenario.prompt);
  assert.doesNotMatch(config.samples[0].scenario.prompt, /jasmine-maven-plugin|3\.0-beta-02|mockito-core/);
  assert.deepEqual(config.models, models);
  const promptfoo = await generate({ ...options, provider: 'promptfoo', output: path.join(root, 'promptfoo.json') });
  for (const provider of promptfoo.config.providers) {
    for (const [key, value] of Object.entries(models.coding)) assert.deepEqual(provider.config[key], value);
    assert.equal(provider.config.apiBaseUrl, config.models.apiBaseUrl);
  }
  assert.equal(promptfoo.config.defaultTest.options.provider.id, `litellm:${config.models.grading.model}`);
  for (const arm of ['with-skills', 'without-skills']) {
    const result = await generate({ ...options, arm, output: path.join(root, `${arm}.json`) });
    assert.deepEqual(result.config.samples.map((sample) => sample.arm), [arm]);
  }
  for (const key of ['BACKEND', 'REPO', 'PROMPTFOO_REPO']) {
    assert.throws(() => settings({ EVAL_PROVIDER: 'inspect', [key]: 'anything' }), /Omit/);
  }
  assert.equal(settings({ EVAL_PROVIDER: 'inspect', RUNS: '3' }).runs, 3);
  await assert.rejects(generate({ ...options, selector: 'not-a-scenario' }), /Unknown scenario/);
});

test('Inspect launcher owns pinned Python execution, exported credentials, viewer and exit codes', async (t) => {
  const root = await temporary(t);
  const invocation = path.join(root, 'invocation.json');
  await fs.writeFile(path.join(root, 'uv'), `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({ args: process.argv.slice(2), ` +
    `hasKey: Boolean(process.env.LITELLM_API_KEY), node: process.env.EVAL_NODE, venv: process.env.UV_PROJECT_ENVIRONMENT }));\n` +
    `process.exit(Number(process.env.TEST_RUN_EXIT ?? 0));\n`, { mode: 0o755 });
  setEnv(t, 'PATH', `${root}${path.delimiter}${process.env.PATH}`);
  setEnv(t, 'LITELLM_API_KEY', 'private-key-never-serialized');
  setEnv(t, 'EVAL_RESULTS', path.join(root, 'logs'));
  setEnv(t, 'TEST_RUN_EXIT', '0');
  const output = path.join(root, 'generated config.json');
  await fs.writeFile(output, '{}');
  const options = { ...settings({ EVAL_PROVIDER: 'inspect', RUNS: '2' }), output };
  assert.equal(await run(options), 0);
  const actual = JSON.parse(await fs.readFile(invocation));
  assert.deepEqual(actual.args.slice(0, 5), ['run', '--locked', '--project', __dirname, '--no-env-file']);
  assert.ok(actual.args.includes(output));
  assert.deepEqual(actual.args.slice(-4), ['--runs', '2', '--log-dir', path.join(root, 'logs')]);
  assert.equal(actual.hasKey, true);
  assert.equal(actual.node, process.execPath);
  assert.doesNotMatch(JSON.stringify(actual), /private-key/);
  setEnv(t, 'TEST_RUN_EXIT', '7');
  assert.equal(await run(options), 7);
  assert.equal(await view(), 7);
  assert.deepEqual(JSON.parse(await fs.readFile(invocation)).args.slice(-4), ['inspect', 'view', '--log-dir', path.join(root, 'logs')]);

  setEnv(t, 'LITELLM_API_KEY', undefined);
  await assert.rejects(run(options, { credentialsLoaded: true }), /LITELLM_API_KEY is not set/);
  await assert.rejects(run(options, { credentialsFile: path.join(root, 'missing') }), /\.env is missing/);
  const credentialsFile = path.join(root, 'encrypted fixture');
  await fs.writeFile(credentialsFile, 'encrypted placeholder');
  const sopsInvocation = path.join(root, 'sops.json');
  await fs.writeFile(path.join(root, 'sops'), `#!${process.execPath}\n` +
    `const fs = require('node:fs'); const { spawnSync } = require('node:child_process');\n` +
    `const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(sopsInvocation)}, JSON.stringify(args));\n` +
    `const result = spawnSync('/bin/sh', ['-c', args[2]], { env: { ...process.env, LITELLM_API_KEY: 'decrypted-test-key' }, stdio: 'inherit' });\n` +
    `process.exit(result.status ?? 1);\n`, { mode: 0o755 });
  setEnv(t, 'TEST_RUN_EXIT', '0');
  assert.equal(await run(options, { credentialsFile }), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(sopsInvocation)).slice(0, 2), ['exec-env', credentialsFile]);
  assert.ok(JSON.parse(await fs.readFile(invocation)).args.includes(output));
  assert.equal(await fs.readFile(credentialsFile, 'utf8'), 'encrypted placeholder');
});

test('Inspect credentials and inherited Git context are removed without removing Maven credentials', () => {
  assert.deepEqual(childEnvironment({ PATH: '/bin', JAVA_HOME: '/jdk21', LITELLM_API_KEY: 'secret',
    OPENAI_API_KEY: 'other', GIT_DIR: '/other-repo', MAVEN_REPOSITORY_TOKEN: 'needed' }), {
    PATH: '/bin', JAVA_HOME: '/jdk21', MAVEN_REPOSITORY_TOKEN: 'needed' });
});

test('shared executable checks fail closed on missing completion without invoking Maven', async (t) => {
  const runDir = await temporary(t);
  const options = settings({ EVAL_PROVIDER: 'inspect', SCENARIO: 'jcr-js-nodetypes-parent-34-to-46' });
  const { config } = await generate({ ...options, output: path.join(runDir, 'config.json') });
  const outcomes = await dispatch('checks', { runDir, workingDir: runDir,
    scenario: config.samples[0].scenario, baselineCommit: 'a'.repeat(40), initialParent: { groupId: 'org.apache.sling', artifactId: 'sling', version: '34' },
    completion: { status: 'blocked', summary: 'Test blocker' } });
  assert.ok(Object.values(outcomes).every((outcome) => !outcome.pass));
  assert.match(outcomes.ParentUpgrade.reason, /Test blocker/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runDir, 'checks.json'))), outcomes);
  await assert.rejects(dispatch('unknown', {}), /Unknown Inspect bridge/);
});

test('Inspect diff artifacts include untracked files without staging or changing the baseline', async (t) => {
  const runDir = await temporary(t);
  const workingDir = path.join(runDir, 'project');
  await fs.mkdir(workingDir);
  const git = (args) => exec('git', args, { cwd: workingDir, env: childEnvironment() });
  await git(['init', '--quiet', '--template=']);
  await fs.writeFile(path.join(workingDir, 'pom.xml'), 'before\n');
  await git(['add', 'pom.xml']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-gpg-sign', '-m', 'baseline']);
  const baselineCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await fs.writeFile(path.join(workingDir, 'pom.xml'), 'after\n');
  await fs.writeFile(path.join(workingDir, 'new.txt'), 'new file\n');
  const { diff } = await dispatch('diff', { runDir, workingDir, baselineCommit });
  assert.match(diff, /\+after/);
  assert.match(diff, /\+new file/);
  assert.equal(await fs.readFile(path.join(runDir, 'changes.patch'), 'utf8'), diff);
  assert.equal((await git(['diff', '--cached'])).stdout, '');
  assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), baselineCommit);
});
