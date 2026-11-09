const { childEnvironment: withoutGit } = require('../../shared/process.cjs');

const childEnvironment = (env = process.env) => Object.fromEntries(
  Object.entries(withoutGit(env)).filter(([key]) => !['BASH_ENV', 'ENV'].includes(key) &&
    !/^(?:LITELLM|OPENAI|INSPECT|ANTHROPIC|GOOGLE|GEMINI)_.*(?:KEY|TOKEN|SECRET)$/.test(key)));

module.exports = { childEnvironment };
