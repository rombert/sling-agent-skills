const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');

const exec = promisify(execFile);
const cwd = path.resolve(__dirname, '..');
const env = { ...process.env, MAKEFLAGS: '' };
delete env.BACKEND;
delete env.ARM;

test('shared evaluation config enables thinking and uses the verified large-model context', async () => {
  const yaml = await fs.readFile(path.join(cwd, 'promptfooconfig.yaml'), 'utf8');
  assert.match(yaml, /config: &codingConfig\n/);
  for (const [key, value] of Object.entries({ model: 'qwen3.8-27b', temperature: 0,
    maxTokens: 8192, enable_thinking: true, contextWindow: 131072,
    reserveTokens: 16384, keepRecentTokens: 20000, maxToolRepeats: 3 })) {
    const lines = yaml.split('\n').filter((line) => line.trimStart().startsWith(`${key}:`));
    assert.equal(lines.length, 1, `${key} must be shared, not overridden per variant`);
    assert.equal(lines[0].trim().split(/\s+#/)[0], `${key}: ${value}`);
  }
  assert.equal(yaml.match(/<<: \*codingConfig/g).length, 3);
  assert.match(yaml, /metric: JavaTarget\n\s+value: file:\/\/evals\/java-target\.cjs/);
  assert.match(yaml, /implicit target inherited from the old parent/);
});

test('eval launcher selects Pi, native CJS, or all providers without running evaluations', async () => {
  for (const [backend, filter] of [[undefined, undefined], ['all', undefined], ['pi', '^pi-'], ['native', '^cjs-']]) {
    const args = ['--dry-run', 'run-evals', `BACKEND=${backend ?? 'all'}`];
    if (backend === undefined) args.pop();
    const { stdout } = await exec('make', args, { cwd, env });
    const command = stdout.split('\n').find((line) => line.startsWith('sops exec-env'));
    assert.ok(command, `missing invocation for ${backend ?? 'default'}`);
    assert.match(command, /promptfoo@0\.125\.1 eval --no-cache/);
    if (filter) assert.ok(command.endsWith(`--filter-providers "${filter}"'`));
    else assert.doesNotMatch(command, /--filter-providers/);
  }
});

test('eval launcher combines backend and skills arm filters', async () => {
  const yaml = await fs.readFile(path.join(cwd, 'promptfooconfig.yaml'), 'utf8');
  const labels = [...yaml.matchAll(/^\s+label: (.+)$/gm)].map((match) => match[1]);
  assert.equal(labels.length, 4);
  for (const backend of ['all', 'pi', 'native']) {
    for (const arm of ['both', 'with-skills', 'without-skills']) {
      const { stdout } = await exec('make', ['--dry-run', 'run-evals', `BACKEND=${backend}`, `ARM=${arm}`], { cwd, env });
      const command = stdout.split('\n').find((line) => line.startsWith('sops exec-env'));
      assert.ok(command, `missing invocation for ${backend}/${arm}`);
      const filter = command.match(/--filter-providers "([^"]+)"/);
      const selected = labels.filter((label) => !filter || new RegExp(filter[1]).test(label));
      const expected = labels.filter((label) =>
        (backend === 'all' || label.startsWith(backend === 'pi' ? 'pi-' : 'cjs-')) &&
        (arm === 'both' || label.endsWith(`-${arm}`)));
      assert.deepEqual(selected, expected, `${backend}/${arm}`);
    }
  }
});

test('eval launcher rejects invalid or empty arm values', async () => {
  for (const arm of ['invalid', '', 'with-skills without-skills']) {
    await assert.rejects(exec('make', ['--dry-run', 'run-evals', `ARM=${arm}`], { cwd, env }), (error) => {
      assert.match(error.stderr, /ARM must be with-skills, without-skills, or both/);
      assert.doesNotMatch(error.stdout, /sops exec-env/);
      return true;
    });
  }
});

test('eval launcher rejects invalid or empty backend values', async () => {
  for (const backend of ['invalid', '', 'pi native']) {
    await assert.rejects(exec('make', ['--dry-run', 'run-evals', `BACKEND=${backend}`], { cwd, env }), (error) => {
      assert.match(error.stderr, /BACKEND must be pi, native, or all/);
      assert.doesNotMatch(error.stdout, /sops exec-env/);
      return true;
    });
  }
});
