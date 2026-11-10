const fs = require('node:fs/promises');
const path = require('node:path');
const { verify } = require('./verify.cjs');
const { rubric, writeJson, digest } = require('./generate.cjs');
const { randomUUID } = require('node:crypto');
const { canonical, fileDigest, snapshotDigest, verificationSupport, verifierIdentity, frozenIdentity, atomicJson } = require('./evidence.cjs');

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

const slotKey = (record) => `${record.scenarioId}/${record.variant}/${record.slot}`;
const unavailable = (reason) => ({ kind: 'independent-executable-verification', nativeScore: null, pass: false, reason });
const readJson = async (file) => JSON.parse(await fs.readFile(file));

async function collect(manifest, response, { invoke, verifySolution = verify, resume = false, offline = false,
  legacyEvidence = {} } = {}) {
  if (!Number.isSafeInteger(manifest.runs) || manifest.runs < 1) throw new Error('Invalid frozen run count');
  const runs = Array.isArray(response) ? response : [response];
  for (const run of runs) if (!/^[0-9a-f-]{36}$/.test(run?.evalRunId ?? '')) {
    throw new Error('Missing native evalRunId; refusing to guess which run to inspect');
  }
  if (new Set(runs.map((run) => run.evalRunId)).size !== runs.length) throw new Error('Duplicate native run');
  const bindings = { manifest: await frozenIdentity(manifest), verifier: await verifierIdentity(),
    runIds: runs.map((run) => run.evalRunId) };
  const reportFile = path.join(manifest.generation, 'verification-report.json');
  let prior;
  try { prior = await readJson(reportFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior?.schemaVersion === 2) {
    if (!resume) throw new Error('Collection checkpoint exists; use explicit TESSL_COLLECT_RESUME=1 (never redownload/reverify blindly)');
    if (canonical(prior.bindings) !== canonical(bindings)) throw new Error('Resume frozen inputs, run selection or verifier changed; refusing to reuse or rerun evidence');
  } else if (prior && (!resume || Object.keys(legacyEvidence).length === 0)) {
    throw new Error('Legacy report requires explicit resume and reviewed TESSL_LEGACY_EVIDENCE; refusing blind reverification');
  }
  // Carry completed receipts through a crash in a later metadata-only checkpoint.
  // Otherwise an interrupted resume could forget slots it had not revisited yet.
  const retainedRecords = prior?.schemaVersion === 2 ? [...prior.records, ...(prior.retainedRecords ?? [])] : [];
  const nativePins = { ...(prior?.nativePins ?? {}), ...Object.fromEntries((prior?.nativeRuns ?? []).map((run) => [run.id, run.digest])) };
  const lockFile = path.join(manifest.generation, '.collection.lock');
  const lock = await fs.open(lockFile, 'wx');
  try {
    let lockedPrior;
    try { lockedPrior = await readJson(reportFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (canonical(lockedPrior) !== canonical(prior)) throw new Error('Collection checkpoint changed while acquiring lock; inspect before resuming');
    await lock.writeFile(JSON.stringify({ pid: process.pid, created: new Date().toISOString() }) + '\n');
    const collectionDir = path.join(manifest.generation, 'collection', randomUUID());
    await fs.mkdir(collectionDir, { recursive: true });
    if (prior) await writeJson(path.join(collectionDir, 'prior-report.json'), prior);
    const report = { schemaVersion: 2, kind: 'tessl-evaluation-and-independent-verification', bindings,
      collectionDir, retainedRecords, nativePins, created: new Date().toISOString(), nativeRuns: [], credits: 0,
      expected: manifest.scenarios.length * manifest.variants.length * manifest.runs, records: [], errors: [], pass: false };
    let revision = 0;
    const expectedSlots = manifest.scenarios.flatMap((scenario) => manifest.variants.flatMap((variant) =>
      Array.from({ length: manifest.runs }, (_, slot) => `${scenario.id}/${variant.label}/${slot}`)));
    const checkpoint = async () => {
      const slots = new Set(report.records.map(slotKey));
      const verified = new Set(report.records.filter((record) => record.verification?.status === 'completed').map(slotKey));
      for (const record of report.records) record.pass = record.nativeGrade.pass && record.activationAudit.pass &&
        record.verification?.status === 'completed' && record.independent.pass === true;
      report.coverage = { nativeComplete: slots.size === expectedSlots.length && expectedSlots.every((slot) => slots.has(slot)),
        complete: expectedSlots.every((slot) => verified.has(slot)) && slots.size === expectedSlots.length &&
          report.records.length === expectedSlots.length,
        missingNative: expectedSlots.filter((slot) => !slots.has(slot)),
        missing: expectedSlots.filter((slot) => !verified.has(slot)) };
      report.credits = report.nativeRuns.reduce((sum, run) => sum + (run.credits ?? 0), 0);
      report.pass = report.coverage.complete && report.errors.length === 0 && report.records.every((record) => record.pass);
      report.checkpoint = path.join(collectionDir, `report-${String(++revision).padStart(4, '0')}.json`);
      await fs.writeFile(report.checkpoint, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      await atomicJson(reportFile, report);
    };
    await checkpoint();
    try {
      // Checkpoint ALL native grades/activation metadata before the first download.
      for (const run of runs) {
        const nativeFile = path.join(manifest.generation, `native-${run.evalRunId}.json`);
        let view;
        try { view = await readJson(nativeFile); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          if (offline || nativePins[run.evalRunId]) throw new Error(`Missing retained native view: ${nativeFile}`);
          const result = await invoke(['eval', 'view', run.evalRunId, '--json']);
          if (result.code !== 0) throw new Error(`Cannot fetch completed native run ${run.evalRunId}: ${result.stderr}`);
          view = JSON.parse(result.stdout);
          await fs.writeFile(nativeFile, JSON.stringify(view, null, 2) + '\n', { flag: 'wx' });
        }
        const nativeDigest = await fileDigest(nativeFile);
        if (nativePins[run.evalRunId] && nativePins[run.evalRunId] !== nativeDigest) throw new Error('Retained native view changed; refusing resume');
        nativePins[run.evalRunId] = nativeDigest;
        const attributes = view.data?.attributes;
        if (view.data?.id !== run.evalRunId) throw new Error(`Native view run identity mismatch: ${run.evalRunId}`);
        if (attributes?.status !== 'completed') throw new Error(`Native run ${run.evalRunId} is not completed`);
        report.nativeRuns.push({ id: run.evalRunId, digest: nativeDigest, credits: attributes.credits, metadata: attributes.runMetadata });
        for (const nativeScenario of attributes.scenarios ?? []) {
          const id = path.posix.basename(nativeScenario.path);
          const scenario = manifest.scenarios.find((item) => item.id === id);
          if (!scenario || nativeScenario.task !== scenario.prompt) throw new Error(`Native task mismatch: ${id}`);
          const expected = await frozenChecklist(manifest, scenario);
          for (const solution of nativeScenario.solutions ?? []) {
            if (!manifest.variants.some((variant) => variant.label === solution.variant) || !/^[0-9a-f-]{36}$/.test(solution.id)) {
              throw new Error(`Unexpected native solution: ${solution.id}/${solution.variant}`);
            }
            const activation = solution.activation ?? solution.runs?.[0]?.activation ?? null;
            const skills = [...new Set(Object.keys(manifest.skillHashes ?? {}).map((name) => name.split('/')[0]))];
            const record = { runId: run.evalRunId, scenarioId: id, variant: solution.variant, solutionId: solution.id,
              slot: solution.solutionMetadata?.evalPipeline?.runSlot, nativeGrade: grade(scenario, solution.assessmentResults, expected),
              activation, activationAudit: auditActivation(scenario, solution.variant, activation, skills.length ? skills : [scenario.skill]),
              download: { status: 'pending' }, verification: { status: 'pending' },
              independent: unavailable('Not independently verified'), pass: false };
            if (!Number.isInteger(record.slot) || record.slot < 0 || record.slot >= manifest.runs ||
                report.records.some((item) => slotKey(item) === slotKey(record) || item.solutionId === solution.id)) {
              throw new Error(`Invalid or duplicate native slot: ${slotKey(record)}`);
            }
            report.records.push(record);
            await checkpoint();
          }
        }
      }
      // Restore/audit every prior outcome before any new remote read. A failed
      // early download must not hide a completed receipt in a later native slot.
      for (const record of report.records) {
        const scenario = manifest.scenarios.find((item) => item.id === record.scenarioId);
        const candidates = retainedRecords.filter((item) => item.solutionId === record.solutionId);
        const saved = candidates.find((item) => item.verification?.status === 'completed') ??
          candidates.find((item) => item.download?.status === 'completed') ?? candidates[0];
        if (saved && (slotKey(saved) !== slotKey(record) || saved.runId !== record.runId)) throw new Error('Resume solution identity changed');
        if (saved?.download.status === 'completed') {
          if (await snapshotDigest(saved.download.directory) !== saved.download.digest) throw new Error(`Resume snapshot changed: ${record.solutionId}`);
          record.download = saved.download;
        }
        if (saved?.verification.status === 'completed') {
          if (record.download.status !== 'completed' || saved.verification.snapshot !== record.download.digest ||
              await fileDigest(saved.verification.file) !== saved.verification.digest) throw new Error(`Resume verification evidence changed: ${record.solutionId}`);
          if (!Array.isArray(saved.verification.support) || saved.verification.support.length === 0) {
            throw new Error(`Resume verification supporting evidence is missing: ${record.solutionId}`);
          }
          for (const item of saved.verification.support) {
            let actual;
            try { actual = await fileDigest(item.file); }
            catch (error) {
              if (error.code !== 'ENOENT') throw error;
              throw new Error(`Resume supporting evidence missing: ${item.file}`);
            }
            if (actual !== item.digest) throw new Error(`Resume supporting evidence changed: ${item.file}`);
          }
          const independent = await readJson(saved.verification.file);
          if (canonical(independent) !== canonical(saved.independent)) throw new Error('Resume verification result mismatch');
          record.independent = independent;
          record.verification = { ...saved.verification, reused: true };
          await checkpoint();
          continue; // Failed completed checks are evidence too: never retry for a pass.
        }
        if (legacyEvidence[record.solutionId]) {
          const adopted = await require('./adopt.cjs').adoptVerification(manifest, scenario, record, legacyEvidence[record.solutionId]);
          Object.assign(record, adopted);
          await checkpoint();
          continue;
        }
        if (saved && ['in-progress', 'failed'].includes(saved.verification?.status)) {
          record.verification = saved.verification;
          record.independent = unavailable('Prior incomplete verification attempt needs operator review; not automatically retried');
          await checkpoint();
          continue;
        }
        if (offline) {
          if (record.download.status === 'pending') record.download.reason = 'Offline collection: remote downloads disabled';
          await checkpoint();
        }
      }
      if (!offline) for (const record of report.records) {
        if (record.verification.status !== 'pending') continue;
        const scenario = manifest.scenarios.find((item) => item.id === record.scenarioId);
        if (record.download.status !== 'completed') {
          const directory = path.join(collectionDir, 'downloads', record.solutionId);
          await fs.mkdir(path.dirname(directory), { recursive: true });
          record.download = { status: 'in-progress', directory };
          await checkpoint();
          try {
            const result = await invoke(['eval', 'download-solutions', record.runId, '--solution', record.solutionId, '--output', directory]);
            if (result.code !== 0) throw new Error(`Cannot download solution ${record.solutionId}: ${result.stderr}`);
            record.download = { status: 'completed', directory, digest: await snapshotDigest(directory) };
          } catch (error) {
            record.download.status = 'failed';
            record.download.reason = error.message;
            await checkpoint();
            throw error; // One failure stops remote reads; no automatic auth/network retry loop.
          }
          await checkpoint();
        }
        const verificationRoot = path.join(manifest.generation, 'verification', record.solutionId);
        await fs.mkdir(verificationRoot, { recursive: true });
        const runDir = await fs.mkdtemp(path.join(verificationRoot, 'attempt-'));
        record.verification = { status: 'in-progress', runDir, snapshot: record.download.digest };
        await checkpoint();
        try {
          const independent = await verifySolution(scenario, record.download.directory, runDir,
            { cacheRoot: path.join(manifest.generation, 'verification-maven') });
          if (independent.kind !== 'independent-executable-verification' || independent.nativeScore !== null ||
              typeof independent.pass !== 'boolean') throw new Error('Invalid independent verification result');
          if (await snapshotDigest(record.download.directory) !== record.download.digest) throw new Error('Solution changed during verification');
          const support = await verificationSupport(runDir, independent);
          // Keep the collector receipt separate from the verifier's own result
          // and bind the actual retained check/runtime/log evidence too.
          const file = path.join(runDir, 'collection-verification.json');
          await writeJson(file, independent);
          record.independent = independent;
          record.verification = { ...record.verification, status: 'completed', file, digest: await fileDigest(file), support };
        } catch (error) {
          record.independent = unavailable(error.message);
          record.verification = { ...record.verification, status: 'failed', reason: error.message };
        }
        await checkpoint();
      }
    } catch (error) { report.errors.push(error.message); }
    await checkpoint();
    return report;
  } finally { await lock.close(); await fs.unlink(lockFile); }
}

module.exports = { collect, grade, auditActivation, frozenChecklist };

if (require.main === module) Promise.resolve().then(async () => {
  const { settings } = require('../../options.cjs');
  const { launch } = require('./run.cjs');
  const options = settings({ ...process.env, EVAL_PROVIDER: 'tessl' });
  const manifest = JSON.parse(await fs.readFile(process.env.TESSL_MANIFEST ?? path.join(options.output, 'manifest.json')));
  const response = JSON.parse(await fs.readFile(process.env.EVAL_RESULTS ?? path.join(manifest.generation, 'result.json')));
  const legacyEvidence = process.env.TESSL_LEGACY_EVIDENCE ? JSON.parse(await fs.readFile(process.env.TESSL_LEGACY_EVIDENCE)) : {};
  const report = await collect({ ...manifest, runs: manifest.runs ?? options.runs }, response, { invoke: launch,
    resume: process.env.TESSL_COLLECT_RESUME === '1', offline: process.env.TESSL_COLLECT_OFFLINE === '1', legacyEvidence });
  const verified = report.records.filter((record) => record.verification.status === 'completed').length;
  console.log(`Native slots ${report.records.length}/${report.expected}; executable outcomes ${verified}/${report.expected}; ` +
    `${report.coverage.missing.length} missing; ${report.credits} credits. Report: ${manifest.generation}/verification-report.json`);
  process.exitCode = report.pass ? 0 : 1;
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
