const { checkJavaTarget } = require('../../../shared/java-target.cjs');
const { childEnvironment } = require('../environment.cjs');
const { gradingResult } = require('./result.cjs');

module.exports = async (_output, context) => gradingResult(await checkJavaTarget(context.providerResponse?.metadata, { env: childEnvironment() }));
