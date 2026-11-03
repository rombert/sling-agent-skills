const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const grader = require('./java-target.cjs');
const { prepare } = require('./workspace.cjs');

const exec = promisify(execFile);
const pom = (version) => `<project><parent><groupId>org.apache.sling</groupId><artifactId>sling-bundle-parent</artifactId><version>${version}</version></parent></project>\n`;
const effective = ({ properties = '<maven.compiler.release>11</maven.compiler.release>', config = '', executions = '', namespace = true } = {}) =>
  `<project${namespace ? ' xmlns="http://maven.apache.org/POM/4.0.0"' : ''}><properties>${properties}</properties><build><plugins><plugin>
    <artifactId>maven-compiler-plugin</artifactId>${config ? `<configuration>${config}</configuration>` : ''}
    ${executions ? `<executions>${executions}</executions>` : ''}</plugin></plugins></build></project>`;

function setEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/opencode/sling-java-target-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await exec('git', ['init', '--quiet', source]);
  await fs.writeFile(path.join(source, 'pom.xml'), pom(52));
  await exec('git', ['add', '.'], { cwd: source });
  await exec('git', ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture'], { cwd: source });
  setEnv(t, 'PROMPTFOO_WORKSPACE_ROOT', path.join(root, 'runs'));
  const metadata = await prepare({ working_dir: source, install_skills: false, mavenTimeoutMs: 2000 });
  metadata.completion = { status: 'completed', summary: 'Upgraded.' };
  await fs.writeFile(path.join(metadata.workingDir, 'pom.xml'), pom(66));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'mvn'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const before = path.basename(process.cwd()) === 'baseline';
const label = before ? 'before' : 'after';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_JAVA_INVOCATIONS, JSON.stringify({ args, label,
  pom: fs.readFileSync('pom.xml', 'utf8'), cwd: process.cwd(), key: process.env.LITELLM_API_KEY, gitDir: process.env.GIT_DIR }) + '\\n');
