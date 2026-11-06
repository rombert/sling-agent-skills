const { checkUpgrade } = require('../../../shared/parent-upgrade.cjs');
const { gradingResult } = require('./result.cjs');

module.exports = async (_output, context) => gradingResult(await checkUpgrade(context.providerResponse?.metadata));
