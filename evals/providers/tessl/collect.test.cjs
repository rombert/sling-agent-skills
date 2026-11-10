const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
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

async function fixture(t, variants = ['with-skills']) {
  const root = await fs.mkdtemp('/tmp/opencode/sling-tessl-collect-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenario = (await load()).scenarios[0];
  const relative = `scenarios/${scenario.id}/criteria.json`;
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  const frozen = JSON.stringify(rubric(scenario));
  await fs.writeFile(path.join(root, relative), frozen);
  const manifest = { generation: root, scenarios: [scenario], variants: variants.map((label) => ({ label })), runs: 1,
    artifacts: { [relative]: digest(frozen) } };
  const attributes = { status: 'completed', credits: 17.5, scenarios: [{ path: `scenarios/${scenario.id}`, task: scenario.prompt,
    solutions: variants.map((variant, index) => ({ id: index ? '01a1b149-35e7-7510-bdbd-c169b1b4e26d' : solutionId,
      variant, assessmentResults: perfect(scenario), activation: variant === 'with-skills'
        ? { activatedSkills: [`tessl__${scenario.skill}`], activationMethods: [{ skill: `tessl__${scenario.skill}`, via: 'skill-tool' }] }
        : { activatedSkills: [] }, solutionMetadata: { evalPipeline: { runSlot: 0 } } })) }] };
  const calls = [];
  const invoke = async (args) => {
    calls.push(args);
    if (args[1] === 'download-solutions') {
      const directory = args.at(-1);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'pom.xml'), '<project/>');
    }
    return { code: 0, stdout: args[1] === 'view' ? JSON.stringify({ data: { id: runId, attributes } }) : '', stderr: '' };
  };
  const verified = [];
  const verifySolution = async (scenario, directory, runDir, options, { pass = true, reason = 'Mock verification; no build executed' } = {}) => {
    assert.ok(!verified.includes(runDir));
    verified.push(runDir);
    assert.equal(options.cacheRoot, path.join(root, 'verification-maven'));
    const checks = scenario.checks.map((item) => ({ id: item.id, pass, reason }));
    const result = { pass, reason, nativeScore: null, kind: 'independent-executable-verification',
      testOnly: 'Mock verifier output, not real executable evidence', javaTarget: { pass: true }, scenarioChecks: { pass, checks } };
    const json = (name, value) => fs.writeFile(path.join(runDir, name), JSON.stringify(value));
    await json('verification.json', result);
    await json('scenario-checks.json', checks);
    await json('scenario.json', scenario);
    await json('repository.json', scenario.repository);
    await json('environment.json', { testOnly: 'Mock Java/Maven versions' });
    await json('verification-runtime.json', { testOnly: 'Mock runtime/cache settings' });
    await fs.writeFile(path.join(runDir, 'maven-verify.log'), 'Mock build log; Maven was not executed\n');
    await fs.mkdir(path.join(runDir, 'java-target-mock'));
    for (const name of ['comparison.json', 'before-effective-pom.xml', 'after-effective-pom.xml', 'before-maven.log', 'after-maven.log']) {
      await fs.writeFile(path.join(runDir, 'java-target-mock', name), `Mock target evidence: ${name}\n`);
    }
    return result;
  };
  const response = [{ evalRunId: runId, status: 'completed' }];
  return { root, manifest, scenario, attributes, calls, verified, invoke, verifySolution, response,
    collect: (options = {}) => collect(manifest, response, { invoke, verifySolution, ...options }) };
}

test('collection retains native grades and credits separately from independent executable verification', async (t) => {
  const f = await fixture(t);
  const report = await f.collect();
  assert.equal(report.pass, true);
  assert.equal(report.credits, 17.5);
  assert.equal(report.records[0].nativeGrade.fraction, 1);
  assert.equal(report.records[0].independent.nativeScore, null);
  assert.equal(report.records[0].activationAudit.pass, true);
  assert.equal(report.records[0].activationAudit.nativeScore, null);
  assert.equal(report.records[0].verification.support.length, 12);
  assert.deepEqual(f.calls.map((args) => args.slice(0, 2)), [['eval', 'view'], ['eval', 'download-solutions']]);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'verification-report.json'))).pass, true);
  const bytes = await fs.readFile(report.checkpoint, 'utf8');
  await assert.rejects(f.collect(), /explicit TESSL_COLLECT_RESUME/);
  assert.equal((await f.collect({ resume: true })).pass, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.verified.length, 1);
  assert.equal(await fs.readFile(report.checkpoint, 'utf8'), bytes);
});

