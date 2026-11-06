const { checkMavenVerify } = require('../../../shared/maven-verify.cjs');
const { childEnvironment } = require('../environment.cjs');
const { gradingResult } = require('./result.cjs');

module.exports = async (_output, context) => gradingResult(await checkMavenVerify(context.providerResponse?.metadata, { env: childEnvironment() }));
