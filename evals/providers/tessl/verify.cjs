const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { load, select, safePath } = require('../../shared/scenarios.cjs');
const { prepareFixture } = require('../../shared/fixture.cjs');
const { checkJavaTarget } = require('../../shared/java-target.cjs');
const { checkScenario } = require('../../shared/scenario-checks.cjs');
const { environment } = require('./prepare.cjs');
const { writeJson } = require('./generate.cjs');
const { excluded } = require('./evidence.cjs');
const exec = promisify(execFile);

async function verificationEnvironment(runDir, cacheRoot = path.join(runDir, 'maven')) {
  cacheRoot = path.resolve(cacheRoot);
  await fs.mkdir(path.join(cacheRoot, 'repository'), { recursive: true });
  const settings = path.join(cacheRoot, 'settings.xml');
  const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  await fs.writeFile(settings, `<settings><localRepository>${escape(path.join(cacheRoot, 'repository'))}</localRepository></settings>\n`);
  const env = environment();
  const javaHome = process.env.TESSL_VERIFY_JAVA_HOME ?? '/usr/lib64/jvm/java-21-openjdk';
  // Maven and java use the same Java 21. MAVEN_ARGS adds infrastructure settings,
  // not skip flags or changes to the catalog's exact build command.
  return { ...env, JAVA_HOME: javaHome, PATH: `${javaHome}/bin:${env.PATH}`,
    MAVEN_ARGS: `--settings ${settings} -Dmaven.repo.local=${path.join(cacheRoot, 'repository')}`,
    MAVEN_OPTS: `${env.MAVEN_OPTS ?? ''} -Dmaven.repo.local=${path.join(cacheRoot, 'repository')}` };
}

// Import a FULL solution snapshot into a disposable prepared clone, preserving
// its baseline commit. Never trust a downloaded .git or copy stale build output.
async function importSnapshot(source, destination) {
  source = await fs.realpath(source);
  destination = await fs.realpath(destination);
  if (source === destination || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep)) {
    throw new Error('Solution snapshot and verification clone must be separate');
  }
  async function copy(relative = '') {
    for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
      if (!relative && excluded.has(entry.name)) continue;
      const name = path.join(relative, entry.name);
      if (!safePath(name) || entry.isSymbolicLink() || entry.name === '.git') throw new Error(`Unsafe solution path: ${name}`);
      const output = path.join(destination, name);
      if (entry.isDirectory()) {
        await fs.mkdir(output, { recursive: true });
        await copy(name);
      } else if (entry.isFile()) {
        try { if ((await fs.lstat(output)).isSymbolicLink()) throw new Error(`Unsafe verification path: ${name}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.copyFile(path.join(source, name), output);
      } else throw new Error(`Unsupported solution path: ${name}`);
    }
  }
  // Validate source paths before any import. Do not follow symlinked parents.
  async function validate(directory = source, root = true) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (root && excluded.has(item.name)) continue;
      if (item.isSymbolicLink() || item.name === '.git') throw new Error(`Unsafe solution path: ${item.name}`);
      if (item.isDirectory()) await validate(path.join(directory, item.name), false);
    }
  }
  await validate();
  const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: destination, env: environment() });
  for (const name of stdout.split('\0').filter(Boolean)) {
    if (!safePath(name)) throw new Error(`Unsafe tracked verification path: ${name}`);
    try { await fs.lstat(path.join(source, name)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.unlink(path.join(destination, name)); // Only a known tracked file in our disposable clone.
    }
  }
  await copy();
}

async function verify(scenario, solutionDirectory, runDir, { cacheRoot } = {}) {
  const env = await verificationEnvironment(runDir, cacheRoot);
  await writeJson(path.join(runDir, 'verification-runtime.json'), { javaHome: env.JAVA_HOME,
    mavenArgs: env.MAVEN_ARGS, cacheRoot: path.resolve(cacheRoot ?? path.join(runDir, 'maven')),
    commandTimeoutMs: scenario.environment.command_timeout_seconds * 1000 });
  const metadata = { ...await prepareFixture(scenario, runDir, { env }), runDir,
    // This gates executable checks only. It is not a native task-completion or
    // skill-activation assertion; those still require the Tessl records.
    completion: { status: 'completed', summary: 'Operator-supplied full solution snapshot for independent build verification' },
    mavenTimeoutMs: scenario.environment.command_timeout_seconds * 1000 };
  await importSnapshot(solutionDirectory, metadata.workingDir);
  const javaTarget = await checkJavaTarget(metadata, { env });
  const scenarioChecks = await checkScenario(metadata, { env });
  const result = { kind: 'independent-executable-verification', nativeScore: null,
    scenarioId: scenario.id, solutionDirectory: await fs.realpath(solutionDirectory),
    repository: metadata.repository, baselineCommit: metadata.baselineCommit,
    workingDir: metadata.workingDir, pass: javaTarget.pass && scenarioChecks.pass, javaTarget, scenarioChecks };
  await writeJson(path.join(runDir, 'verification.json'), result);
  return result;
}

if (require.main === module) Promise.resolve().then(async () => {
  if (!process.env.TESSL_SOLUTION_DIR) throw new Error('Set TESSL_SOLUTION_DIR to a FULL extracted solution repository, not a patch or metadata directory');
  const scenarios = select(await load(), process.env.SCENARIO ?? '');
  if (scenarios.length !== 1) throw new Error('Select exactly one SCENARIO for this solution');
  const runDir = await fs.mkdtemp('/tmp/opencode/sling-tessl-verification-');
  const result = await verify(scenarios[0], process.env.TESSL_SOLUTION_DIR, runDir);
  console.log(`${result.pass ? 'PASS' : 'FAIL'} independent executable verification: ${path.join(runDir, 'verification.json')}`);
  process.exitCode = result.pass ? 0 : 1;
}).catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { verify, importSnapshot, verificationEnvironment };
