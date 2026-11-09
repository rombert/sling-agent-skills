const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { projectRoot } = require('../../shared/scenarios.cjs');

function launch(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', env });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) console.error(`${command} terminated by ${signal}`);
      resolve(code ?? 1);
    });
  });
}

function python(args, env = process.env) {
  return launch('uv', ['run', '--locked', '--project', __dirname, '--no-env-file', '--', ...args], {
    ...env, UV_PROJECT_ENVIRONMENT: path.join(projectRoot, 'target/evals/inspect-venv'),
    INSPECT_EVAL_MODEL: '', // Never inherit a personal model selection.
    EVAL_NODE: process.execPath,
  });
}

async function run(options, { credentialsLoaded = false, credentialsFile = path.join(projectRoot, '.env') } = {}) {
  await fs.access(options.output);
  if (!process.env.LITELLM_API_KEY) {
    if (credentialsLoaded) throw new Error('LITELLM_API_KEY is not set in .env');
    await fs.access(credentialsFile).catch(() => {
      throw new Error('LITELLM_API_KEY is not set and .env is missing; export the key or provide the existing encrypted .env');
    });
    const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`;
    return launch('sops', ['exec-env', credentialsFile,
      [process.execPath, __filename, '--credentials-loaded'].map(quote).join(' ')], { ...process.env,
      EVAL_PROVIDER: options.provider, EVAL_CONFIG: options.output, SCENARIO: options.selector,
      ARM: options.arm, RUNS: String(options.runs) });
  }
  const logs = process.env.EVAL_RESULTS ?? path.join(path.dirname(options.output), 'inspect-logs');
  console.log(`Running Inspect, ${options.runs} repetition(s); native logs: ${logs}`);
  return python(['python', path.join(__dirname, 'runner.py'), '--config', options.output,
    '--runs', String(options.runs), '--log-dir', logs]);
}

const view = () => python(['inspect', 'view', '--log-dir', process.env.EVAL_RESULTS ?? path.join(projectRoot, 'target/evals/inspect-logs')]);
const test = () => python(['python', '-m', 'unittest', 'discover', '-s', __dirname, '-p', 'test_*.py']);

if (require.main === module) Promise.resolve().then(() => process.argv.includes('--test') ? test() :
  run(require('../../options.cjs').settings(), { credentialsLoaded: process.argv.includes('--credentials-loaded') }))
  .then((code) => { process.exitCode = code; })
  .catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { run, view, test };
