const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);

async function readParent(file) {
  const { stdout } = await exec('python3', [path.join(__dirname, 'pom_parent.py'), file], { timeout: 10000 });
  return JSON.parse(stdout);
}

const coordinates = (parent) => `${parent.groupId}:${parent.artifactId}:${parent.version}`;
const isSlingRelease = (parent) => parent?.groupId === 'org.apache.sling' &&
  ['sling', 'sling-bundle-parent'].includes(parent.artifactId) && /^\d+$/.test(parent.version);

async function checkUpgrade(metadata) {
  const fail = (reason) => ({ pass: false, score: 0, reason });
  if (!metadata?.workingDir || !metadata?.initialParent) return fail('Missing workspace or baseline parent');
  if (metadata.completion?.status !== 'completed') {
    return fail(`Task did not complete: ${metadata.completion?.summary ?? 'finish_task was not called'}`);
  }
  try {
    const before = metadata.initialParent;
    const after = await readParent(path.join(metadata.workingDir, 'pom.xml'));
    if (!isSlingRelease(before)) return fail(`Unsupported baseline parent: ${coordinates(before)}`);
    if (!isSlingRelease(after)) return fail(`Expected a released Sling parent, got ${coordinates(after)}`);
    if (BigInt(after.version) <= BigInt(before.version)) {
      return fail(`Parent was not upgraded: ${coordinates(before)} -> ${coordinates(after)}`);
    }
    return { pass: true, score: 1, reason: `Parent upgraded: ${coordinates(before)} -> ${coordinates(after)}` };
  } catch (error) {
    return fail(`Cannot validate parent POM: ${error.message}`);
  }
}

module.exports = (_output, context) => checkUpgrade(context.providerResponse?.metadata);
module.exports.readParent = readParent;
module.exports.checkUpgrade = checkUpgrade;
