const { load, select } = require('./shared/scenarios.cjs');
const { settings } = require('./options.cjs');
const { getProvider } = require('./providers/index.cjs');

async function generate(options = settings()) {
  const scenarios = select(await load(), options.selector);
  if (!scenarios.length) throw new Error('No calibrated scenarios selected');
  const generated = await getProvider(options.provider).generate({ scenarios, arm: options.arm, output: options.output });
  return { ...generated, scenarioCount: scenarios.length };
}

if (require.main === module) generate().then(({ output, scenarioCount }) => {
  console.log(`Generated ${output}: ${scenarioCount} scenario(s)`);
}).catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { generate };
