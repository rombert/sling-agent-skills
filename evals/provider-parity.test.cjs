const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { generate } = require('./generate.cjs');
const { settings } = require('./options.cjs');
const { load, select, projectRoot } = require('./shared/scenarios.cjs');

test('all provider adapters preserve shared scenario facts and explicit arms across full and targeted matrices', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/sling-provider-parity-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalogFile = path.join(projectRoot, 'evals/scenarios.yaml');
  const original = await fs.readFile(catalogFile);
  const catalog = await load();
  const scenarios = select(catalog, 'all');
  assert.equal(scenarios.length, 5);
  const targeted = [
    'discovery-standalone-parent-46-to-52',
    'junit-healthcheck-parent-43-to-46',
    'discovery-impl-parent-52-to-60',
  ].join(',');

  for (const selector of ['all', targeted]) {
    const expected = select(catalog, selector);
    for (const arm of ['both', 'with-skills', 'without-skills']) {
      const arms = arm === 'both' ? ['with-skills', 'without-skills'] : [arm];
      for (const provider of ['promptfoo', 'tessl', 'inspect']) {
        const output = path.join(root, `${provider}-${expected.length}-${arm}`);
        const generated = await generate(settings({ EVAL_PROVIDER: provider,
          SCENARIO: selector, ARM: arm, RUNS: '1', EVAL_CONFIG: output }));
        assert.equal(generated.scenarioCount, expected.length);
        let actual;
        if (provider === 'promptfoo') {
          actual = generated.config.tests.map((entry) => entry.vars.scenario);
          assert.deepEqual(generated.config.providers.map((entry) => entry.label), arms.map((value) => `pi-${value}`));
          for (const entry of generated.config.tests) assert.equal(entry.vars.task, entry.vars.scenario.prompt);
        } else if (provider === 'tessl') {
          actual = generated.manifest.scenarios;
          assert.deepEqual(generated.manifest.variants.map((entry) => entry.label), arms);
          for (const scenario of actual) {
            assert.equal(await fs.readFile(path.join(generated.manifest.source, scenario.id, 'task.md'), 'utf8'), scenario.prompt);
          }
        } else {
          const expectedSlots = expected.flatMap((scenario) => arms.map((value) => `${scenario.id}--${value}`));
          assert.deepEqual(generated.config.samples.map((entry) => entry.id), expectedSlots);
          for (const scenario of expected) {
            const samples = generated.config.samples.filter((entry) => entry.scenario.id === scenario.id);
            assert.deepEqual(samples.map((entry) => entry.arm), arms);
            for (const sample of samples) assert.deepEqual(sample.scenario, scenario);
          }
          actual = generated.config.samples.filter((entry) => entry.arm === arms[0]).map((entry) => entry.scenario);
        }
        // Native formats/scorers differ; source pins, prompts, setup, exact parent,
        // bytecode/test/bundle checks and quality criteria must not differ.
        assert.deepEqual(actual, expected, `${provider}: ${selector}/${arm}`);
      }
    }
  }
  assert.deepEqual(await fs.readFile(catalogFile), original);
});
