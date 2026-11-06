const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const exec = promisify(execFile);

// Requires a locally prepared standalone generation and an existing Linux image
// with Git, POSIX sh and Maven. Never pulls an image or submits a paid evaluation.
test('real pinned SDK initializes without setup env, root, writable parent, network or executable tmp', {
  skip: process.env.TESSL_ROOTLESS_TEST !== '1', timeout: 180000,
}, async () => {
  const manifest = JSON.parse(await fs.readFile(process.env.TESSL_MANIFEST ?? 'target/evals/tessl/manifest.json'));
  const id = 'discovery-standalone-parent-46-to-52';
  assert.ok(manifest.scenarios.some((scenario) => scenario.id === id));
  const root = await fs.mkdtemp('/tmp/opencode/tessl-rootless-regression-');
  await fs.mkdir(path.join(root, 'solution'));
  await fs.mkdir(path.join(root, 'initial-bin'));
  // Exercise dash's cached-path behavior even if this local image has Java 21.
  await fs.writeFile(path.join(root, 'initial-bin/java'), '#!/bin/sh\nprintf \'openjdk version "25.0.4.1"\\n\' >&2\n', { mode: 0o755 });
  const reference = process.env.TESSL_REFERENCE_POM;
  const script = `#!/bin/sh
set -eu
cp -a /input/scenarios/${id}/resources /workspace/solution/resources
cp /input/scenarios/${id}/init-repo.sh /workspace/solution/init-repo.sh
cp -a /input/toolchain /workspace/solution/.eval-toolchain
cd /workspace/solution
# Hosted setup may not receive the agent's env-file variables.
env -u EVAL_RUNTIME_ROOT -u JAVA_HOME PATH="/workspace/initial-bin:$PATH" sh ./init-repo.sh
export JAVA_HOME=/workspace/solution/.eval-toolchain/runtime/jdk-21
export PATH="$JAVA_HOME/../bin:$JAVA_HOME/bin:$PATH"
java -version
mvn -version
test ! -e resources
test -z "$(git status --porcelain)"
${reference ? 'cp /reference-pom.xml pom.xml\nmvn -B -o -Dmaven.repo.local=/m2 clean verify' : ''}
`;
  await fs.writeFile(path.join(root, 'rehearse.sh'), script);
  const args = ['run', '--rm', '--pull=never', '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,noexec,size=1g,mode=1777', '--user', `${process.getuid()}:${process.getgid()}`,
    '--entrypoint', '/bin/sh', '-v', `${manifest.generation}:/input:ro`, '-v', `${root}:/workspace:ro`,
    '-v', `${root}/solution:/workspace/solution`];
  if (reference) args.push('-v', `${path.resolve(reference)}:/reference-pom.xml:ro`,
    '-v', `${process.env.HOME}/.m2/repository:/m2:ro`);
  args.push(process.env.TESSL_ROOTLESS_IMAGE ?? 'sling-llmao-pi:1.1.0-jdk21-v3', '/workspace/rehearse.sh');
  let output;
  try { const result = await exec('docker', args, { timeout: 160000, maxBuffer: 8 * 1024 * 1024 }); output = result.stdout + result.stderr; }
  catch (error) { output = (error.stdout ?? '') + (error.stderr ?? ''); throw error; }
  finally {
    await fs.writeFile(path.join(manifest.generation, 'rootless-container-build.log'), output ?? 'No output');
    console.log(`Retained rootless regression workspace: ${root}`);
  }
  assert.match(output, /Java version: 21\./);
  if (reference) assert.match(output, /BUILD SUCCESS/);
});
