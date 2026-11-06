const { childEnvironment: withoutGit } = require('../../shared/process.cjs');

// Credential policy belongs to this provider, not to the shared Maven/Git code.
const childEnvironment = (env = process.env) => Object.fromEntries(
  Object.entries(withoutGit(env)).filter(([key]) => key !== 'LITELLM_API_KEY'));

module.exports = { childEnvironment };
