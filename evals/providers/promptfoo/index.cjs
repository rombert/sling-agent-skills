const { generate } = require('./generate.cjs');

function validateOptions(env) {
  if (env.BACKEND !== undefined) throw new Error('BACKEND has been removed; evaluations use Pi only. Omit BACKEND');
  if (env.REPO !== undefined || env.PROMPTFOO_REPO !== undefined) {
    throw new Error('Use SCENARIO instead of REPO/PROMPTFOO_REPO; scenarios pin their own repositories');
  }
}

module.exports = { generate, validateOptions, defaultOutput: 'target/evals/promptfoo.json',
  run: (options) => require('./run.cjs').run(options),
  view: () => require('./run.cjs').view() };