test('checkpoints all native grades and activation before a later failed download and resumes only missing work', async (t) => {
  const f = await fixture(t, ['with-skills', 'without-skills']);
  let downloads = 0;
  const invoke = async (args) => {
    if (args[1] === 'download-solutions') {
      const pending = JSON.parse(await fs.readFile(path.join(f.root, 'verification-report.json')));
      assert.equal(pending.records.length, 2);
      assert.equal(pending.records.every((record) => record.nativeGrade.pass && record.activationAudit.pass), true);
      if (++downloads === 2) throw new Error('EAI_AGAIN / Please authenticate');
    }
    return f.invoke(args);
  };
  const verifySolution = async (...args) => f.verifySolution(...args, { pass: false, reason: 'Retained test failure' });
  const first = await f.collect({ invoke, verifySolution });
  assert.equal(first.pass, false);
  assert.equal(first.coverage.nativeComplete, true);
  assert.equal(first.coverage.complete, false);
  assert.equal(first.coverage.missing.length, 1);
  assert.equal(first.records[0].verification.status, 'completed');
  assert.equal(first.records[0].independent.pass, false);
  assert.equal(first.records[1].download.status, 'failed');
  assert.match(first.errors[0], /EAI_AGAIN/);
  const old = await fs.readFile(first.checkpoint, 'utf8');
  const resumed = await f.collect({ resume: true });
  assert.equal(resumed.coverage.complete, true);
  assert.equal(resumed.pass, false);
  assert.equal(resumed.records[0].verification.reused, true);
  assert.equal(resumed.records[0].independent.reason, 'Retained test failure');
  assert.equal(f.verified.length, 2); // One failing original, one newly completed slot.
  assert.equal(await fs.readFile(first.checkpoint, 'utf8'), old);
});

test('offline collection persists all native evidence and marks every unverified outcome missing', async (t) => {
  const f = await fixture(t, ['with-skills', 'without-skills']);
  await fs.writeFile(path.join(f.root, `native-${runId}.json`), JSON.stringify({ data: { id: runId, attributes: f.attributes } }));
  const report = await f.collect({ offline: true, invoke: () => { throw new Error('No remote reads allowed'); } });
  assert.equal(report.records.length, 2);
  assert.equal(report.coverage.nativeComplete, true);
  assert.equal(report.coverage.missing.length, 2);
  assert.equal(report.pass, false);
  assert.deepEqual(f.verified, []);
});

test('native read failure still leaves a durable incomplete report', async (t) => {
  const f = await fixture(t);
  const report = await f.collect({ invoke: async () => ({ code: 1, stderr: 'not logged in' }) });
  assert.equal(report.pass, false);
  assert.equal(report.coverage.missingNative.length, 1);
  assert.match(report.errors[0], /not logged in/);
  assert.equal(JSON.parse(await fs.readFile(report.checkpoint)).coverage.complete, false);
});

test('verification exceptions are not executable outcomes or automatic retry candidates', async (t) => {
  const f = await fixture(t);
  const report = await f.collect({ verifySolution: async () => { throw new Error('Interrupted build'); } });
  assert.equal(report.records[0].verification.status, 'failed');
  assert.equal(report.coverage.missing.length, 1);
  const resumed = await f.collect({ resume: true, verifySolution: () => { throw new Error('Must not retry'); } });
  assert.equal(resumed.records[0].verification.status, 'failed');
  assert.match(resumed.records[0].independent.reason, /operator review/);
  assert.equal(f.calls.length, 2);
});

test('resume refuses altered frozen manifest, rubric, native view, source snapshot and result receipt', async (t) => {
  for (const changed of ['manifest', 'rubric', 'native', 'snapshot', 'receipt']) {
    const f = await fixture(t);
    const first = await f.collect();
    if (changed === 'manifest') f.manifest.scenarios[0].prompt += 'changed';
    if (changed === 'rubric') await fs.writeFile(path.join(f.root, `scenarios/${f.scenario.id}/criteria.json`), '{}');
    if (changed === 'native') await fs.appendFile(path.join(f.root, `native-${runId}.json`), ' ');
    if (changed === 'snapshot') await fs.writeFile(path.join(first.records[0].download.directory, 'pom.xml'), 'changed');
    if (changed === 'receipt') await fs.writeFile(first.records[0].verification.file, '{}');
    if (['manifest', 'rubric'].includes(changed)) await assert.rejects(f.collect({ resume: true }), /changed/);
    else {
      const resumed = await f.collect({ resume: true });
      assert.equal(resumed.pass, false);
      assert.match(resumed.errors[0], /changed/);
    }
    assert.equal(f.calls.length, 2);
    assert.equal(f.verified.length, 1);
  }
});

