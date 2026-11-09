const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepareFixture } = require('../../shared/fixture.cjs');
const { checkUpgrade } = require('../../shared/parent-upgrade.cjs');
const { checkJavaTarget } = require('../../shared/java-target.cjs');
const { checkScenario } = require('../../shared/scenario-checks.cjs');
const { childEnvironment } = require('./environment.cjs');

const exec = promisify(execFile);
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');

async function dispatch(operation, input) {
  const env = childEnvironment();
  if (operation === 'prepare') {
    await fs.mkdir(input.runDir, { recursive: true });
    return { ...await prepareFixture(input.scenario, input.runDir, { env }), runDir: input.runDir,
      mavenTimeoutMs: input.scenario.environment.command_timeout_seconds * 1000 };
  }
  if (operation === 'checks') {
    const outcomes = { ParentUpgrade: await checkUpgrade(input),
      JavaTarget: await checkJavaTarget(input, { env }), ScenarioChecks: await checkScenario(input, { env }) };
    await write(path.join(input.runDir, 'checks.json'), outcomes);
    return outcomes;
  }
  if (operation === 'diff') {
    const git = async (args) => {
      try { return (await exec('git', args, { cwd: input.workingDir, env, timeout: 30000, maxBuffer: 20 * 1024 * 1024 })).stdout; }
      catch (error) { if (error.code === 1 && args.includes('--no-index')) return error.stdout; throw error; }
    };
    let patch = await git(['diff', '--no-ext-diff', input.baselineCommit, '--', '.']);
    const files = await git(['ls-files', '--others', '--exclude-standard', '-z']);
    for (const file of files.split('\0').filter(Boolean)) patch += await git(['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', file]);
    await fs.writeFile(path.join(input.runDir, 'changes.patch'), patch);
    return { diff: patch };
  }
  throw new Error(`Unknown Inspect bridge operation: ${operation}`);
}

if (require.main === module) (async () => {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  console.log(JSON.stringify(await dispatch(process.argv[2], JSON.parse(input))));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { dispatch };
