const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { run, view } = require('./run.cjs');
const { settings } = require('../../options.cjs');
const { childEnvironment } = require('./environment.cjs');

function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/opencode/sling-promptfoo-run-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const invocation = path.join(root, 'invocation.json');
  const output = path.join(root, 'generated config.json');
  await fs.writeFile(output, '{}');
  await fs.writeFile(path.join(root, 'npx'), `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({ args: process.argv.slice(2), ` +
    `hasKey: Boolean(process.env.LITELLM_API_KEY), telemetry: process.env.PROMPTFOO_DISABLE_TELEMETRY }));\n` +
    `process.exit(Number(process.env.TEST_RUN_EXIT ?? 0));\n`, { mode: 0o755 });
  setEnv(t, 'PATH', `${root}${path.delimiter}${process.env.PATH}`);
  setEnv(t, 'TEST_RUN_EXIT', '0');
  return { root, invocation, options: { ...settings({ ARM: 'with-skills', RUNS: '1' }), output } };
}

test('Promptfoo owns native CLI arguments, credential validation, telemetry and exit codes', async (t) => {
  const { invocation, options } = await fixture(t);
  setEnv(t, 'LITELLM_API_KEY', 'test-key-not-written-to-config');
  setEnv(t, 'EVAL_RESULTS', '/tmp/opencode/promptfoo-results-test.json');
  assert.equal(await run(options), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(invocation)), {
    args: ['--yes', 'promptfoo@0.125.1', 'eval', '--config', options.output, '--no-cache', '--repeat', '1',
      '--output', '/tmp/opencode/promptfoo-results-test.json'], hasKey: true, telemetry: '1' });
  setEnv(t, 'TEST_RUN_EXIT', '7');
  assert.equal(await run(options), 7);
  assert.equal(await view(), 7);
  assert.deepEqual(JSON.parse(await fs.readFile(invocation)).args, ['--yes', 'promptfoo@0.125.1', 'view']);
  setEnv(t, 'LITELLM_API_KEY', undefined);
  await assert.rejects(run(options, { credentialsLoaded: true }), /not set in .env/);
});

test('encrypted credential loading stays in the adapter and preserves selected config/options', async (t) => {
  const { root, invocation, options } = await fixture(t);
  setEnv(t, 'LITELLM_API_KEY', undefined);
  const credentialsFile = path.join(root, '.env');
  await fs.writeFile(credentialsFile, 'encrypted fixture placeholder');
  const sopsInvocation = path.join(root, 'sops.json');
  await fs.writeFile(path.join(root, 'sops'), `#!${process.execPath}\n` +
    `const fs = require('node:fs'); const { spawnSync } = require('node:child_process');\n` +
    `const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(sopsInvocation)}, JSON.stringify(args));\n` +
    `const result = spawnSync('/bin/sh', ['-c', args[2]], { env: { ...process.env, LITELLM_API_KEY: 'decrypted-test-key' }, stdio: 'inherit' });\n` +
    `process.exit(result.status ?? 1);\n`, { mode: 0o755 });
  assert.equal(await run(options, { credentialsFile }), 0);
  const args = JSON.parse(await fs.readFile(sopsInvocation));
  assert.deepEqual(args.slice(0, 2), ['exec-env', credentialsFile]);
  assert.match(args[2], /providers\/promptfoo\/run.cjs/);
  assert.match(args[2], /--credentials-loaded/);
  const actual = JSON.parse(await fs.readFile(invocation));
  assert.ok(actual.args.includes(options.output));
  assert.equal(actual.hasKey, true);
});

test('Promptfoo model credentials do not enter shared fixture or verification subprocesses', () => {
  assert.deepEqual(childEnvironment({ PATH: '/bin', JAVA_HOME: '/jdk21', LITELLM_API_KEY: 'private',
    GIT_DIR: '/other-repo', MAVEN_REPOSITORY_TOKEN: 'needed-by-maven' }), {
    PATH: '/bin', JAVA_HOME: '/jdk21', MAVEN_REPOSITORY_TOKEN: 'needed-by-maven' });
});
