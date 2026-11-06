const { checkScenario } = require('../../../shared/scenario-checks.cjs');
const { childEnvironment } = require('../environment.cjs');
const { gradingResult } = require('./result.cjs');

module.exports = async (_output, context) => gradingResult(await checkScenario(context.providerResponse?.metadata, { env: childEnvironment() }));
