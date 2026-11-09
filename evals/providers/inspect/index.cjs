const { generate } = require('./generate.cjs');

function validateOptions(env) {
  for (const key of ['BACKEND', 'REPO', 'PROMPTFOO_REPO']) {
    if (env[key] !== undefined) throw new Error(`Omit ${key}; Inspect uses native agents and pinned SCENARIO repositories`);
  }
}

module.exports = { generate, validateOptions, defaultOutput: 'target/evals/inspect.json',
  run: (options) => require('./run.cjs').run(options),
  view: () => require('./run.cjs').view() };
