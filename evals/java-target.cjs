const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { run, tail } = require('./process.cjs');
const { checkUpgrade } = require('./parent-upgrade.cjs');

const exec = promisify(execFile);

async function readTarget(file) {
  const { stdout } = await exec('python3', [path.join(__dirname, 'pom_java_target.py'), file], { timeout: 10000 });
  return JSON.parse(stdout);
}

async function checkJavaTarget(metadata) {
  const fail = (reason) => ({ pass: false, score: 0, reason });
  if (!metadata?.runDir || !metadata?.workingDir || !/^[a-f0-9]{40,64}$/.test(metadata.baselineCommit ?? '')) {
    return fail('Missing workspace or baseline commit; cannot verify inherited Java target');
  }
  const upgrade = await checkUpgrade(metadata);
  if (!upgrade.pass) return fail(`Java target not checked: ${upgrade.reason}`);
  let artifacts;
  try {
    artifacts = await fs.mkdtemp(path.join(metadata.runDir, 'java-target-'));
    const baseline = path.join(artifacts, 'baseline');
    const git = (args) => exec('git', args, { timeout: 30000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        key !== 'LITELLM_API_KEY' && !key.startsWith('GIT_'))),
    });
    // Never check out/reset the edited workspace or the user's source checkout.
    await git(['clone', '--quiet', '--no-local', '--no-hardlinks', metadata.workingDir, baseline]);
    await git(['-C', baseline, 'checkout', '--quiet', '--detach', metadata.baselineCommit]);
    await git(['-C', baseline, 'remote', 'remove', 'origin']);
    const targets = {};
    for (const [label, cwd] of [['before', baseline], ['after', metadata.workingDir]]) {
      const file = path.join(artifacts, `${label}-effective-pom.xml`);
      const log = path.join(artifacts, `${label}-maven.log`);
      const result = await run('mvn', ['-B', '-ntp',
        'org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom', `-Doutput=${file}`], {
        cwd, log, timeoutMs: metadata.mavenTimeoutMs ?? 1200000,
      });
      if (result.code !== 0 || result.timedOut) {
        throw new Error(`${label} effective POM ${result.timedOut ? 'timed out' : `exited ${result.code}`}. Log: ${log}\n${await tail(log)}`);
      }
      targets[label] = await readTarget(file);
    }
    const changes = ['main', 'test'].filter((kind) =>
      JSON.stringify(targets.before.targets[kind]) !== JSON.stringify(targets.after.targets[kind]));
    const pass = changes.length === 0;
    await fs.writeFile(path.join(artifacts, 'comparison.json'), JSON.stringify({
      baselineCommit: metadata.baselineCommit, ...targets, pass,
    }, null, 2));
    return { pass, score: pass ? 1 : 0, reason: pass ?
      `Java bytecode targets preserved: main=${targets.before.targets.main}, test=${targets.before.targets.test}. Evidence: ${artifacts}` :
      `Java bytecode target changed: ${changes.map((kind) => `${kind} ${targets.before.targets[kind]} -> ${targets.after.targets[kind]}`).join('; ')}. Build JDK requirements do not justify changing the bytecode target. Evidence: ${artifacts}` };
  } catch (error) {
    return fail(`Cannot validate Java bytecode target: ${error.message}${artifacts ? `; artifacts: ${artifacts}` : ''}`);
  }
}

module.exports = (_output, context) => checkJavaTarget(context.providerResponse?.metadata);
module.exports.checkJavaTarget = checkJavaTarget;
module.exports.readTarget = readTarget;
