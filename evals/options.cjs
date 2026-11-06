const path = require('node:path');
const { projectRoot } = require('./shared/scenarios.cjs');
const { getProvider } = require('./providers/index.cjs');

function settings(env = process.env) {
  const provider = env.EVAL_PROVIDER ?? 'promptfoo';
  const adapter = getProvider(provider);
  const arm = env.ARM ?? 'both';
  if (!['both', 'with-skills', 'without-skills'].includes(arm)) throw new Error('ARM must be with-skills, without-skills, or both');
  const runs = env.RUNS ?? '1';
  if (!/^[1-9]\d*$/.test(runs) || !Number.isSafeInteger(Number(runs))) throw new Error('RUNS must be a positive integer');
  adapter.validateOptions?.(env);
  return { provider, arm, runs: Number(runs), selector: env.SCENARIO ?? 'all',
    output: path.resolve(projectRoot, env.EVAL_CONFIG ?? adapter.defaultOutput) };
}

module.exports = { settings };
