const path = require('node:path');
const { run, tail } = require('./tools.cjs');
const { checkUpgrade } = require('./parent-upgrade.cjs');

module.exports = async (_output, context) => {
  const metadata = context.providerResponse?.metadata;
  if (!metadata?.workingDir || !metadata?.runDir) {
    return { pass: false, score: 0, reason: 'Missing edited workspace; refusing to build the original checkout' };
  }
  const upgrade = await checkUpgrade(metadata);
  if (!upgrade.pass) {
    return { pass: false, score: 0, reason: `Maven not run: ${upgrade.reason}` };
  }
  const log = path.join(metadata.runDir, 'maven-verify.log');
  try {
    const result = await run('mvn', ['clean', 'verify'], {
      cwd: metadata.workingDir, log, timeoutMs: metadata.mavenTimeoutMs ?? 1200000,
    });
    const pass = result.code === 0 && !result.timedOut;
    return {
      pass, score: pass ? 1 : 0,
      reason: pass ? `mvn clean verify passed. Log: ${log}` :
        `mvn clean verify ${result.timedOut ? 'timed out' : `exited ${result.code} (${result.signal ?? 'no signal'})`}. Log: ${log}\n${await tail(log)}`,
    };
  } catch (error) {
    return { pass: false, score: 0, reason: `Unable to run mvn clean verify: ${error.message}. Log: ${log}` };
  }
};
