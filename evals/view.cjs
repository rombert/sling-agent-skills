const { getProvider } = require('./providers/index.cjs');

if (require.main === module) Promise.resolve().then(() => getProvider(process.env.EVAL_PROVIDER ?? 'promptfoo').view())
  .then((code) => { process.exitCode = code; })
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