if (process.env.TEST_JAVA_FAIL === label) { console.log('Effective POM failed'); process.exit(1); }
if (process.env.TEST_JAVA_TIMEOUT === label) { setInterval(() => {}, 1000); }
else if (process.env.TEST_JAVA_NO_OUTPUT !== label) {
  fs.writeFileSync(args.find(arg => arg.startsWith('-Doutput=')).slice(9),
    process.env[before ? 'TEST_JAVA_BEFORE' : 'TEST_JAVA_AFTER']);
}
`, { mode: 0o755 });
  setEnv(t, 'PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  setEnv(t, 'LITELLM_API_KEY', 'must-not-reach-maven');
  setEnv(t, 'TEST_JAVA_BEFORE', effective());
  setEnv(t, 'TEST_JAVA_AFTER', effective());
  const invocations = path.join(root, 'invocations.jsonl');
  setEnv(t, 'TEST_JAVA_INVOCATIONS', invocations);
  const evaluate = (overrides = {}) => grader('', { providerResponse: { metadata: { ...metadata, ...overrides } } });
  return { root, source, metadata, invocations, evaluate };
}

test('Java grader resolves implicit release precedence and keeps baseline/source workspaces untouched', async (t) => {
  const { source, metadata, invocations, evaluate } = await fixture(t);
  setEnv(t, 'TEST_JAVA_BEFORE', effective({ properties:
    '<maven.compiler.release>11</maven.compiler.release><maven.compiler.source>1.7</maven.compiler.source><maven.compiler.target>1.7</maven.compiler.target>' }));
  setEnv(t, 'TEST_JAVA_AFTER', effective({ properties: '<sling.java.version>11</sling.java.version><maven.compiler.release>${sling.java.version}</maven.compiler.release>' }));
  const result = await evaluate();
  assert.equal(result.pass, true, result.reason);
  assert.match(result.reason, /main=11, test=11/);
  const calls = (await fs.readFile(invocations, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pom, pom(52)); // No explicit baseline Java target in project POM.
  assert.equal(calls[1].pom, pom(66));
  assert.equal(calls[1].cwd, metadata.workingDir);
  for (const call of calls) {
    assert.equal(call.key, undefined);
    assert.equal(call.gitDir, undefined);
    assert.ok(call.args.includes('org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom'));
    assert.ok(!call.args.includes('clean') && !call.args.includes('verify'));
  }
  assert.equal(await fs.readFile(path.join(source, 'pom.xml'), 'utf8'), pom(52));
  assert.equal(await fs.readFile(path.join(metadata.workingDir, 'pom.xml'), 'utf8'), pom(66));
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: metadata.workingDir })).stdout.trim(), metadata.baselineCommit);
  const artifactDir = path.dirname(calls[0].args.find((arg) => arg.startsWith('-Doutput=')).slice(9));
  const evidence = JSON.parse(await fs.readFile(path.join(artifactDir, 'comparison.json')));
  assert.equal(evidence.baselineCommit, metadata.baselineCommit);
  assert.deepEqual(evidence.before.targets, { main: [11], test: [11] });
});

test('Java grader rejects raised, lowered, or changed test targets even when builds could pass', async (t) => {
  const { evaluate } = await fixture(t);
  for (const target of [17, 8]) {
    process.env.TEST_JAVA_AFTER = effective({ properties: `<maven.compiler.release>${target}</maven.compiler.release>` });
    const result = await evaluate();
    assert.equal(result.pass, false);
    assert.match(result.reason, new RegExp(`main 11 -> ${target}`));
    assert.match(result.reason, /Build JDK requirements do not justify/);
  }
  process.env.TEST_JAVA_AFTER = effective({ properties:
    '<maven.compiler.release>11</maven.compiler.release><maven.compiler.testRelease>17</maven.compiler.testRelease>' });
  const result = await evaluate();
  assert.equal(result.pass, false);
  assert.match(result.reason, /test 11 -> 17/);
  assert.doesNotMatch(result.reason, /main 11 ->/);
});

test('Java target parser honors plugin and execution overrides and normalizes legacy versions', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/sling-java-parser-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'effective.xml');
  for (const [options, expected] of [
    [{ properties: '<maven.compiler.target>1.8</maven.compiler.target>', namespace: false }, { main: [8], test: [8] }],
    [{ config: '<release>17</release>' }, { main: [17], test: [17] }],
    [{ config: '<testRelease>8</testRelease>' }, { main: [11], test: [8] }],
    [{ executions: '<execution><id>default-compile</id><goals><goal>compile</goal></goals><configuration><release>17</release></configuration></execution>' }, { main: [17], test: [11] }],
    [{ properties: '<maven.compiler.target>8</maven.compiler.target>', config: '<target>11</target>' }, { main: [11], test: [11] }],
    [{ properties: '<maven.compiler.target>1.8</maven.compiler.target><maven.compiler.testTarget>11</maven.compiler.testTarget>' }, { main: [8], test: [11] }],
    [{ config: '<testTarget>8</testTarget>' }, { main: [11], test: [11] }], // release takes precedence over testTarget too.
    [{ properties: '<maven.compiler.testRelease>8</maven.compiler.testRelease>', config: '<release>17</release>' }, { main: [17], test: [8] }],
    [{ properties: '<first>${second}</first><second>1.8</second><maven.compiler.target>${first}</maven.compiler.target>' }, { main: [8], test: [8] }],
  ]) {
    await fs.writeFile(file, effective(options));
    assert.deepEqual((await grader.readTarget(file)).targets, expected);
  }
});

test('Java target parser fails closed on unknown targets and unsupported target overrides', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/sling-java-parser-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'effective.xml');
  for (const xml of [
    effective({ properties: '' }),
    effective({ properties: '<maven.compiler.release>${missing}</maven.compiler.release>' }),
    effective({ properties: '<maven.compiler.release>invalid</maven.compiler.release>' }),
    effective({ properties: '<maven.compiler.release>${constructor}</maven.compiler.release>' }),
    effective({ properties: '<a>${b}</a><b>${a}</b><maven.compiler.release>${a}</maven.compiler.release>' }),
    effective({ config: '<compilerArgs><arg>--release</arg><arg>17</arg></compilerArgs>' }),
    effective({ config: '<compilerArgs><arg>--rel<!-- ignored -->ease=17</arg></compilerArgs>' }),
    effective({ config: '<compilerArgument><![CDATA[-target 17]]></compilerArgument>' }),
    effective({ config: '<compilerArguments><target>17</target></compilerArguments>' }),
    effective({ properties: '<maven.compiler.release>11</maven.compiler.release><custom.args>--release 17</custom.args>',
      config: '<compilerArgument>${custom.args}</compilerArgument>' }),
    effective({ executions: '<execution><id>default-compile</id><phase>none</phase><goals><goal>compile</goal></goals></execution>' }),
    '<project><build/></project>', '<projects/>', '<not-xml',
  ]) {
    await fs.writeFile(file, xml);
    await assert.rejects(grader.readTarget(file));
  }
});

test('Java target reader retains per-execution evidence and numerically sorted distinct targets', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/sling-java-parser-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'effective.xml');
  const executions = [
    ['new-compile', 'compile', 'release', 17],
    ['legacy-compile', 'compile', 'release', 8],
    ['test-compile', 'testCompile', 'testRelease', 11],
  ].map(([id, goal, setting, target]) => `<execution><id>${id}</id><goals><goal>${goal}</goal></goals>
    <configuration><${setting}>${target}</${setting}></configuration></execution>`).join('');
  const xml = effective({ properties: '<maven.compiler.target>1.8</maven.compiler.target>', executions });
  const expected = {
    targets: { main: [8, 17], test: [11] },
    evidence: [
      { kind: 'main', execution: 'new-compile', target: 17, setting: 'release' },
      { kind: 'main', execution: 'legacy-compile', target: 8, setting: 'release' },
      { kind: 'test', execution: 'test-compile', target: 11, setting: 'testRelease' },
    ],
  };
  const prefixed = xml.replace('xmlns=', 'xmlns:m=').replace(/(<\/?)([\w.-]+)(?=[\s/>])/g, '$1m:$2');
  for (const document of [xml, prefixed]) {
    await fs.writeFile(file, document);
    assert.deepEqual(await grader.readTarget(file), expected);
  }
});

test('Java grader refuses incomplete tasks, missing baseline metadata and invalid commits before Maven', async (t) => {
  const { evaluate, invocations } = await fixture(t);
  assert.equal((await grader('', {})).pass, false);
  for (const overrides of [{ baselineCommit: undefined }, { baselineCommit: 'invalid' },
    { completion: { status: 'incomplete' } }, { initialParent: undefined }]) {
    assert.equal((await evaluate(overrides)).pass, false);
  }
  await assert.rejects(fs.stat(invocations), { code: 'ENOENT' });
});

test('Java grader retains diagnostics and fails on Maven errors, timeout or missing effective POM', async (t) => {
  const { evaluate } = await fixture(t);
  setEnv(t, 'TEST_JAVA_FAIL', 'before');
  let result = await evaluate();
  assert.equal(result.pass, false);
  assert.match(result.reason, /before effective POM exited 1/);
  assert.match(result.reason, /Effective POM failed/);
  process.env.TEST_JAVA_FAIL = 'after';
  result = await evaluate();
  assert.equal(result.pass, false);
  assert.match(result.reason, /after effective POM exited 1/);
  process.env.TEST_JAVA_FAIL = '';
  setEnv(t, 'TEST_JAVA_TIMEOUT', 'before');
  result = await evaluate({ mavenTimeoutMs: 100 });
  assert.equal(result.pass, false);
  assert.match(result.reason, /timed out/);
  process.env.TEST_JAVA_TIMEOUT = '';
  setEnv(t, 'TEST_JAVA_NO_OUTPUT', 'after');
  result = await evaluate();
  assert.equal(result.pass, false);
  assert.match(result.reason, /Cannot validate Java bytecode target/);
  assert.match(result.reason, /artifacts:/);
});