test('new receipts reject mutation or removal of every retained verification/check/runtime/POM/log support file', async (t) => {
  const supportNames = ['verification.json', 'scenario-checks.json', 'verification-runtime.json', 'environment.json',
    'repository.json', 'scenario.json', 'maven-verify.log', 'java-target-mock/comparison.json',
    'java-target-mock/before-effective-pom.xml', 'java-target-mock/after-effective-pom.xml',
    'java-target-mock/before-maven.log', 'java-target-mock/after-maven.log'];
  for (const action of ['mutate', 'remove']) for (const name of supportNames) {
    await t.test(`${action}: ${name}`, async (t) => {
      const f = await fixture(t);
      const first = await f.collect();
      assert.equal(first.pass, true);
      const retained = first.records[0].verification.support.find((item) => item.file === path.join(first.records[0].verification.runDir, name));
      assert.ok(retained, `Missing checksum receipt for ${name}`);
      if (action === 'mutate') await fs.appendFile(retained.file, ' changed');
      else await fs.unlink(retained.file);
      const resumed = await f.collect({ resume: true });
      assert.equal(resumed.pass, false);
      assert.equal(resumed.coverage.missing.length, 1);
      assert.match(resumed.errors[0], action === 'mutate' ? /supporting evidence changed/ : /supporting evidence missing/);
      assert.equal(f.calls.length, 2);
      assert.equal(f.verified.length, 1);
    });
  }
});

test('new successful results cannot omit required retained evidence or disagree with verifier files', async (t) => {
  for (const changed of ['verification.json', 'verification-runtime.json', 'scenario-checks.json', 'maven-verify.log',
    'java-target-mock/before-maven.log', 'mismatched-result', 'mismatched-checks']) {
    const f = await fixture(t);
    const verifySolution = async (...args) => {
      const result = await f.verifySolution(...args);
      const runDir = args[2];
      if (changed === 'mismatched-result') await fs.writeFile(path.join(runDir, 'verification.json'), '{}');
      else if (changed === 'mismatched-checks') await fs.writeFile(path.join(runDir, 'scenario-checks.json'), '[]');
      else await fs.unlink(path.join(runDir, changed));
      return result;
    };
    const report = await f.collect({ verifySolution });
    assert.equal(report.pass, false);
    assert.equal(report.records[0].verification.status, 'failed');
    assert.equal(report.coverage.missing.length, 1);
    assert.match(report.records[0].verification.reason, /Missing retained verification evidence|does not match/);
  }
});

test('a completed early executable rejection binds available support without inventing Maven/target artifacts', async (t) => {
  const f = await fixture(t);
  const verifySolution = async (...args) => {
    const result = await f.verifySolution(...args, { pass: false, reason: 'Mock upgrade rejection; no command executed' });
    const runDir = args[2];
    result.javaTarget = { pass: false, reason: result.reason };
    result.scenarioChecks = { pass: false, reason: result.reason };
    await fs.writeFile(path.join(runDir, 'verification.json'), JSON.stringify(result));
    await fs.unlink(path.join(runDir, 'scenario-checks.json'));
    await fs.unlink(path.join(runDir, 'maven-verify.log'));
    await fs.rm(path.join(runDir, 'java-target-mock'), { recursive: true }); // This test's own mock artifacts only.
    return result;
  };
  const report = await f.collect({ verifySolution });
  assert.equal(report.pass, false);
  assert.equal(report.coverage.complete, true);
  assert.equal(report.records[0].verification.status, 'completed');
  assert.equal(report.records[0].verification.support.length, 5);
  const resumed = await f.collect({ resume: true });
  assert.equal(resumed.records[0].verification.reused, true);
  assert.equal(resumed.records[0].independent.pass, false);
  assert.equal(f.verified.length, 1);
});

test('collection accepts more than ten repetitions while rejecting invalid and unsafe run counts', async (t) => {
  const f = await fixture(t);
  f.manifest.runs = 11;
  const original = f.attributes.scenarios[0].solutions[0];
  f.attributes.scenarios[0].solutions = Array.from({ length: 11 }, (_, slot) => ({
    ...structuredClone(original), id: randomUUID(), solutionMetadata: { evalPipeline: { runSlot: slot } },
  }));
  const report = await f.collect();
  assert.equal(report.pass, true);
  assert.equal(report.expected, 11);
  assert.equal(report.records.length, 11);
  assert.equal(f.verified.length, 11);
  for (const runs of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(collect({ ...f.manifest, runs }, f.response), /Invalid frozen run count/);
  }
});

test('resume refuses a completed receipt with no supporting-evidence inventory', async (t) => {
  const f = await fixture(t);
  const report = await f.collect();
  delete report.records[0].verification.support;
  await fs.writeFile(path.join(f.root, 'verification-report.json'), JSON.stringify(report));
  const resumed = await f.collect({ resume: true });
  assert.equal(resumed.pass, false);
  assert.match(resumed.errors[0], /supporting evidence is missing/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.verified.length, 1);
});

