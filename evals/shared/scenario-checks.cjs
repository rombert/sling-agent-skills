const fs = require('node:fs/promises');
const path = require('node:path');
const { SaxesParser } = require('saxes');
const { unzipSync, strFromU8 } = require('fflate');
const { checkUpgrade, readParent } = require('./parent-upgrade.cjs');
const { checkMavenVerify } = require('./maven-verify.cjs');
const { validate, safePath } = require('./scenarios.cjs');

const equal = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

async function files(cwd, patterns) {
  const found = new Set();
  const root = await fs.realpath(cwd);
  for (const pattern of patterns) {
    if (!safePath(pattern)) throw new Error(`Unsafe check path: ${pattern}`);
    let count = 0;
    for await (const name of fs.glob(pattern, { cwd })) {
      const file = await fs.realpath(path.join(cwd, name));
      if (!file.startsWith(root + path.sep)) throw new Error(`Check path escapes workspace: ${name}`);
      if (!(await fs.stat(file)).isFile()) continue;
      found.add(file);
      count++;
    }
    if (!count) throw new Error(`No files matched ${pattern}`);
  }
  return [...found];
}

function reportTotals(xml) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  let suites = 0;
  parser.on('doctype', () => { throw new Error('DOCTYPE is not supported in reports'); });
  parser.on('opentag', (tag) => {
    if (tag.local !== 'testsuite') return;
    if (stack.length) stack.at(-1).nested = true;
    stack.push({ tag, nested: false });
  });
  parser.on('closetag', (tag) => {
    if (tag.local !== 'testsuite') return;
    const suite = stack.pop();
    if (suite.nested) return;
    suites++;
    for (const key of Object.keys(totals)) {
      const value = suite.tag.attributes[key]?.value;
      if (!/^\d+$/.test(value ?? '')) throw new Error(`Missing/invalid ${key} in test report`);
      totals[key] += Number(value);
    }
  });
  parser.write(xml).close();
  if (!suites) throw new Error('No test suites in report');
  return totals;
}

async function check(item, metadata, options = {}) {
  const cwd = metadata.workingDir;
  switch (item.type) {
    case 'pom_parent': {
      const parent = await readParent(path.join(cwd, item.path));
      equal(parent, { groupId: item.expected.group_id, artifactId: item.expected.artifact_id, version: item.expected.version }, 'Parent');
      return 'Exact parent coordinates match';
    }
    case 'command': {
      const grade = await checkMavenVerify(metadata, options);
      if (!grade.pass) throw new Error(grade.reason);
      return grade.reason;
    }
    case 'class_major_version': {
      const classes = await files(cwd, item.paths);
      for (const file of classes) {
        const handle = await fs.open(file, 'r');
        try {
          const bytes = Buffer.alloc(8);
          const { bytesRead } = await handle.read(bytes, 0, 8, 0);
          if (bytesRead !== 8 || bytes.readUInt32BE(0) !== 0xcafebabe) throw new Error(`Invalid class file: ${file}`);
          equal(bytes.readUInt16BE(6), item.expected, file);
        } finally { await handle.close(); }
      }
      return `${classes.length} class files all have major version ${item.expected}`;
    }
    case 'junit_reports': {
      const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
      for (const file of await files(cwd, item.paths)) {
        const report = reportTotals(await fs.readFile(file, 'utf8'));
        for (const key of Object.keys(totals)) totals[key] += report[key];
      }
      equal(totals, item.expected, item.id);
      return JSON.stringify(totals);
    }
    case 'jar_manifest': {
      const [file] = await files(cwd, [item.path]);
      const required = item.expected.required_entries ?? [];
      const zip = unzipSync(await fs.readFile(file), { filter: (entry) => entry.name === 'META-INF/MANIFEST.MF' || required.includes(entry.name) });
      if (!zip['META-INF/MANIFEST.MF']) throw new Error('Missing JAR manifest');
      for (const name of required) if (!zip[name]?.length) throw new Error(`Missing/empty required JAR entry: ${name}`);
      const text = strFromU8(zip['META-INF/MANIFEST.MF']).replace(/\r?\n /g, '');
      const headers = Object.fromEntries(text.split(/\r?\n/).filter((line) => line.includes(': ')).map((line) => {
        const index = line.indexOf(': ');
        return [line.slice(0, index), line.slice(index + 2)];
      }));
      equal(headers['Bundle-SymbolicName'], item.expected['Bundle-SymbolicName'], 'Bundle-SymbolicName');
      for (const [name, expected] of Object.entries(item.expected.headers ?? {})) equal(headers[name], expected, name);
      // Do not split quoted version ranges on their embedded commas.
      const clauses = (value) => (value ?? '').match(/(?:[^,"]|"[^"]*")+/g) ?? [];
      if (item.expected.export_packages) {
        equal(clauses(headers['Export-Package']).map((part) => part.trim().split(';')[0]).sort(), [...item.expected.export_packages].sort(), 'Export-Package');
      }
      if (item.expected.initial_content_paths) {
        const paths = clauses(headers['Sling-Initial-Content']).map((part) => part.match(/;path:="?([^;"\s]+)/)?.[1]).filter(Boolean).sort();
        equal(paths, [...item.expected.initial_content_paths].sort(), 'Sling-Initial-Content paths');
      }
      return 'Bundle metadata matches';
    }
    default: throw new Error(`Unsupported check type: ${item.type}`);
  }
}

async function checkScenario(metadata, options = {}) {
  const fail = (reason) => ({ pass: false, reason });
  if (!metadata?.scenario || !metadata.runDir) return fail('Missing scenario/workspace metadata');
  try { validate(metadata.scenario); } catch (error) { return fail(error.message); }
  const upgrade = await checkUpgrade(metadata);
  if (!upgrade.pass) return fail(upgrade.reason);
  const results = [];
  // Always rebuild before reading artifacts, even if a future scenario lists its
  // artifact checks before its command. Stale reports must never produce a pass.
  const checks = [...metadata.scenario.checks.filter((item) => item.type === 'command'),
    ...metadata.scenario.checks.filter((item) => item.type !== 'command')];
  for (const item of checks) {
    try { results.push({ id: item.id, pass: true, reason: await check(item, metadata, options) }); }
    catch (error) { results.push({ id: item.id, pass: false, reason: error.message }); }
  }
  await fs.writeFile(path.join(metadata.runDir, 'scenario-checks.json'), JSON.stringify(results, null, 2));
  const pass = results.every((result) => result.pass);
  return { pass,
    reason: results.map((result) => `${result.id}: ${result.pass ? 'PASS' : 'FAIL'} ${result.reason}`).join('\n'),
    checks: results };
}

module.exports = { checkScenario, check, reportTotals, files };
