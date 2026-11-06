const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { load } = require('../../shared/scenarios.cjs');
const { rubric, digest } = require('./generate.cjs');
const { collect, grade, auditActivation } = require('./collect.cjs');

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
  const relative = `scenarios/${scenario.id}/criteria.json`;
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  const frozen = JSON.stringify(rubric(scenario));
  await fs.writeFile(path.join(root, relative), frozen);
  const manifest = { generation: root, scenarios: [scenario], variants: [{ label: 'with-skills' }], runs: 1,
    artifacts: { [relative]: digest(frozen) } };
  const attributes = { status: 'completed', credits: 17.5, scenarios: [{ path: `scenarios/${scenario.id}`, task: scenario.prompt,
    solutions: [{ id: solutionId, variant: 'with-skills', assessmentResults: perfect(scenario),
      activation: { activatedSkills: [`tessl__${scenario.skill}`], activationMethods: [{ skill: `tessl__${scenario.skill}`, via: 'skill-tool' }] },
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
  assert.equal(report.records[0].activationAudit.pass, true);
  assert.equal(report.records[0].activationAudit.nativeScore, null);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['eval', 'view'], ['eval', 'download-solutions']]);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'verification-report.json'))).pass, true);
  attributes.scenarios[0].solutions[0].assessmentResults[0].score = 0;
  assert.equal((await collect(manifest, response, { invoke, verifySolution })).pass, false);
  attributes.scenarios[0].solutions[0].assessmentResults = perfect(scenario);
  const activation = attributes.scenarios[0].solutions[0].activation;
  attributes.scenarios[0].solutions[0].activation = null;
  assert.equal((await collect(manifest, response, { invoke, verifySolution })).pass, false);
  attributes.scenarios[0].solutions[0].activation = activation;
  assert.equal((await collect(manifest, response, { invoke, verifySolution: async () => ({ pass: false, nativeScore: null }) })).pass, false);
  for (const slot of [undefined, -1, 1, '0']) {
    attributes.scenarios[0].solutions[0].solutionMetadata.evalPipeline.runSlot = slot;
    const invalid = await collect(manifest, response, { invoke, verifySolution });
    assert.equal(invalid.pass, false);
  }
  attributes.scenarios[0].solutions[0].solutionMetadata.evalPipeline.runSlot = 0;
  // A historical rubric stays authoritative even after the generator changes.
  const historical = rubric(scenario);
  historical.checklist.push({ name: 'skill_usage', max_score: 1, description: 'Historical native transcript criterion' });
  const bytes = JSON.stringify(historical);
  await fs.writeFile(path.join(root, relative), bytes);
  manifest.artifacts[relative] = digest(bytes);
  attributes.scenarios[0].solutions[0].assessmentResults.push({ name: 'skill_usage', max_score: 1, score: 0 });
  const old = await collect(manifest, response, { invoke, verifySolution });
  assert.equal(old.pass, false);
  assert.equal(old.records[0].nativeGrade.possible, historical.checklist.length);
  assert.equal(old.records[0].nativeGrade.earned, historical.checklist.length - 1);
  await fs.writeFile(path.join(root, relative), '{}');
  await assert.rejects(collect(manifest, response, { invoke, verifySolution }), /Frozen Tessl rubric changed/);
  await fs.writeFile(path.join(root, relative), bytes);
  await assert.rejects(collect(manifest, {}, { invoke, verifySolution }), /Missing native evalRunId/);
  attributes.scenarios[0].task = 'different task';
  await assert.rejects(collect(manifest, response, { invoke, verifySolution }), /Native task mismatch/);
});

test('native activation is mandatory metadata evidence, not an outcome inference or a replacement native score', async () => {
  const scenario = (await load()).scenarios[0];
  const skill = `tessl__${scenario.skill}`;
  for (const via of ['read', 'skill-tool']) {
    const audit = auditActivation(scenario, 'with-skills', { activatedSkills: [skill], activationMethods: [{ skill, via }] });
    assert.equal(audit.pass, true);
    assert.equal(audit.nativeScore, null);
  }
  for (const evidence of [null, {}, { activatedSkills: [] }, { activatedSkills: [skill] },
    { activatedSkills: [skill], activationMethods: [{ skill, via: 'inferred' }] },
    { activatedSkills: ['another-skill'], activationMethods: [{ skill, via: 'read' }] }]) {
    assert.equal(auditActivation(scenario, 'with-skills', evidence).pass, false);
  }
  assert.equal(auditActivation(scenario, 'without-skills', { activatedSkills: [] }).pass, true);
  assert.equal(auditActivation(scenario, 'without-skills', null).pass, false);
  assert.equal(auditActivation(scenario, 'without-skills', { activatedSkills: [skill] }).pass, false);
  assert.equal(auditActivation(scenario, 'without-skills', { activatedSkills: ['tessl__osgi-scr-migrator'] },
    [scenario.skill, 'osgi-scr-migrator']).pass, false);
  assert.ok(!rubric(scenario).checklist.some((item) => item.name === 'skill_usage'));
});