test('a crash during metadata recollection cannot forget previously completed receipts', async (t) => {
  const f = await fixture(t);
  const report = await f.collect();
  report.retainedRecords = report.records;
  report.records = [];
  report.nativeRuns = [];
  await fs.writeFile(path.join(f.root, 'verification-report.json'), JSON.stringify(report));
  const resumed = await f.collect({ resume: true });
  assert.equal(resumed.pass, true);
  assert.equal(resumed.records[0].verification.reused, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.verified.length, 1);
});

test('a failed early download cannot hide an already completed later slot', async (t) => {
  const f = await fixture(t, ['with-skills', 'without-skills']);
  const report = await f.collect();
  // Simulate retained evidence in which the early slot is still pending while
  // a later native slot already has a completed independent receipt.
  report.records[0].download = { status: 'pending' };
  report.records[0].verification = { status: 'pending' };
  report.records[0].independent = { pass: false };
  await fs.writeFile(path.join(f.root, 'verification-report.json'), JSON.stringify(report));
  const resumed = await f.collect({ resume: true, invoke: async () => ({ code: 1, stderr: 'network unavailable' }) });
  assert.equal(resumed.coverage.missing.length, 1);
  assert.equal(resumed.records[1].verification.status, 'completed');
  assert.equal(resumed.records[1].verification.reused, true);
  assert.equal(resumed.records[1].independent.pass, true);
  assert.equal(f.verified.length, 2);
});

test('the generation lock blocks overlapping collection without changing prior evidence', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.collection.lock'), 'another operator');
  await assert.rejects(f.collect(), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(f.root, '.collection.lock'), 'utf8'), 'another operator');
  assert.equal(f.calls.length, 0);
});

test('invalid and duplicate native slots fail closed before any download', async (t) => {
  for (const slot of [undefined, -1, 1, '0']) {
    const f = await fixture(t);
    f.attributes.scenarios[0].solutions[0].solutionMetadata.evalPipeline.runSlot = slot;
    const invalid = await f.collect();
    assert.equal(invalid.pass, false);
    assert.match(invalid.errors[0], /Invalid or duplicate/);
    assert.equal(f.calls.length, 1);
  }
  const f = await fixture(t);
  f.attributes.scenarios[0].solutions.push(f.attributes.scenarios[0].solutions[0]);
  const invalid = await f.collect();
  assert.equal(invalid.coverage.complete, false);
  assert.match(invalid.errors[0], /duplicate/);
  assert.equal(f.calls.length, 1);
});

test('historical checksum-verified rubrics preserve deductions and missing activation is not inferred', async (t) => {
  const f = await fixture(t);
  // A historical rubric stays authoritative even after the generator changes.
  const historical = rubric(f.scenario);
  historical.checklist.push({ name: 'skill_usage', max_score: 1, description: 'Historical native transcript criterion' });
  const bytes = JSON.stringify(historical);
  const relative = `scenarios/${f.scenario.id}/criteria.json`;
  await fs.writeFile(path.join(f.root, relative), bytes);
  f.manifest.artifacts[relative] = digest(bytes);
  f.attributes.scenarios[0].solutions[0].assessmentResults.push({ name: 'skill_usage', max_score: 1, score: 0 });
  f.attributes.scenarios[0].solutions[0].activation = null;
  const old = await f.collect();
  assert.equal(old.pass, false);
  assert.equal(old.records[0].nativeGrade.possible, historical.checklist.length);
  assert.equal(old.records[0].nativeGrade.earned, historical.checklist.length - 1);
  assert.equal(old.records[0].activationAudit.pass, false);
  await assert.rejects(collect(f.manifest, {}, {}), /Missing native evalRunId/);
});

test('native task mismatch is retained as a fail-closed incomplete report', async (t) => {
  const f = await fixture(t);
  f.attributes.scenarios[0].task = 'different task';
  const report = await f.collect();
  assert.equal(report.pass, false);
  assert.match(report.errors[0], /Native task mismatch/);
});

test('a retained view from another run is not accepted even when tasks match', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, `native-${runId}.json`), JSON.stringify({ data: { id: solutionId, attributes: f.attributes } }));
  const report = await f.collect({ offline: true });
  assert.equal(report.pass, false);
  assert.match(report.errors[0], /run identity mismatch/);
  assert.equal(f.calls.length, 0);
});

test('a historical report cannot be silently overwritten and rebuilt', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'verification-report.json');
  const bytes = JSON.stringify({ kind: 'tessl-evaluation-and-independent-verification', records: [{ pass: false }] });
  await fs.writeFile(file, bytes);
  await assert.rejects(f.collect(), /Legacy report requires explicit/);
  await assert.rejects(f.collect({ resume: true }), /reviewed TESSL_LEGACY_EVIDENCE/);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.equal(f.calls.length, 0);
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
