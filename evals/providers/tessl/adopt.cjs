const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { canonical, fileDigest, snapshotDigest } = require('./evidence.cjs');
const { readTarget } = require('../../shared/java-target.cjs');
const { check } = require('../../shared/scenario-checks.cjs');
const { environment } = require('./prepare.cjs');
const exec = promisify(execFile);

// Explicit, read-only migration of pre-checkpoint evidence. Never discover and
// bless an arbitrary old build automatically, and never rerun its Maven command.
async function adoptVerification(manifest, scenario, record, verificationFile) {
  verificationFile = await fs.realpath(verificationFile);
  const generation = await fs.realpath(manifest.generation);
  const attempt = path.dirname(verificationFile);
  const prefix = path.join(generation, 'verification', record.solutionId) + path.sep;
  if (!attempt.startsWith(prefix)) throw new Error('Legacy evidence is outside this solution verification root');
  const read = async (file) => JSON.parse(await fs.readFile(file));
  const independent = await read(verificationFile);
  const requireMatch = (actual, expected, label) => {
    if (canonical(actual) !== canonical(expected)) throw new Error(`Legacy ${label} mismatch`);
  };
  requireMatch(await read(path.join(attempt, 'scenario.json')), scenario, 'frozen scenario/check policy');
  if (independent.kind !== 'independent-executable-verification' || independent.nativeScore !== null ||
      independent.scenarioId !== scenario.id || typeof independent.pass !== 'boolean') throw new Error('Invalid legacy verification result');
  const solution = await fs.realpath(path.join(generation, 'solutions', record.solutionId));
  requireMatch(await fs.realpath(independent.solutionDirectory), solution, 'solution directory');
  requireMatch(await fs.realpath(independent.workingDir), path.join(attempt, 'project'), 'independent clone');
  const snapshot = await snapshotDigest(solution);
  requireMatch(await snapshotDigest(independent.workingDir), snapshot, 'imported source snapshot');
  requireMatch(independent.repository.url, scenario.repository.url, 'repository URL');
  requireMatch(independent.repository.revision, scenario.repository.revision, 'source pin');
  requireMatch(await read(path.join(attempt, 'repository.json')), independent.repository, 'repository evidence');
  const baselineFile = path.join(generation, 'scenarios', scenario.id, 'resources/baseline.txt');
  const baseline = (await fs.readFile(baselineFile, 'utf8')).trim();
  requireMatch(independent.baselineCommit, baseline, 'prepared baseline');
  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: independent.workingDir, env: environment() })).stdout.trim();
  requireMatch(head, baseline, 'verification clone baseline');
  const preparationFile = path.join(generation, 'preparation.json');
  const prepared = (await read(preparationFile)).find((item) => item.id === scenario.id);
  requireMatch(prepared?.baselineCommit, baseline, 'preparation baseline');
  requireMatch(prepared?.repository, independent.repository, 'prepared source');
  const checksFile = path.join(attempt, 'scenario-checks.json');
  const results = await read(checksFile);
  requireMatch(results, independent.scenarioChecks.checks, 'retained check results');
  requireMatch(results.map((item) => item.id).sort(), scenario.checks.map((item) => item.id).sort(), 'exact check coverage');
  for (const item of scenario.checks.filter((item) => item.type !== 'command')) {
    let pass = true;
    try { await check(item, { workingDir: independent.workingDir }); } catch { pass = false; }
    requireMatch(results.find((result) => result.id === item.id).pass, pass, `artifact check ${item.id}`);
  }
  const targetDirectories = (await fs.readdir(attempt)).filter((name) => name.startsWith('java-target-'));
  if (targetDirectories.length !== 1) throw new Error('Ambiguous legacy Java target evidence');
  const target = path.join(attempt, targetDirectories[0]);
  const comparisonFile = path.join(target, 'comparison.json');
  const comparison = await read(comparisonFile);
  requireMatch(comparison.baselineCommit, baseline, 'Java target baseline');
  for (const label of ['before', 'after']) {
    requireMatch(await readTarget(path.join(target, `${label}-effective-pom.xml`)), comparison[label], `${label} effective targets`);
    for (const kind of ['main', 'test']) requireMatch(comparison[label].targets[kind],
      [scenario.fixture.initial_java_bytecode_target], `${label} ${kind} target`);
  }
  requireMatch(comparison.pass, true, 'target comparison');
  requireMatch(independent.javaTarget.pass, true, 'Java target result');
  requireMatch(independent.scenarioChecks.pass, results.every((item) => item.pass), 'combined check result');
  requireMatch(independent.pass, independent.javaTarget.pass && independent.scenarioChecks.pass, 'combined executable result');
  const log = path.join(attempt, 'maven-verify.log');
  const text = await fs.readFile(log, 'utf8');
  const command = scenario.checks.find((item) => item.type === 'command');
  const commandPass = results.find((item) => item.id === command.id).pass;
  if (!text.includes(commandPass ? 'BUILD SUCCESS' : 'BUILD FAILURE')) throw new Error('Legacy Maven outcome lacks retained log evidence');
  const files = [verificationFile, path.join(attempt, 'scenario.json'), path.join(attempt, 'repository.json'),
    path.join(attempt, 'environment.json'), baselineFile, preparationFile, checksFile, comparisonFile, log,
    ...['before', 'after'].flatMap((label) => [path.join(target, `${label}-effective-pom.xml`), path.join(target, `${label}-maven.log`)])];
  const support = await Promise.all(files.map(async (file) => ({ file, digest: await fileDigest(file) })));
  return { independent, download: { status: 'completed', directory: solution, digest: snapshot },
    verification: { status: 'completed', provenance: 'explicit-read-only-legacy-adoption', runDir: attempt,
      file: verificationFile, digest: await fileDigest(verificationFile), snapshot, support } };
}

module.exports = { adoptVerification };
