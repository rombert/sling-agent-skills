const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { boundaryVersion, createFileBoundary } = require('./file-boundary.cjs');

async function fixture(t, withSkills = true) {
  const root = await fs.mkdtemp('/tmp/opencode/pi-file-boundary-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const skill = path.join(root, 'skills/parent');
  const host = path.join(root, 'host');
  for (const directory of [project, skill, host, path.join(project, '.git')]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await fs.mkdir(project + '-lookalike');
  await fs.writeFile(path.join(project, 'pom.xml'), '<project/>');
  await fs.writeFile(path.join(skill, 'SKILL.md'), 'Declared skill');
  await fs.writeFile(path.join(host, 'SKILL.md'), 'Undeclared host skill');
  const config = { version: boundaryVersion, projectRoot: project, skillRoots: withSkills ? [skill] : [] };
  return { root, project, skill, host, config, boundary: await createFileBoundary(config, project) };
}

test('native read/search roots are the project plus declared skill directories; writes are project-only', async t => {
  for (const withSkills of [true, false]) {
    const { project, skill, host, boundary } = await fixture(t, withSkills);
    for (const tool of ['read', 'grep', 'find', 'ls']) {
      assert.equal((await boundary.check(tool, { path: project })).allowed, true);
      assert.equal((await boundary.check(tool, { path: skill })).allowed, withSkills);
      assert.equal((await boundary.check(tool, { path: host })).allowed, false);
      assert.equal((await boundary.check(tool, { path: project + '-lookalike' })).allowed, false);
    }
    for (const tool of ['edit', 'write']) {
      assert.equal((await boundary.check(tool, { path: 'pom.xml' })).allowed, true);
      assert.equal((await boundary.check(tool, { path: 'new/nested/file.txt' })).allowed, true);
      assert.equal((await boundary.check(tool, { path: path.join(skill, 'SKILL.md') })).allowed, false);
      assert.equal((await boundary.check(tool, { path: '.git/config' })).allowed, false);
    }
    assert.equal((await boundary.check('grep', {})).path, project);
    assert.equal(await boundary.check('bash', { command: 'cat /host/SKILL.md' }), undefined);
    assert.equal(boundary.policy.bashConfined, false);
  }
});

test('canonical paths reject symlink escapes, dangling links and traversal, including not-yet-created writes', async t => {
  const { project, host, boundary } = await fixture(t);
  await fs.symlink(host, path.join(project, 'outside'));
  await fs.symlink(path.join(host, 'missing'), path.join(project, 'dangling'));
  await fs.symlink(path.join(project, 'pom.xml'), path.join(project, 'inside'));
  for (const tool of ['read', 'grep', 'find', 'ls', 'edit', 'write']) {
    for (const name of ['outside/SKILL.md', '../host/SKILL.md', 'dangling']) {
      assert.equal((await boundary.check(tool, { path: name })).allowed, false, tool + ':' + name);
    }
  }
  assert.equal((await boundary.check('write', { path: 'outside/new/file' })).allowed, false);
  assert.equal((await boundary.check('write', { path: 'dangling/new/file' })).allowed, false);
  assert.equal((await boundary.check('read', { path: 'inside' })).path, path.join(project, 'pom.xml'));
});

test('Pi path spellings are checked and canonicalized before native execution; missing reads fail closed', async t => {
  const { project, host, boundary } = await fixture(t);
  for (const name of ['pom.xml', '@pom.xml', pathToFileURL(path.join(project, 'pom.xml')).href]) {
    assert.equal((await boundary.check('read', { path: name })).path, path.join(project, 'pom.xml'));
  }
  for (const name of ['~/SKILL.md', '@~/SKILL.md', pathToFileURL(path.join(host, 'SKILL.md')).href,
    path.join(host, 'SKILL.md'), 'missing/SKILL.md', 'bad\0path']) {
    assert.equal((await boundary.check('read', { path: name })).allowed, false);
  }
  await assert.rejects(createFileBoundary(undefined, project), /configuration/);
  await assert.rejects(createFileBoundary({ version: boundaryVersion, projectRoot: host, skillRoots: [] }, project), /cwd/);
});
