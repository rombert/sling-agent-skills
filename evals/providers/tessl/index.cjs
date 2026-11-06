function validateOptions(env) {
  if (Number(env.RUNS ?? 1) > 10) throw new Error('Tessl supports at most 10 RUNS');
  if (env.TESSL_MAX_SOLVES !== undefined && !/^[1-9]\d*$/.test(env.TESSL_MAX_SOLVES)) {
    throw new Error('TESSL_MAX_SOLVES must be a positive integer');
  }
  for (const key of ['REPO', 'PROMPTFOO_REPO', 'BACKEND']) {
    if (env[key] !== undefined) throw new Error(`${key} cannot override a pinned Tessl scenario`);
  }
}

module.exports = { defaultOutput: 'target/evals/tessl', validateOptions,
  generate: (options) => require('./generate.cjs').generate(options),
  run: (options) => require('./run.cjs').run(options),
  view: () => require('./run.cjs').view() };
