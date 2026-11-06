const { settings } = require('./options.cjs');
const { getProvider } = require('./providers/index.cjs');

async function main() {
  const options = settings();
  return getProvider(options.provider).run(options);
}

if (require.main === module) main().then((code) => { process.exitCode = code; })
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
