const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { readTarget } = require('./java-target.cjs');

const effective = ({ properties = '<maven.compiler.release>11</maven.compiler.release>', config = '', executions = '', namespace = true } = {}) =>
  `<project${namespace ? ' xmlns="http://maven.apache.org/POM/4.0.0"' : ''}><properties>${properties}</properties><build><plugins><plugin>
    <artifactId>maven-compiler-plugin</artifactId>${config ? `<configuration>${config}</configuration>` : ''}
    ${executions ? `<executions>${executions}</executions>` : ''}</plugin></plugins></build></project>`;

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
    assert.deepEqual((await readTarget(file)).targets, expected);
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
    await assert.rejects(readTarget(file));
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
    assert.deepEqual(await readTarget(file), expected);
  }
});
