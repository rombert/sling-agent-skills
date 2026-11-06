const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { zipSync, strToU8 } = require('fflate');
const { load, validate, select, projectRoot } = require('./scenarios.cjs');
const { prepareFixture } = require('./fixture.cjs');
const { check, reportTotals, files } = require('./scenario-checks.cjs');
const { checkUpgrade } = require('./parent-upgrade.cjs');

const exec = promisify(execFile);

test('catalog is valid, pinned and rejects unknown, duplicate or unsafe definitions', async (t) => {
  const catalog = await load();
  const scenario = structuredClone(catalog.scenarios[0]);
  assert.ok(select(catalog).length);
  assert.equal(catalog.fixtures.length, 4);
  assert.ok(catalog.fixtures.every((fixture) => fixture.status === 'needs_calibration' && !fixture.repository.local_path.includes('/.')));
  for (const mutate of [s => s.repository.revision = 'master', s => s.checks[0].expected.version = '42',
    s => s.checks[0].expected.version = '34', s => s.checks[2].expected = 61,
    s => s.checks[3].paths = ['../reports/*.xml'], s => s.checks[1].command = 'mvn -DskipTests verify',
    s => s.checks[3].expected.tests = 0, s => s.fixture.setup[0].options = ['--unsafe-paths']]) {
    const changed = structuredClone(scenario);
    mutate(changed);
    assert.throws(() => validate(changed));
  }
  const dir = await fs.mkdtemp('/tmp/opencode/sling-catalog-test-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'scenarios.json');
  await fs.writeFile(file, JSON.stringify({ schema_version: 1, scenarios: [scenario, scenario] }));
  await assert.rejects(load(file), /Duplicate scenario/);
  assert.throws(() => select(catalog, 'missing'), /Unknown scenario/);
});

test('JUnit totals count leaf suites once, require attributes, and reject DTDs or empty reports', () => {
  const suite = '<testsuite tests="2" failures="0" errors="0" skipped="0"><testcase/><testcase/></testsuite>';
  assert.deepEqual(reportTotals(`<testsuites>${suite}${suite}</testsuites>`), { tests: 4, failures: 0, errors: 0, skipped: 0 });
  assert.equal(reportTotals(`<testsuite tests="9">${suite}</testsuite>`).tests, 2);
  for (const xml of ['<testsuites/>', '<testsuite tests="1"/>', '<!DOCTYPE testsuite><testsuite/>']) assert.throws(() => reportTotals(xml));
});

test('checks fail closed for empty class/report sets, changed class targets, test totals and bundle headers', async (t) => {
  const dir = await fs.mkdtemp('/tmp/opencode/sling-checks-test-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const metadata = { workingDir: dir };
  const target = { type: 'class_major_version', paths: ['classes/**/*.class', 'test-classes/**/*.class'], expected: 52 };
  await assert.rejects(check(target, metadata), /No files matched/);
  for (const folder of ['classes', 'test-classes']) {
    await fs.mkdir(path.join(dir, folder));
    await fs.writeFile(path.join(dir, folder, 'Example.class'), Buffer.from('cafebabe00000034', 'hex'));
  }
  assert.match(await check(target, metadata), /2 class files/);
  await fs.writeFile(path.join(dir, 'classes', 'Example.class'), Buffer.from('cafebabe0000003d', 'hex'));
  await assert.rejects(check(target, metadata), /expected 52, got 61/);
  const reports = { id: 'tests', type: 'junit_reports', paths: ['report.xml'], expected: { tests: 2, failures: 0, errors: 0, skipped: 0 } };
  await fs.writeFile(path.join(dir, 'report.xml'), '<testsuite tests="1" failures="0" errors="0" skipped="0"/>');
  await assert.rejects(check(reports, metadata), /expected/);
  const jar = { type: 'jar_manifest', path: 'bundle.jar', expected: {
    'Bundle-SymbolicName': 'example', export_packages: ['example.api'], initial_content_paths: ['/libs/example'] } };
  await fs.writeFile(path.join(dir, 'bundle.jar'), zipSync({ 'META-INF/MANIFEST.MF': strToU8(
    'Bundle-SymbolicName: example\r\nExport-Package: example.api;version="[1,2)"\r\nSling-Initial-Content: content;path:=/libs/\r\n example\r\n') }));
  assert.equal(await check(jar, metadata), 'Bundle metadata matches');
  jar.expected['Bundle-SymbolicName'] = 'different';
  await assert.rejects(check(jar, metadata), /Bundle-SymbolicName/);
  await fs.symlink('/etc/hosts', path.join(dir, 'escape.xml'));
  await assert.rejects(files(dir, ['escape.xml']), /escapes workspace/);
});

test('pinned fixtures use the requested revision and checkpoint setup only in the disposable clone', async (t) => {
  const root = await fs.mkdtemp(path.join(projectRoot, 'repos', '.sling-scenario-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const git = async (args, cwd = source) => (await exec('git', args, { cwd })).stdout.trim();
  await git(['init', '--quiet']);
  await git(['remote', 'add', 'origin', 'https://github.com/apache/fixture.git']);
  await fs.writeFile(path.join(source, 'pom.xml'), '<project><parent><groupId>org.apache.sling</groupId><artifactId>sling</artifactId><version>34</version></parent></project>\n');
  await git(['add', '.']);
  const commit = () => git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture']);
  await commit();
  const revision = await git(['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(source, 'newer.txt'), 'not part of pinned fixture\n');
  await git(['add', '.']);
  await commit();
  const sourceHead = await git(['rev-parse', 'HEAD']);
  const scenario = structuredClone((await load()).scenarios[0]);
  scenario.repository = { url: 'https://github.com/apache/fixture.git', revision, local_path: path.relative(projectRoot, source) };
  scenario.fixture.setup = [{ type: 'git_apply', patch: 'diff --git a/setup.txt b/setup.txt\nnew file mode 100644\n--- /dev/null\n+++ b/setup.txt\n@@ -0,0 +1 @@\n+fixture setup\n' }];
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  for (const [command, output] of [['java', 'openjdk version "21.0.13"'], ['mvn', 'Apache Maven 3.10.0\nJava version: 21.0.13']]) {
    await fs.writeFile(path.join(bin, command), `#!${process.execPath}\nconsole.log(${JSON.stringify(output)});\n`, { mode: 0o755 });
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const runDir = path.join(root, 'run');
  await fs.mkdir(runDir);
  const state = await prepareFixture(scenario, runDir);
  assert.equal(state.repository.revision, revision);
  assert.notEqual(state.baselineCommit, revision);
  assert.equal(await git(['status', '--porcelain'], state.workingDir), '');
  assert.equal(await fs.readFile(path.join(state.workingDir, 'setup.txt'), 'utf8'), 'fixture setup\n');
  await assert.rejects(fs.stat(path.join(state.workingDir, 'newer.txt')), { code: 'ENOENT' });
  assert.equal(await git(['rev-parse', 'HEAD']), sourceHead);
  assert.equal(await git(['status', '--porcelain']), '');
  await assert.rejects(fs.stat(path.join(source, 'setup.txt')), { code: 'ENOENT' });
  state.completion = { status: 'completed', summary: 'Upgraded' };
  await fs.writeFile(path.join(state.workingDir, 'pom.xml'), '<project><parent><groupId>org.apache.sling</groupId><artifactId>sling-bundle-parent</artifactId><version>47</version></parent></project>');
  assert.equal((await checkUpgrade(state)).pass, false);
  const badSetup = structuredClone(scenario);
  badSetup.fixture.setup = [{ type: 'git_apply', patch:
    'diff --git a/pom.xml b/pom.xml\n--- a/pom.xml\n+++ b/pom.xml\n@@ -1 +1 @@\n' +
    '-<project><parent><groupId>org.apache.sling</groupId><artifactId>sling</artifactId><version>34</version></parent></project>\n' +
    '+<project><parent><groupId>org.apache.sling</groupId><artifactId>sling</artifactId><version>46</version></parent></project>\n' }];
  const badDir = path.join(root, 'bad-setup');
  await fs.mkdir(badDir);
  await assert.rejects(prepareFixture(badSetup, badDir), /must not perform the parent upgrade/);
});
