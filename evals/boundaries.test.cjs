const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { projectRoot } = require('./shared/scenarios.cjs');

test('shared modules do not import provider adapters or depend on their contexts and credentials', async () => {
  for await (const name of fs.glob('evals/shared/**/*.cjs', { cwd: projectRoot })) {
    const source = await fs.readFile(path.join(projectRoot, name), 'utf8');
    assert.doesNotMatch(source, /require\([^)]*providers\//, name);
    assert.doesNotMatch(source, /providerResponse|componentResults|PROMPTFOO_|TESSL_|LITELLM_API_KEY|@earendil-works/, name);
  }
});

test('top-level commands dispatch without provider-specific CLI or credential handling', async () => {
  for (const name of ['Makefile', 'evals/generate.cjs', 'evals/run.cjs', 'evals/view.cjs']) {
    const source = await fs.readFile(path.join(projectRoot, name), 'utf8');
    assert.doesNotMatch(source, /npx|sops|LITELLM_API_KEY|PROMPTFOO_/, name);
  }
});
