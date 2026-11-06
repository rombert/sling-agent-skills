const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { load } = require('../../shared/scenarios.cjs');
const { rubric } = require('./generate.cjs');
const { collect, grade } = require('./collect.cjs');

const runId = '01a1b154-b21d-7422-a4e0-e5abfd9ec5b2';
const solutionId = '01a1b149-35e7-7510-bdbd-c169b1b4e26c';
const perfect = (scenario) => rubric(scenario).checklist.map(({ name, max_score }) => ({ name, max_score, score: max_score }));

test('native score conversion requires every expected criterion and never treats missing or partial scores as passing', async () => {
  const scenario = (await load()).scenarios[0];
  const assessments = perfect(scenario);
  assert.equal(grade(scenario, assessments).pass, true);
  assert.equal(grade(scenario, null).pass, false);
  assert.equal(grade(scenario, assessments.slice(1)).pass, false);
  for (const change of [a => a[0].score = 0, a => a[0].score = 2, a => a[0].score = NaN,
    a => a[0].max_score = 10, a => a[0].name = 'unexpected', a => a[0] = a[1]]) {
    const changed = structuredClone(assessments);
    change(changed);
    assert.equal(grade(scenario, changed).pass, false);
  }
});

test('collection retains native grades and credits separately from independent executable verification', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/sling-tessl-collect-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenario = (await load()).scenarios[0];
  const manifest = { generation: root, scenarios: [scenario], variants: [{ label: 'with-skills' }], runs: 1 };
  const attributes = { status: 'completed', credits: 17.5, scenarios: [{ path: `scenarios/${scenario.id}`, task: scenario.prompt,
    solutions: [{ id: solutionId, variant: 'with-skills', assessmentResults: perfect(scenario),
      solutionMetadata: { evalPipeline: { runSlot: 0 } } }] }] };
  const calls = [];
  const invoke = async (args) => {
    calls.push(args);
    return { code: 0, stdout: args[1] === 'view' ? JSON.stringify({ data: { attributes } }) : '', stderr: '' };
  };
  const verificationDirectories = new Set();
  const verifySolution = async (scenario, directory, runDir) => {
    assert.ok(!verificationDirectories.has(runDir));
    verificationDirectories.add(runDir);
    return { pass: true, nativeScore: null, kind: 'independent-executable-verification' };
  };
  const response = [{ evalRunId: runId, status: 'completed' }];
  const report = await collect(manifest, response, { invoke, verifySolution });
  assert.equal(report.pass, true);
  assert.equal(report.credits, 17.5);
  assert.equal(report.records[0].nativeGrade.fraction, 1);
  assert.equal(report.records[0].independent.nativeScore, null);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['eval', 'view'], ['eval', 'download-solutions']]);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'verification-report.json'))).pass, true);
  attributes.scenarios[0].solutions[0].assessmentResults[0].score = 0;
  assert.equal((await collect(manifest, response, { invoke, verifySolution })).pass, false);
  attributes.scenarios[0].solutions[0].assessmentResults = perfect(scenario);
  assert.equal((await collect(manifest, response, { invoke, verifySolution: async () => ({ pass: false, nativeScore: null }) })).pass, false);
  for (const slot of [undefined, -1, 1, '0']) {
    attributes.scenarios[0].solutions[0].solutionMetadata.evalPipeline.runSlot = slot;
    const invalid = await collect(manifest, response, { invoke, verifySolution });
    assert.equal(invalid.pass, false);
  }
  attributes.scenarios[0].solutions[0].solutionMetadata.evalPipeline.runSlot = 0;
  await assert.rejects(collect(manifest, {}, { invoke, verifySolution }), /Missing native evalRunId/);
  attributes.scenarios[0].task = 'different task';
  await assert.rejects(collect(manifest, response, { invoke, verifySolution }), /Native task mismatch/);
});
