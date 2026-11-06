const fs = require('node:fs/promises');
const path = require('node:path');
const { verify } = require('./verify.cjs');
const { rubric, writeJson, digest } = require('./generate.cjs');

function grade(scenario, assessments, expected = rubric(scenario).checklist) {
  if (!Array.isArray(assessments) || assessments.length !== expected.length) {
    return { pass: false, reason: 'Missing or incomplete native assessment', fraction: null, assessments };
  }
  let earned = 0, possible = 0;
  const seen = new Set();
  for (const criterion of expected) {
    const matches = assessments.filter((item) => item.name === criterion.name);
    const item = matches[0];
    if (matches.length !== 1 || seen.has(item.name) || item.max_score !== criterion.max_score ||
        !Number.isFinite(item.score) || item.score < 0 || item.score > item.max_score) {
      return { pass: false, reason: `Invalid native assessment: ${criterion.name}`, fraction: null, assessments };
    }
    seen.add(item.name);
    earned += item.score;
    possible += item.max_score;
  }
  return { pass: possible > 0 && earned === possible, fraction: earned / possible, earned, possible, assessments };
}

async function frozenChecklist(manifest, scenario) {
  const relative = path.posix.join('scenarios', scenario.id, 'criteria.json');
  const bytes = await fs.readFile(path.join(manifest.generation, relative));
  if (!manifest.artifacts?.[relative] || digest(bytes) !== manifest.artifacts[relative]) {
    throw new Error(`Frozen Tessl rubric changed or is missing: ${scenario.id}`);
  }
  const criteria = JSON.parse(bytes);
  if (criteria.type !== 'weighted_checklist' || !Array.isArray(criteria.checklist)) throw new Error('Invalid frozen Tessl rubric');
  return criteria.checklist;
}

function auditActivation(scenario, variant, activation, skills = [scenario.skill]) {
  const result = { kind: 'native-activation-verification', nativeScore: null, expectedSkill: scenario.skill, pass: false };
  if (!Array.isArray(activation?.activatedSkills) || activation.activatedSkills.some((name) => typeof name !== 'string')) {
    return { ...result, reason: 'Missing native activation evidence; never infer skill use from a successful build' };
  }
  const names = (skill) => [skill, `tessl__${skill}`];
  if (variant === 'without-skills') {
    const projectNames = new Set(skills.flatMap(names));
    const unexpected = activation.activatedSkills.filter((name) => projectNames.has(name));
    return { ...result, pass: unexpected.length === 0,
      reason: unexpected.length ? `Project skills activated in the no-skills arm: ${unexpected.join(', ')}` : 'No project skill activation in the no-skills arm' };
  }
  const expectedNames = names(scenario.skill);
  const loaded = activation.activatedSkills.some((name) => expectedNames.includes(name));
  const methods = (Array.isArray(activation.activationMethods) ? activation.activationMethods : [])
    .filter((item) => expectedNames.includes(item?.skill) && ['read', 'skill-tool'].includes(item.via));
  const pass = variant === 'with-skills' && loaded && methods.length > 0;
  return { ...result, pass, methods, reason: pass ? 'Required project skill loaded through native read/skill-tool evidence' : 'Required native read/skill-tool activation evidence is absent' };
}

