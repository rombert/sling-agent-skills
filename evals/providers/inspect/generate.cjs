const fs = require('node:fs/promises');
const path = require('node:path');
const models = require('../../models.json');
const agent = require('./config.json');
const { projectRoot, validate } = require('../../shared/scenarios.cjs');

async function generate({ scenarios, arm, output }) {
  for (const scenario of scenarios) validate(scenario);
  const arms = arm === 'both' ? ['with-skills', 'without-skills'] : [arm];
  if (arms.some((value) => !['with-skills', 'without-skills'].includes(value))) throw new Error(`Invalid arm: ${arm}`);
  const config = { schemaVersion: 1, models, agent, skillsDir: path.join(projectRoot, 'skills'),
    samples: scenarios.flatMap((scenario) => arms.map((variant) => ({
      id: `${scenario.id}--${variant}`, arm: variant, scenario,
    }))) };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(config, null, 2) + '\n');
  return { config, output };
}

module.exports = { generate };
