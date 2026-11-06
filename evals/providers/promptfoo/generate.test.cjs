const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { generate } = require('../../generate.cjs');
const { settings } = require('../../options.cjs');

const exec = promisify(execFile);
const { projectRoot: cwd } = require('../../shared/scenarios.cjs');

test('generation has shared model settings, scenario-specific prompts and native assertions', async (t) => {
  const dir = await fs.mkdtemp('/tmp/opencode/sling-generate-test-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { config, output } = await generate({ ...settings({}), output: path.join(dir, 'config.json') });
  assert.deepEqual(JSON.parse(await fs.readFile(output)), config);
  assert.equal(config.providers.length, 2);
  const [withSkills, withoutSkills] = config.providers.map((p) => p.config);
  assert.equal(withSkills.install_skills, true);
  assert.deepEqual({ ...withSkills, install_skills: false }, withoutSkills);
  assert.equal(withSkills.model, 'qwen3.8-27b');
  assert.equal(withSkills.contextWindow, 131072);
  assert.equal(withSkills.maxRetries, 0);
  assert.equal(withSkills.chatTemplateKwargs.enable_thinking, true);
  assert.equal(config.evaluateOptions.maxConcurrency, 1);
  assert.deepEqual(config.prompts, ['{{task}}']);
  const scenario = config.tests.find((item) => item.description === 'jcr-js-nodetypes-parent-34-to-46');
  assert.ok(scenario);
  assert.equal(scenario.vars.task, scenario.vars.scenario.prompt);
  assert.doesNotMatch(scenario.vars.task, /jasmine-maven-plugin|3\.0-beta-02|mockito-core/);
  assert.match(scenario.assert.at(-1).value, /exact requested parent is org.apache.sling:sling-bundle-parent:46/);
  assert.deepEqual(scenario.assert.map((a) => a.metric), ['ParentUpgrade', 'SkillUsage', 'JavaTarget', 'ScenarioChecks', 'UpgradeQuality']);
  assert.ok(config.providers.every((p) => path.isAbsolute(p.id.replace('file://', ''))));
});

test('generation selects one scenario and one arm without changing the user prompt', async (t) => {
  const dir = await fs.mkdtemp('/tmp/opencode/sling-select-test-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const arm of ['with-skills', 'without-skills']) {
    const { config } = await generate({ ...settings({ ARM: arm, SCENARIO: 'jcr-js-nodetypes-parent-34-to-46' }), output: path.join(dir, `${arm}.json`) });
    assert.deepEqual(config.providers.map((p) => p.label), [`pi-${arm}`]);
    assert.equal(config.tests.length, 1);
  }
});

test('launcher rejects invalid settings, old overrides and unknown scenarios before model calls', async () => {
  for (const ARM of ['', 'invalid', 'with-skills without-skills']) assert.throws(() => settings({ ARM }), /ARM must/);
  for (const RUNS of ['', '0', '-1', '1.5', '01', '1 2', '2 ', '1e2']) assert.throws(() => settings({ RUNS }), /RUNS must/);
  for (const key of ['BACKEND', 'REPO', 'PROMPTFOO_REPO']) assert.throws(() => settings({ [key]: 'anything' }));
  assert.throws(() => settings({ EVAL_PROVIDER: 'tessl' }), /not implemented/);
  await assert.rejects(generate(settings({ SCENARIO: 'not-a-scenario' })), /Unknown scenario/);
  await assert.rejects(generate(settings({ SCENARIO: 'jcr-js-nodetypes-parent-34-to-46,jcr-js-nodetypes-parent-34-to-46' })), /must not repeat/);
});

test('top-level make targets generate before running and pass selections as environment values', async () => {
  const env = { ...process.env, MAKEFLAGS: '' };
  delete env.LITELLM_API_KEY;
  const { stdout } = await exec('make', ['--dry-run', 'run-eval', 'ARM=with-skills', 'RUNS=1'], { cwd, env });
  assert.match(stdout, /node evals\/generate.cjs\nnode evals\/run.cjs/);
  assert.doesNotMatch(stdout, /--repeat|promptfoo@/); // arguments are built without shell interpolation in run.cjs
});