async function collect(manifest, response, { invoke, verifySolution = verify } = {}) {
  const runs = Array.isArray(response) ? response : [response];
  const records = [], nativeRuns = [];
  for (const run of runs) {
    if (!/^[0-9a-f-]{36}$/.test(run.evalRunId ?? '')) throw new Error('Missing native evalRunId; refusing to guess which run to inspect');
    const result = await invoke(['eval', 'view', run.evalRunId, '--json']);
    if (result.code !== 0) throw new Error(`Cannot fetch completed native run ${run.evalRunId}: ${result.stderr}`);
    const view = JSON.parse(result.stdout);
    await writeJson(path.join(manifest.generation, `native-${run.evalRunId}.json`), view);
    const attributes = view.data?.attributes;
    if (attributes?.status !== 'completed') throw new Error(`Native run ${run.evalRunId} is not completed`);
    nativeRuns.push({ id: run.evalRunId, credits: attributes.credits, metadata: attributes.runMetadata });
    for (const nativeScenario of attributes.scenarios ?? []) {
      const id = path.posix.basename(nativeScenario.path);
      const scenario = manifest.scenarios.find((item) => item.id === id);
      if (!scenario || nativeScenario.task !== scenario.prompt) throw new Error(`Native task mismatch: ${id}`);
      const expected = await frozenChecklist(manifest, scenario);
      for (const solution of nativeScenario.solutions ?? []) {
        if (!manifest.variants.some((variant) => variant.label === solution.variant) || !/^[0-9a-f-]{36}$/.test(solution.id)) {
          throw new Error(`Unexpected native solution: ${solution.id}/${solution.variant}`);
        }
        const nativeGrade = grade(scenario, solution.assessmentResults, expected);
        const activation = solution.activation ?? solution.runs?.[0]?.activation ?? null;
        const skills = [...new Set(Object.keys(manifest.skillHashes ?? {}).map((name) => name.split('/')[0]))];
        const activationAudit = auditActivation(scenario, solution.variant, activation, skills.length ? skills : [scenario.skill]);
        const directory = path.join(manifest.generation, 'solutions', solution.id);
        await fs.mkdir(path.dirname(directory), { recursive: true });
        const downloaded = await invoke(['eval', 'download-solutions', run.evalRunId, '--solution', solution.id, '--output', directory]);
        if (downloaded.code !== 0) throw new Error(`Cannot download solution ${solution.id}: ${downloaded.stderr}`);
        const verificationRoot = path.join(manifest.generation, 'verification', solution.id);
        await fs.mkdir(verificationRoot, { recursive: true });
        // Read-only recollection must not reuse a partially built clone or
        // erase an earlier verification attempt.
        const runDir = await fs.mkdtemp(path.join(verificationRoot, 'attempt-'));
        let independent;
        try { independent = await verifySolution(scenario, directory, runDir); }
        catch (error) { independent = { kind: 'independent-executable-verification', nativeScore: null, pass: false, reason: error.message }; }
        const record = { scenarioId: id, variant: solution.variant, solutionId: solution.id,
          slot: solution.solutionMetadata?.evalPipeline?.runSlot, nativeGrade,
          activation, activationAudit,
          independent, pass: nativeGrade.pass && independent.pass && activationAudit.pass };
        records.push(record);
        console.log(`${id} / ${solution.variant}: native=${nativeGrade.fraction ?? 'unavailable'}, independent=${independent.pass ? 'PASS' : 'FAIL'}, activation=${activationAudit.pass ? 'PASS' : 'FAIL'}`);
      }
    }
  }
  const report = { kind: 'tessl-evaluation-and-independent-verification', nativeRuns,
    credits: nativeRuns.reduce((sum, run) => sum + (run.credits ?? 0), 0),
    expected: manifest.scenarios.length * manifest.variants.length * manifest.runs,
    records, pass: false };
  const slots = new Set(records.map((record) => `${record.scenarioId}/${record.variant}/${record.slot}`));
  const expectedSlots = manifest.scenarios.flatMap((scenario) => manifest.variants.flatMap((variant) =>
    Array.from({ length: manifest.runs }, (_, slot) => `${scenario.id}/${variant.label}/${slot}`)));
  report.coverage = { complete: slots.size === expectedSlots.length && expectedSlots.every((slot) => slots.has(slot)),
    missing: expectedSlots.filter((slot) => !slots.has(slot)) };
  report.pass = report.coverage.complete && records.every((record) => Number.isInteger(record.slot) && record.slot >= 0 && record.slot < manifest.runs) && records.length === report.expected &&
    slots.size === records.length && records.every((record) => record.pass);
  await writeJson(path.join(manifest.generation, 'verification-report.json'), report);
  return report;
}

module.exports = { collect, grade, auditActivation, frozenChecklist };

if (require.main === module) Promise.resolve().then(async () => {
  const { settings } = require('../../options.cjs');
  const { launch } = require('./run.cjs');
  const options = settings({ ...process.env, EVAL_PROVIDER: 'tessl' });
  const manifest = JSON.parse(await fs.readFile(process.env.TESSL_MANIFEST ?? path.join(options.output, 'manifest.json')));
  const response = JSON.parse(await fs.readFile(process.env.EVAL_RESULTS ?? path.join(manifest.generation, 'result.json')));
  const report = await collect({ ...manifest, runs: options.runs }, response, { invoke: launch });
  console.log(`Collected ${report.records.length}/${report.expected} solutions; ${report.credits} credits. Report: ${manifest.generation}/verification-report.json`);
  process.exitCode = report.pass ? 0 : 1;
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
