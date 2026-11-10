const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { adoptVerification } = require('./adopt.cjs');
const { readTarget } = require('../../shared/java-target.cjs');
const { canonical, fileDigest } = require('./evidence.cjs');
const exec = promisify(execFile);

test('explicit legacy adoption checks matching source/pin/checks and preserves failed evidence without building', async (t) => {
  const generation = await fs.mkdtemp('/tmp/opencode/tessl-adopt-test-');
  t.after(() => fs.rm(generation, { recursive: true, force: true }));
  const record = { solutionId: '01a1b212-7646-74f1-94f0-a7298f52e7b8' };
  const runDir = path.join(generation, 'verification', record.solutionId, 'attempt-old');
  const workingDir = path.join(runDir, 'project');
  const solutionDirectory = path.join(generation, 'solutions', record.solutionId);
  const resources = path.join(generation, 'scenarios', 'sample', 'resources');
  const targets = path.join(runDir, 'java-target-old');
  for (const directory of [workingDir, solutionDirectory, resources, targets]) await fs.mkdir(directory, { recursive: true });
  const pom = '<project><modelVersion>4.0.0</modelVersion><parent><groupId>org.apache.sling</groupId><artifactId>sling</artifactId><version>60</version></parent>' +
    '<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>11</release></configuration></plugin></plugins></build></project>';
  for (const directory of [workingDir, solutionDirectory]) await fs.writeFile(path.join(directory, 'pom.xml'), pom);
  const git = (args) => exec('git', args, { cwd: workingDir });
  await git(['init', '--quiet', '--template=']);
  await git(['add', 'pom.xml']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'Test baseline']);
  const baselineCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const repository = { url: 'https://example.invalid/repository.git', revision: baselineCommit };
  const scenario = { id: 'sample', repository, fixture: { initial_java_bytecode_target: 11 }, checks: [
    { id: 'maven_verify', type: 'command' },
    { id: 'parent', type: 'pom_parent', path: 'pom.xml', expected: { group_id: 'org.apache.sling', artifact_id: 'sling', version: '60' } },
  ] };
  const checks = [{ id: 'maven_verify', pass: false, reason: 'Existing test failure' }, { id: 'parent', pass: true, reason: 'Exact parent coordinates match' }];
  const independent = { kind: 'independent-executable-verification', nativeScore: null, scenarioId: scenario.id,
    workingDir, solutionDirectory, repository, baselineCommit, pass: false,
    javaTarget: { pass: true }, scenarioChecks: { pass: false, checks } };
  const json = (file, value) => fs.writeFile(file, JSON.stringify(value));
  await json(path.join(runDir, 'scenario.json'), scenario);
  await json(path.join(runDir, 'repository.json'), repository);
  await json(path.join(runDir, 'environment.json'), { java: '21', maven: '3.10' });
  await json(path.join(runDir, 'scenario-checks.json'), checks);
  await fs.writeFile(path.join(runDir, 'maven-verify.log'), '[INFO] BUILD FAILURE\nExisting test failure\n');
  await fs.writeFile(path.join(resources, 'baseline.txt'), baselineCommit + '\n');
  await json(path.join(generation, 'preparation.json'), [{ id: scenario.id, baselineCommit, repository }]);
  for (const label of ['before', 'after']) {
    await fs.writeFile(path.join(targets, `${label}-effective-pom.xml`), pom);
    await fs.writeFile(path.join(targets, `${label}-maven.log`), '[INFO] BUILD SUCCESS\n');
  }
  const target = await readTarget(path.join(targets, 'before-effective-pom.xml'));
  await json(path.join(targets, 'comparison.json'), { baselineCommit, before: target, after: target, pass: true });
  const file = path.join(runDir, 'verification.json');
  await json(file, independent);
  const before = await fileDigest(file);
  const adopted = await adoptVerification({ generation }, scenario, record, file);
  assert.equal(adopted.verification.status, 'completed');
  assert.equal(adopted.verification.provenance, 'explicit-read-only-legacy-adoption');
  assert.equal(adopted.independent.pass, false);
  assert.equal(canonical(adopted.independent), canonical(independent));
  assert.equal(await fileDigest(file), before);
  assert.equal(adopted.verification.support.length, 13);
  await fs.writeFile(path.join(solutionDirectory, 'pom.xml'), 'changed');
  await assert.rejects(adoptVerification({ generation }, scenario, record, file), /snapshot mismatch/);
  await fs.writeFile(path.join(solutionDirectory, 'pom.xml'), pom);
  await json(path.join(runDir, 'scenario-checks.json'), checks.slice(1));
  await assert.rejects(adoptVerification({ generation }, scenario, record, file), /check results mismatch/);
  await json(path.join(runDir, 'scenario-checks.json'), checks);
  await assert.rejects(adoptVerification({ generation }, { ...scenario, id: 'different' }, record, file), /frozen scenario\/check policy mismatch/);
});
