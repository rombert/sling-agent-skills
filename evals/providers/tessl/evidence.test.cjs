const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { snapshotDigest, canonical } = require('./evidence.cjs');
const { verificationEnvironment } = require('./verify.cjs');

test('snapshot receipts include imported bytes and executable modes, not stale outputs or downloaded Git', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/tessl-evidence-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'pom.xml'), '<project/>');
  const before = await snapshotDigest(root);
  for (const name of ['.git', 'target', 'resources', '.eval-toolchain']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'untrusted'), 'ignored');
  }
  assert.equal(await snapshotDigest(root), before);
  await fs.chmod(path.join(root, 'pom.xml'), 0o755);
  assert.notEqual(await snapshotDigest(root), before);
  await fs.chmod(path.join(root, 'pom.xml'), 0o644);
  assert.equal(await snapshotDigest(root), before);
  await fs.symlink('pom.xml', path.join(root, 'linked.xml'));
  await assert.rejects(snapshotDigest(root), /Unsafe solution path/);
  await fs.unlink(path.join(root, 'linked.xml'));
  await fs.mkdir(path.join(root, 'src/.git'), { recursive: true });
  await assert.rejects(snapshotDigest(root), /Unsafe solution path/);
});

test('canonical fingerprints ignore object key ordering but retain array order', () => {
  assert.equal(canonical({ b: 2, a: [{ z: 1, y: 0 }] }), canonical({ a: [{ y: 0, z: 1 }], b: 2 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
});

test('independent Java/Maven environment uses provider-owned writable cache/settings without shared-cache hardlinks', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/tessl-maven-env-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = await verificationEnvironment(root);
  assert.equal(env.JAVA_HOME, process.env.TESSL_VERIFY_JAVA_HOME ?? '/usr/lib64/jvm/java-21-openjdk');
  assert.ok(env.PATH.startsWith(`${env.JAVA_HOME}/bin:`));
  assert.match(env.MAVEN_ARGS, /--settings .*\/maven\/settings.xml -Dmaven.repo.local=.*\/maven\/repository/);
  assert.ok(env.MAVEN_OPTS.endsWith(`-Dmaven.repo.local=${root}/maven/repository`));
  assert.equal(await fs.readFile(path.join(root, 'maven/settings.xml'), 'utf8'),
    `<settings><localRepository>${root}/maven/repository</localRepository></settings>\n`);
  assert.deepEqual(await fs.readdir(path.join(root, 'maven/repository')), []);
  assert.equal(env.LITELLM_API_KEY, undefined);
  assert.equal(Object.keys(env).some((key) => key.startsWith('TESSL_')), false);
});
