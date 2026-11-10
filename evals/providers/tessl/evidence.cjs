const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { safePath } = require('../../shared/scenarios.cjs');
const { digest } = require('./generate.cjs');

const excluded = new Set(['.git', 'target', 'resources', '.eval-toolchain', 'init-repo.sh', 'setup.sh']);
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Hash exactly the full source snapshot imported by verify, never its .git or
// stale build outputs. Reject links and special files rather than following them.
async function snapshotDigest(directory) {
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Snapshot root must be a real directory');
  const entries = [];
  async function visit(relative = '') {
    for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && excluded.has(entry.name)) continue;
      const name = path.posix.join(relative, entry.name);
      if (!safePath(name) || entry.name === '.git' || entry.isSymbolicLink()) throw new Error(`Unsafe solution path: ${name}`);
      const file = path.join(directory, name);
      if (entry.isDirectory()) { entries.push([name, 'directory']); await visit(name); }
      else if (entry.isFile()) entries.push([name, (await fs.stat(file)).mode & 0o111, await fileDigest(file)]);
      else throw new Error(`Unsupported solution path: ${name}`);
    }
  }
  await visit();
  if (!entries.some(([name]) => name === 'pom.xml')) throw new Error('Missing pom.xml in full solution snapshot');
  return digest(canonical(entries));
}

async function verificationSupport(runDir, independent) {
  const required = new Set(['verification.json', 'verification-runtime.json', 'environment.json', 'scenario.json', 'repository.json']);
  if (Array.isArray(independent.scenarioChecks?.checks)) required.add('scenario-checks.json');
  if (independent.scenarioChecks?.pass) required.add('maven-verify.log');
  const files = new Set([...required, 'scenario-checks.json', 'maven-verify.log']);
  const targets = (await fs.readdir(runDir, { withFileTypes: true })).filter((entry) => entry.name.startsWith('java-target-'));
  if (independent.javaTarget?.pass && targets.length !== 1) throw new Error('Missing or ambiguous retained Java target evidence');
  for (const entry of targets) {
    if (!entry.isDirectory()) throw new Error(`Unsafe verification evidence directory: ${entry.name}`);
    const names = ['comparison.json', 'before-effective-pom.xml', 'after-effective-pom.xml', 'before-maven.log', 'after-maven.log'];
    for (const name of names) {
      const relative = path.join(entry.name, name);
      files.add(relative);
      // Failed target checks can legitimately stop before producing every file;
      // hash whatever they retained, without inventing evidence or an outcome.
      if (independent.javaTarget?.pass) required.add(relative);
    }
  }
  const support = [];
  for (const name of [...files].sort()) {
    const file = path.join(runDir, name);
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (required.has(name)) throw new Error(`Missing retained verification evidence: ${name}`);
      continue;
    }
    if (!stat.isFile()) throw new Error(`Unsafe retained verification evidence: ${name}`);
    support.push({ file, digest: await fileDigest(file) });
  }
  if (canonical(JSON.parse(await fs.readFile(path.join(runDir, 'verification.json')))) !== canonical(independent)) {
    throw new Error('Retained verification.json does not match the returned independent result');
  }
  if (Array.isArray(independent.scenarioChecks?.checks) &&
      canonical(JSON.parse(await fs.readFile(path.join(runDir, 'scenario-checks.json')))) !== canonical(independent.scenarioChecks.checks)) {
    throw new Error('Retained scenario-checks.json does not match the independent check results');
  }
  return support;
}

async function verifierIdentity() {
  const shared = path.join(__dirname, '../../shared');
  const files = ['verify.cjs', 'prepare.cjs', 'generate.cjs', 'collect.cjs', 'evidence.cjs', 'adopt.cjs'].map((name) => path.join(__dirname, name));
  files.push(path.join(__dirname, '../../../package-lock.json'));
  for (const name of (await fs.readdir(shared)).sort()) if (name.endsWith('.cjs')) files.push(path.join(shared, name));
  return digest(canonical(await Promise.all(files.map(async (file) => [path.relative(__dirname, file), await fileDigest(file)]))));
}

async function frozenIdentity(manifest) {
  for (const [name, hash] of Object.entries(manifest.artifacts ?? {})) {
    if (!safePath(name) || await fileDigest(path.join(manifest.generation, name)) !== hash) {
      throw new Error(`Frozen Tessl input changed or is missing: ${name}`);
    }
  }
  return digest(canonical(manifest));
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}

module.exports = { excluded, canonical, fileDigest, snapshotDigest, verificationSupport, verifierIdentity, frozenIdentity, atomicJson };
