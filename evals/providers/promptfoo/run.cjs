const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { projectRoot } = require('../../shared/scenarios.cjs');

async function launch(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit',
    env: { ...env, PROMPTFOO_DISABLE_TELEMETRY: '1' } });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) console.error(`${command} terminated by ${signal}`);
      resolve(code ?? 1);
    });
  });
}

async function run(options, { credentialsLoaded = false, credentialsFile = path.join(projectRoot, '.env') } = {}) {
  await fs.access(options.output);
  if (!process.env.LITELLM_API_KEY) {
    if (credentialsLoaded) throw new Error('LITELLM_API_KEY is not set in .env');
    await fs.access(credentialsFile).catch(() => {
      throw new Error('LITELLM_API_KEY is not set and .env is missing; export the key or create an encrypted .env');
    });
    const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, __filename, '--credentials-loaded'].map(quote).join(' ');
    return launch('sops', ['exec-env', credentialsFile, command], { ...process.env,
      EVAL_PROVIDER: options.provider, EVAL_CONFIG: options.output, SCENARIO: options.selector,
      ARM: options.arm, RUNS: String(options.runs) });
  }
  const output = process.env.EVAL_RESULTS ?? path.join(path.dirname(options.output), `results-${Date.now()}.json`);
  const args = ['--yes', 'promptfoo@0.125.1', 'eval', '--config', options.output,
    '--no-cache', '--repeat', String(options.runs), '--output', output];
  console.log(`Running ${options.provider}, ${options.runs} repetition(s); results: ${output}`);
  return launch('npx', args);
}

const view = () => launch('npx', ['--yes', 'promptfoo@0.125.1', 'view']);

if (require.main === module) {
  const { settings } = require('../../options.cjs');
  Promise.resolve().then(() => run(settings(), { credentialsLoaded: process.argv.includes('--credentials-loaded') }))
    .then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { run, view };
