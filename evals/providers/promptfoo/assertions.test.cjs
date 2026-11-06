const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gradingResult } = require('./assertions/result.cjs');
const { checkUpgrade } = require('../../shared/parent-upgrade.cjs');

test('native score/component conversion belongs to the Promptfoo assertion adapter', () => {
  const result = { pass: false, reason: 'One check failed', checks: [
    { id: 'build', pass: true, reason: 'Built' }, { id: 'tests', pass: false, reason: 'Wrong totals' }] };
  assert.deepEqual(gradingResult(result), { pass: false, score: 0, reason: 'One check failed', componentResults: [
    { id: 'build', pass: true, score: 1, reason: 'Built' }, { id: 'tests', pass: false, score: 0, reason: 'Wrong totals' }] });
  assert.ok(!('componentResults' in result));
  assert.ok(!('score' in result));
});

test('assertion adapters map native context to plain shared state and fail without metadata', async () => {
  const shared = await checkUpgrade(undefined);
  const native = await require('./assertions/parent-upgrade.cjs')('', {});
  assert.deepEqual(native, { ...shared, score: 0 });
  for (const name of ['java-target', 'maven-verify', 'scenario-checks']) {
    const result = await require(`./assertions/${name}.cjs`)('', {});
    assert.equal(result.pass, false);
    assert.equal(result.score, 0);
  }
});
