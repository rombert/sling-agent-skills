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
delete env.RUNS;

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
  assert.equal(yaml.match(/<<: \*codingConfig/g).length, 1);
  assert.equal(yaml.match(/id: file:\/\/evals\/pi-provider\.cjs/g).length, 2);
  assert.deepEqual([...yaml.matchAll(/install_skills: (true|false)/g)].map((match) => match[1]), ['true', 'false']);
  assert.deepEqual([...yaml.matchAll(/metric: (\w+)/g)].map((match) => match[1]),
    ['ParentUpgrade', 'SkillUsage', 'JavaTarget', 'UpgradeQuality', 'MavenVerify']);
  assert.match(yaml, /maxConcurrency: 1/);
  assert.doesNotMatch(yaml, /file:\/\/evals\/provider\.cjs|cjs-with|toolOutputChars|recentToolTurns/);
  assert.match(yaml, /metric: JavaTarget\n\s+value: file:\/\/evals\/java-target\.cjs/);
  assert.match(yaml, /implicit target inherited from the old parent/);
});

test('eval launcher runs both Pi arms once by default without a provider filter', async () => {
  const { stdout } = await exec('make', ['--dry-run', 'run-evals'], { cwd, env });
  const command = stdout.split('\n').find((line) => line.startsWith('sops exec-env'));
  assert.ok(command);
  assert.match(command, /promptfoo@0\.125\.1 eval --no-cache/);
  assert.match(command, /--repeat "1"/);
  assert.doesNotMatch(command, /--filter-providers/);
});

test('eval launcher selects only the requested skills arm', async () => {
  const yaml = await fs.readFile(path.join(cwd, 'promptfooconfig.yaml'), 'utf8');
  const labels = [...yaml.matchAll(/^\s+label: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(labels, ['pi-with-skills', 'pi-without-skills']);
  for (const arm of ['both', 'with-skills', 'without-skills']) {
    const { stdout } = await exec('make', ['--dry-run', 'run-evals', `ARM=${arm}`], { cwd, env });
    const command = stdout.split('\n').find((line) => line.startsWith('sops exec-env'));
    assert.ok(command, `missing invocation for ${arm}`);
    const filter = command.match(/--filter-providers "([^"]+)"/);
    const selected = labels.filter((label) => !filter || new RegExp(filter[1]).test(label));
    const expected = arm === 'both' ? labels : [`pi-${arm}`];
    assert.deepEqual(selected, expected, arm);
    if (arm === 'both') assert.equal(filter, null);
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

test('eval launcher rejects obsolete backend arguments instead of silently running Pi', async () => {
  for (const backend of ['pi', 'native', 'all', 'invalid', '']) {
    await assert.rejects(exec('make', ['--dry-run', 'run-evals', `BACKEND=${backend}`], { cwd, env }), (error) => {
      assert.match(error.stderr, /BACKEND has been removed.*Omit BACKEND/);
      assert.doesNotMatch(error.stdout, /sops exec-env/);
      return true;
    });
  }
  await assert.rejects(exec('make', ['--dry-run', 'run-evals'], { cwd, env: { ...env, BACKEND: 'native' } }),
    /BACKEND has been removed/);
});

test('eval launcher repeats each selected arm the configured number of times', async () => {
  for (const runs of ['1', '3', '12']) {
    for (const arm of ['both', 'with-skills', 'without-skills']) {
      const { stdout } = await exec('make', ['--dry-run', 'run-evals',
        `ARM=${arm}`, `RUNS=${runs}`], { cwd, env });
      const command = stdout.split('\n').find((line) => line.startsWith('sops exec-env'));
      assert.ok(command, `missing invocation for ${arm}/${runs}`);
      assert.equal(command.match(/--repeat "[^"]*"/g)?.length, 1);
      assert.ok(command.includes(`--repeat "${runs}"`));
    }
  }
});

test('eval launcher rejects invalid or empty run counts', async () => {
  for (const runs of ['0', '-1', '1.5', 'invalid', '', '1 2', '2 ', '+1', '01', '1e2']) {
    await assert.rejects(exec('make', ['--dry-run', 'run-evals', `RUNS=${runs}`], { cwd, env }), (error) => {
      assert.match(error.stderr, /RUNS must be a positive integer/);
      assert.doesNotMatch(error.stdout, /sops exec-env/);
      return true;
    });
  }
});
