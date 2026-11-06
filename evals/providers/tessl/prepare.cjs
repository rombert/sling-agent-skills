const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createReadStream, createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepareFixture } = require('../../shared/fixture.cjs');
const { childEnvironment } = require('../../shared/process.cjs');
const { writeJson, digest, fixtureRef } = require('./generate.cjs');
const exec = promisify(execFile);

// The Tessl login belongs to the CLI, not to Maven, Git, or the uploaded inputs.
const environment = (env = process.env) => Object.fromEntries(Object.entries(childEnvironment(env))
  .filter(([key]) => key !== 'LITELLM_API_KEY' && !key.startsWith('TESSL_')));

async function verifyPackedContext(manifest) {
  let count = 0;
  for (const [file, hash] of Object.entries(manifest.artifacts)) {
    if (!file.startsWith('context/')) continue;
    const name = file.slice('context/'.length);
    const { stdout } = await exec('tar', ['-xOf', path.join(manifest.generation, 'context-preflight.tgz'), name], {
      encoding: 'buffer', env: environment(), timeout: 10000, maxBuffer: 20 * 1024 * 1024 });
    if (digest(stdout) !== hash) throw new Error(`Tessl native archive omitted/changed input: ${name}`);
    count++;
  }
  return count;
}

async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function provisionToolchain(manifest) {
  const spec = manifest.toolchain;
  const cache = path.join(os.tmpdir(), 'opencode', 'tessl-toolchains');
  await fs.mkdir(cache, { recursive: true });
  const archive = path.join(cache, spec.archive);
  try { await fs.access(archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temporary = `${archive}.${randomUUID()}.part`;
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(`JDK download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    if (await fileDigest(temporary) !== spec.sha256) throw new Error(`JDK checksum mismatch: ${temporary}`);
    await fs.rename(temporary, archive);
  }
  if (await fileDigest(archive) !== spec.sha256) throw new Error(`Cached JDK checksum mismatch: ${archive}`);
  const directory = path.join(manifest.generation, 'toolchain');
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(archive, path.join(directory, 'jdk.tar.gz'), require('node:fs').constants.COPYFILE_FICLONE);
  await fs.writeFile(path.join(directory, 'sha256.txt'), spec.sha256 + '\n');
  return directory;
}

async function rehearsalInputs(manifest, directory) {
  const source = path.join(directory, 'jdk.tar.gz');
  if (await fileDigest(source) !== manifest.toolchain.sha256) throw new Error('Rehearsal SDK differs from the frozen toolchain pin');
  let archive = source;
  const cached = path.join(os.tmpdir(), 'opencode', 'tessl-toolchains', manifest.toolchain.archive);
  try {
    if (await fileDigest(cached) !== manifest.toolchain.sha256) throw new Error('Cached rehearsal SDK checksum mismatch');
    archive = cached;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Store the immutable SDK blob once per generation, outside the temporary
  // rehearsal filesystem. Alternates keep every synthetic snapshot complete
  // without writing the same 200-MB blob into each disposable Git repository.
  const options = { cwd: manifest.generation, env: environment(), timeout: 120000 };
  const jdkBlob = (await exec('git', ['hash-object', '-w', source], options)).stdout.trim();
  await exec('git', ['-c', 'core.hooksPath=/dev/null', 'update-ref', 'refs/eval-inputs/java21', jdkBlob], options);
  return { archive, jdkBlob, objectDirectory: path.join(manifest.generation, '.git/objects') };
}

async function prepare(manifest, { toolchain = provisionToolchain } = {}) {
  const temp = path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(temp, { recursive: true });
  const toolchainDirectory = await toolchain(manifest);
  const sharedInputs = await rehearsalInputs(manifest, toolchainDirectory);
  const evidence = [];
  for (const scenario of manifest.scenarios) {
    const runDir = await fs.mkdtemp(path.join(temp, 'sling-tessl-fixture-'));
    const fixture = await prepareFixture(scenario, runDir, { env: environment() });
    const resources = path.join(manifest.source, scenario.id, 'resources');
    await exec('git', ['bundle', 'create', path.join(resources, 'source.bundle'), 'HEAD'], {
      cwd: fixture.workingDir, env: environment(), timeout: 120000, maxBuffer: 1024 * 1024 });
    await fs.writeFile(path.join(resources, 'baseline.txt'), fixture.baselineCommit + '\n');
    await writeJson(path.join(resources, 'repository.json'), fixture.repository);
    // Tessl packs commit fixtures from the generation's Git boundary, not the
    // remote repoUrl. Import the prepared baseline there without checkout or
    // touching any source/harness refs. Native scoring needs this fixture's Git
    // metadata in addition to the history installed by our setup script.
    const ref = fixtureRef(scenario);
    await exec('git', ['fetch', '--quiet', path.join(resources, 'source.bundle'), `HEAD:${ref}`], {
      cwd: manifest.generation, env: environment(), timeout: 120000 });
    const imported = (await exec('git', ['rev-parse', ref], { cwd: manifest.generation, env: environment() })).stdout.trim();
    if (imported !== fixture.baselineCommit) throw new Error(`Native commit fixture mismatch: ${scenario.id}`);
    // Rehearse a populated, single-commit native snapshot, not an empty folder.
    const rehearsal = path.join(runDir, 'rehearsal');
    await fs.mkdir(rehearsal);
    const archive = path.join(runDir, 'native-baseline.tar');
    await exec('git', ['archive', '--format=tar', `--output=${archive}`, ref], {
      cwd: manifest.generation, env: environment(), timeout: 120000 });
    await exec('tar', ['-xf', archive, '-C', rehearsal], { env: environment() });
    // Tessl snapshots installed includes and directory fixtures together with
    // the codebase before setup; they are tracked in the synthetic commit too.
    await fs.cp(resources, path.join(rehearsal, 'resources'), { recursive: true });
    await fs.cp(toolchainDirectory, path.join(rehearsal, '.eval-toolchain'), {
      recursive: true, mode: require('node:fs').constants.COPYFILE_FICLONE,
      filter: (file) => file !== path.join(toolchainDirectory, 'jdk.tar.gz') });
    const sdkInput = path.join(rehearsal, '.eval-toolchain/jdk.tar.gz');
    try { await fs.link(sharedInputs.archive, sdkInput); }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP'].includes(error.code)) throw error;
      await fs.copyFile(sharedInputs.archive, sdkInput, require('node:fs').constants.COPYFILE_FICLONE);
    }
    await exec('git', ['init', '--quiet', '--initial-branch=main', '--object-format=sha1', '--template=', '.'], {
      cwd: rehearsal, env: environment(), timeout: 120000 });
    await fs.mkdir(path.join(rehearsal, '.git/objects/info'), { recursive: true });
    await fs.writeFile(path.join(rehearsal, '.git/objects/info/alternates'), sharedInputs.objectDirectory + '\n');
    for (const command of [
      ['add', '--all'],
      ['-c', 'user.name=Native Fixture', '-c', 'user.email=native@example.invalid', '-c', 'core.hooksPath=/dev/null',
        'commit', '--quiet', '--no-gpg-sign', '-m', 'Native fixture snapshot'],
    ]) await exec('git', command, { cwd: rehearsal, env: environment(), timeout: 120000 });
    const runtimeRoot = path.join(runDir, 'runtime');
    const result = await exec('sh', [path.join(manifest.source, scenario.id, 'init-repo.sh')], {
      cwd: rehearsal, env: { ...environment(), EVAL_RUNTIME_ROOT: runtimeRoot }, timeout: 120000, maxBuffer: 1024 * 1024 });
    await fs.writeFile(path.join(runDir, 'setup.log'), result.stdout + result.stderr);
    const actual = (await exec('git', ['rev-parse', 'HEAD'], { cwd: rehearsal, env: environment() })).stdout.trim();
    if (actual !== fixture.baselineCommit) throw new Error(`Tessl setup baseline mismatch: ${scenario.id}`);
    evidence.push({ id: scenario.id, runDir, rehearsal, runtimeRoot, baselineCommit: actual, nativeFixture: { ref, revision: imported }, sharedInputs,
      repository: fixture.repository, environment: fixture.environment });
  }
  await writeJson(path.join(manifest.generation, 'preparation.json'), evidence);
  return evidence;
}

module.exports = { prepare, environment, verifyPackedContext, provisionToolchain, fileDigest, rehearsalInputs };

if (require.main === module) Promise.resolve().then(async () => {
  const { settings } = require('../../options.cjs');
  const { plan } = require('./run.cjs');
  const { manifest, solves } = await plan(settings({ ...process.env, EVAL_PROVIDER: 'tessl' }));
  const result = await exec('tessl', ['eval', 'lint', manifest.source], { cwd: require('../../shared/scenarios.cjs').projectRoot });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const packed = await exec('tessl', ['plugin', 'pack', manifest.context, '--output', path.join(manifest.generation, 'context-preflight.tgz')]);
  process.stdout.write(packed.stdout);
  process.stderr.write(packed.stderr);
  console.log(`Verified ${await verifyPackedContext(manifest)} frozen input hashes in the native plugin archive.`);
  const evidence = await prepare(manifest);
  console.log(`Prepared/rehearsed ${evidence.length} fixtures locally. Planned batch: ${solves} solves. Nothing submitted.`);
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
