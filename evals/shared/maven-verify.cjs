const path = require('node:path');
const { run, tail } = require('./process.cjs');
const { checkUpgrade } = require('./parent-upgrade.cjs');

async function checkMavenVerify(metadata, { env } = {}) {
  if (!metadata?.workingDir || !metadata?.runDir) {
    return { pass: false, reason: 'Missing edited workspace; refusing to build the original checkout' };
  }
  const upgrade = await checkUpgrade(metadata);
  if (!upgrade.pass) {
    return { pass: false, reason: `Maven not run: ${upgrade.reason}` };
  }
  const log = path.join(metadata.runDir, 'maven-verify.log');
  try {
    const result = await run('mvn', ['clean', 'verify'], {
      cwd: metadata.workingDir, log, timeoutMs: metadata.mavenTimeoutMs ?? 1200000, env,
    });
    const pass = result.code === 0 && !result.timedOut;
    return {
      pass,
      reason: pass ? `mvn clean verify passed. Log: ${log}` :
        `mvn clean verify ${result.timedOut ? 'timed out' : `exited ${result.code} (${result.signal ?? 'no signal'})`}. Log: ${log}\n${await tail(log)}`,
    };
  } catch (error) {
    return { pass: false, reason: `Unable to run mvn clean verify: ${error.message}. Log: ${log}` };
  }
}

module.exports = { checkMavenVerify };
