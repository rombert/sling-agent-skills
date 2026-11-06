const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');

const projectRoot = path.resolve(__dirname, '../..');
const checkTypes = new Set(['pom_parent', 'command', 'class_major_version', 'junit_reports', 'jar_manifest']);
const safePath = (value) => typeof value === 'string' && value !== '' && !path.isAbsolute(value) &&
  !value.split(/[\\/]/).includes('..');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

function validate(scenario) {
  const prefix = `Scenario ${scenario?.id ?? '(missing id)'}`;
  const check = (condition, message) => requireValue(condition, `${prefix}: ${message}`);
  check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario?.id ?? ''), 'invalid id');
  check(scenario.status === undefined || ['ready', 'draft'].includes(scenario.status), 'invalid status');
  check(typeof scenario.skill === 'string' && safePath(scenario.skill), 'missing skill');
  check(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(scenario.repository?.url ?? ''), 'expected an HTTPS GitHub repository URL');
  check(/^[a-f0-9]{40}$/.test(scenario.repository?.revision ?? ''), 'revision must be a full Git SHA');
  check((scenario.repository.working_directory ?? '.') === '.', 'only repository-root tasks are supported');
  if (scenario.repository.local_path !== undefined) {
    check(safePath(scenario.repository.local_path) && scenario.repository.local_path.startsWith('repos/'), 'local_path must be below repos/');
  }
  check(scenario.environment?.java_major === 21, 'java_major must be 21');
  check(Number.isSafeInteger(scenario.environment.command_timeout_seconds) && scenario.environment.command_timeout_seconds > 0, 'invalid command timeout');
  check(scenario.fixture?.baseline === 'after_setup', 'baseline must be after_setup');
  check(Number.isSafeInteger(scenario.fixture.initial_java_bytecode_target), 'missing baseline bytecode target');
  check(typeof scenario.prompt === 'string' && scenario.prompt.trim(), 'missing prompt');
  check(Array.isArray(scenario.checks) && scenario.checks.length > 0, 'checks must not be empty');
  check(Array.isArray(scenario.criteria) && scenario.criteria.length > 0, 'criteria must not be empty');
  const ids = new Set();
  for (const item of scenario.checks) {
    check(typeof item.id === 'string' && !ids.has(item.id), 'duplicate or missing check id');
    ids.add(item.id);
    check(checkTypes.has(item.type), `unsupported check type ${item.type}`);
    for (const file of [...(item.paths ?? []), ...(item.path ? [item.path] : [])]) {
      check(safePath(file), `unsafe check path ${file}`);
    }
    if (item.type === 'command') check(item.command === 'mvn clean verify' && item.expected_exit_code === 0, 'verification must be mvn clean verify with exit zero');
    if (item.type === 'pom_parent') {
      check(item.path === 'pom.xml' && item.expected?.group_id === 'org.apache.sling' &&
        ['sling', 'sling-bundle-parent'].includes(item.expected?.artifact_id) && /^\d+$/.test(item.expected?.version ?? '') &&
        !['42', '50'].includes(item.expected.version), 'invalid or unsupported target parent');
      check(Number(item.expected.version) > Number(scenario.fixture.initial_parent?.version), 'target must upgrade the baseline parent');
    }
    if (['junit_reports', 'class_major_version'].includes(item.type)) check(item.paths?.length > 0, 'check paths must not be empty');
    if (item.type === 'class_major_version') check(item.expected === scenario.fixture.initial_java_bytecode_target + 44, 'class version does not preserve baseline bytecode');
    if (item.type === 'junit_reports') {
      check(['tests', 'failures', 'errors', 'skipped'].every((key) => Number.isSafeInteger(item.expected?.[key]) && item.expected[key] >= 0) && item.expected.tests > 0, 'invalid test totals');
    }
  }
  check(scenario.checks.filter((c) => c.type === 'pom_parent').length === 1, 'exactly one parent check is required');
  check(scenario.checks.filter((c) => c.type === 'command').length === 1, 'exactly one verification command is required');
  const criteria = new Set();
  for (const criterion of scenario.criteria) {
    check(criterion.id && !criteria.has(criterion.id) && criterion.description?.trim(), 'duplicate or invalid criterion');
    criteria.add(criterion.id);
  }
  for (const step of scenario.fixture.setup ?? []) {
    check(step.type === 'git_apply' && typeof step.patch === 'string' && step.patch.startsWith('diff --git '), 'unsupported fixture setup');
    check((step.options ?? []).every((option) => option === '--ignore-whitespace'), 'unsupported patch option');
  }
  return scenario;
}

async function load(file = path.join(__dirname, '../scenarios.yaml')) {
  const data = YAML.parse(await fs.readFile(file, 'utf8'), { uniqueKeys: true });
  requireValue(data?.schema_version === 1 && Array.isArray(data.scenarios) && data.scenarios.length, 'Expected schema_version 1 and nonempty scenarios');
  const ids = new Set();
  for (const scenario of data.scenarios) {
    validate(scenario);
    requireValue(!ids.has(scenario.id), `Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  const fixtures = new Set();
  for (const fixture of data.fixtures ?? []) {
    requireValue(fixture.id && !fixtures.has(fixture.id), 'Duplicate or missing fixture id');
    fixtures.add(fixture.id);
    requireValue(/^[a-f0-9]{40}$/.test(fixture.repository?.revision ?? '') &&
      /^https:\/\/github\.com\//.test(fixture.repository?.url ?? '') &&
      safePath(fixture.repository.local_path) && fixture.repository.local_path.startsWith('repos/'), `Invalid fixture ${fixture.id}`);
    requireValue(fixture.status === 'needs_calibration' && fixture.initial_parent?.version, `Invalid fixture status/parent for ${fixture.id}`);
  }
  return data;
}

function select(catalog, selector = 'all') {
  if (selector === 'all') return catalog.scenarios.filter((scenario) => scenario.status !== 'draft');
  const ids = selector.split(',');
  requireValue(new Set(ids).size === ids.length, 'SCENARIO must not repeat an id');
  return ids.map((id) => {
    const scenario = catalog.scenarios.find((item) => item.id === id);
    requireValue(scenario, `Unknown scenario: ${id}`);
    requireValue(scenario.status !== 'draft', `Scenario ${id} is not calibrated yet`);
    return scenario;
  });
}

module.exports = { load, select, validate, safePath, projectRoot };

if (require.main === module) load().then((catalog) => {
  for (const scenario of catalog.scenarios) console.log(`${scenario.id}: ${scenario.status ?? 'ready'}`);
  for (const fixture of catalog.fixtures ?? []) console.log(`${fixture.id}: ${fixture.status} (${fixture.repository.local_path})`);
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
