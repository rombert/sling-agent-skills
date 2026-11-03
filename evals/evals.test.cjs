const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const Provider = require('./provider.cjs');
const grade = require('./maven-verify.cjs');
const parentGrade = require('./parent-upgrade.cjs');
const skillGrade = require('./skill-usage.cjs');
const { executeTool, htmlToText, readText, run, safePath } = require('./tools.cjs');
const { toolKey } = require('./tool-key.cjs');

const exec = promisify(execFile);

test('tool repetition keys normalize nested object keys but preserve array order', () => {
  assert.equal(toolKey('read', { path: 'pom.xml', options: { end: 4, start: 1 } }),
    toolKey('read', { options: { start: 1, end: 4 }, path: 'pom.xml' }));
  assert.notEqual(toolKey('bash', { args: ['a', 'b'] }), toolKey('bash', { args: ['b', 'a'] }));
});
const pom = (version = '52', artifact = 'sling-bundle-parent', group = 'org.apache.sling') =>
  `<project><parent><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version></parent></project>\n`;

function setEnv(t, name, value) {
  const previous = process.env[name];
  const assign = (next) => {
    if (next === undefined) delete process.env[name];
    else process.env[name] = next;
  };
  assign(value);
  t.after(() => assign(previous));
}

async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/opencode/sling-eval-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  setEnv(t, 'PROMPTFOO_WORKSPACE_ROOT', path.join(root, 'runs'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await exec('git', ['init', '--quiet', source]);
  await fs.writeFile(path.join(source, 'pom.xml'), pom());
  await fs.writeFile(path.join(source, '.gitignore'), 'target/\n');
  await exec('git', ['add', '.'], { cwd: source });
  await exec('git', ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture'], { cwd: source });
  const config = {
    working_dir: source,
    skills_dir: './skills',
    install_skills: true,
    model: 'qwen3-8b',
    apiBaseUrl: 'https://llm.example.invalid/v1',
    maxTurns: 8,
    mavenTimeoutMs: 2000,
  };
  return { root, source, config };
}

function calls(...items) {
  return {
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: items.map(([name, args], index) => ({
        id: `tool-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
      })),
    } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

const finish = (summary = 'Upgraded the parent.', status = 'completed') =>
  calls(['finish_task', { status, summary }]);

function mockModel(t, responses, requests = []) {
  setEnv(t, 'LITELLM_API_KEY', 'test-only-not-a-real-key');
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://llm.example.invalid/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-only-not-a-real-key');
    requests.push(JSON.parse(init.body));
    assert.ok(responses.length, 'Unexpected additional model call');
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  });
}

test('with-skills run loads instructions, edits files, and returns the actual diff', async (t) => {
  const { source, config } = await fixture(t);
  const requests = [];
  mockModel(t, [
    calls(['read_skill', { name: 'update-sling-parent-pom' }], ['read_file', { path: 'pom.xml' }]),
    calls(['replace_text', { path: 'pom.xml', old_text: '<version>52</version>', new_text: '<version>99</version>' }]),
    calls(['write_file', { path: 'src/new.txt', content: 'new file\n' }]),
    finish(),
  ], requests);
  const result = await new Provider({ config }).callApi('Upgrade this project to the latest Sling parent pom');
  assert.equal(result.error, undefined);
  assert.equal(result.cached, false);
  assert.equal(result.tokenUsage.total, 48);
  assert.equal(requests[0].temperature, 0);
  assert.equal(requests[0].max_tokens, 8192);
  assert.equal(JSON.parse(result.output).status, 'completed');
  assert.match(result.metadata.workspaceDiff, /\+.*<version>99/);
  assert.match(result.metadata.workspaceDiff, /src\/new.txt/);
  assert.deepEqual(result.metadata.skillCalls, [{ name: 'update-sling-parent-pom', is_error: false }]);
  assert.equal(skillGrade('', { providerResponse: result }).pass, true);
  assert.equal((await parentGrade('', { providerResponse: result })).pass, true);
  assert.match(requests[0].messages[0].content, /osgi-scr-migrator/);
  assert.match(requests[0].messages[0].content, /sling-release/);
  assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /Updating the Sling Parent POM/);
  assert.match(await fs.readFile(path.join(source, 'pom.xml'), 'utf8'), /<version>52/);
  assert.match(await fs.readFile(path.join(result.metadata.workingDir, 'pom.xml'), 'utf8'), /<version>99/);
  assert.equal((await exec('git', ['remote'], { cwd: result.metadata.workingDir })).stdout, '');
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: source })).stdout, '');
});

test('CJS forwards shared generation settings rather than hard-coding sampling', async (t) => {
  const { config } = await fixture(t);
  const requests = [];
  mockModel(t, [finish('Blocked.', 'blocked')], requests);
  const result = await new Provider({ config: { ...config, model: 'shared-model', temperature: 0.25, maxTokens: 1024,
    chatTemplateKwargs: { enable_thinking: false } } }).callApi('Upgrade');
  assert.equal(requests[0].model, 'shared-model');
  assert.equal(requests[0].temperature, 0.25);
  assert.equal(requests[0].max_tokens, 1024);
  assert.deepEqual(requests[0].chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(result.metadata.chatTemplateKwargs, { enable_thinking: false });
});

test('CJS enables server thinking without sending Pi context settings', async (t) => {
  const { config } = await fixture(t);
  const requests = [];
  mockModel(t, [finish('Blocked.', 'blocked')], requests);
  const result = await new Provider({ config: { ...config, model: 'qwen3.8-27b',
    temperature: 0, maxTokens: 8192, contextWindow: 131072,
    piCompaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    chatTemplateKwargs: { enable_thinking: true } } }).callApi('Upgrade');
  assert.equal(result.error, undefined);
  assert.equal(requests[0].model, 'qwen3.8-27b');
  assert.equal(requests[0].temperature, 0);
  assert.equal(requests[0].max_tokens, 8192);
  assert.deepEqual(requests[0].chat_template_kwargs, { enable_thinking: true });
  assert.equal(requests[0].contextWindow, undefined);
  assert.equal(requests[0].piCompaction, undefined);
  assert.deepEqual(result.metadata.chatTemplateKwargs, { enable_thinking: true });
});

test('without-skills run has identical tools but cannot load a skill', async (t) => {
  const { config } = await fixture(t);
  const requests = [];
  mockModel(t, [
    calls(['read_skill', { name: 'update-sling-parent-pom' }]),
    finish('No skill available.', 'blocked'),
  ], requests);
  const result = await new Provider({ config: { ...config, install_skills: false } }).callApi('Upgrade');
  assert.equal(result.error, undefined);
  assert.match(requests[0].messages[0].content, /Installed skill catalog.*\[\]/);
  assert.match(requests[1].messages.at(-1).content, /Skill is not installed/);
  assert.deepEqual(result.metadata.skillCalls, [{ name: 'update-sling-parent-pom', is_error: true }]);
  assert.equal(skillGrade('', { providerResponse: result }).pass, true);
  assert.ok(requests[0].tools.some((tool) => tool.function.name === 'replace_text'));
});

test('each call gets a fresh clone and ignored build outputs are not copied', async (t) => {
  const { source, config } = await fixture(t);
  await fs.mkdir(path.join(source, 'target'));
  await fs.writeFile(path.join(source, 'target', 'stale.txt'), 'stale');
  const first = await Provider.prepare(config);
  await fs.writeFile(path.join(first.workingDir, 'pom.xml'), 'changed');
  const second = await Provider.prepare(config);
  assert.notEqual(first.workingDir, second.workingDir);
  assert.equal(first.baselineCommit, second.baselineCommit);
  assert.match(await fs.readFile(path.join(second.workingDir, 'pom.xml'), 'utf8'), /<version>52/);
  await assert.rejects(fs.stat(path.join(second.workingDir, 'target')), { code: 'ENOENT' });
});

test('dirty source and missing model key fail instead of modifying the source', async (t) => {
  const { source, config } = await fixture(t);
  await fs.writeFile(path.join(source, 'local.txt'), 'user work');
  await assert.rejects(Provider.prepare(config), /must be clean/);
  setEnv(t, 'LITELLM_API_KEY', undefined);
  assert.match((await new Provider({ config }).callApi('Upgrade')).error, /LITELLM_API_KEY/);
  assert.equal(await fs.readFile(path.join(source, 'local.txt'), 'utf8'), 'user work');
});

test('tool loop fails on budget exhaustion and API errors', async (t) => {
  const { config } = await fixture(t);
  mockModel(t, [calls(['read_file', { path: 'pom.xml' }])]);
  const result = await new Provider({ config: { ...config, maxTurns: 1 } }).callApi('Upgrade');
  assert.equal(result.error, undefined);
  assert.equal(result.metadata.completion.status, 'incomplete');
  assert.match(result.metadata.completion.summary, /did not call finish_task within 1 turns/);
  t.mock.method(globalThis, 'fetch', async () => new Response('bad credentials', { status: 401 }));
  assert.match((await new Provider({ config }).callApi('Upgrade')).error, /LiteLLM HTTP 401/);
});

test('editing tools preserve Latin-1, reject ambiguous edits and confine paths', async (t) => {
  const { source } = await fixture(t);
  const file = path.join(source, 'latin.xml');
  await fs.writeFile(file, '<?xml version="1.0" encoding="ISO-8859-1"?><name>caf\u00e9</name>', 'latin1');
  const state = { workingDir: source, skills: [] };
  await executeTool('replace_text', { path: 'latin.xml', old_text: 'caf\u00e9', new_text: 'th\u00e9' }, state);
  assert.match((await readText(file)).text, /th\u00e9/);
  assert.ok((await fs.readFile(file)).includes(0xe9));
  await assert.rejects(executeTool('replace_text', { path: 'pom.xml', old_text: 'version', new_text: 'oops' }, state), /exactly once/);
  await assert.rejects(safePath(source, '../outside'), /outside/);
  await assert.rejects(safePath(source, '.git/config'), /outside/);
  await fs.symlink(path.dirname(source), path.join(source, 'outside-link'));
  await assert.rejects(safePath(source, 'outside-link/file'), /outside/);
  await fs.symlink(path.join(path.dirname(source), 'nonexistent'), path.join(source, 'dangling'));
  await assert.rejects(safePath(source, 'dangling'), /Dangling/);
});

test('Maven grader checks exit status in the edited workspace, not model text', async (t) => {
  const { root, source, config } = await fixture(t);
  const state = await Provider.prepare(config);
  state.completion = { status: 'completed', summary: 'Upgraded.' };
  await fs.writeFile(path.join(state.workingDir, 'pom.xml'), pom('99'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'mvn'), `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), key: process.env.LITELLM_API_KEY }));\n` +
    `console.log('Fake Maven log'); process.exit(Number(process.env.TEST_MAVEN_EXIT || 0));\n`, { mode: 0o755 });
  setEnv(t, 'PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  setEnv(t, 'LITELLM_API_KEY', 'must-not-reach-maven');
  setEnv(t, 'TEST_MAVEN_EXIT', '0');
  const context = { providerResponse: { metadata: state } };
  assert.equal((await grade('The build failed!', context)).pass, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(state.workingDir, 'invocation.json'), 'utf8')), { args: ['clean', 'verify'] });
  await assert.rejects(fs.stat(path.join(source, 'invocation.json')), { code: 'ENOENT' });
  setEnv(t, 'TEST_MAVEN_EXIT', '1');
  const failed = await grade('BUILD SUCCESS', context);
  assert.equal(failed.pass, false);
  assert.match(failed.reason, /exited 1/);
  assert.match(failed.reason, /Fake Maven log/);
  assert.equal((await grade('BUILD SUCCESS', {})).pass, false);
  setEnv(t, 'PATH', bin);
  await fs.unlink(path.join(bin, 'mvn'));
  assert.equal((await grade('BUILD SUCCESS', context)).pass, false);
});

test('long-running commands time out and retain their logs', async (t) => {
  const { root } = await fixture(t);
  const log = path.join(root, 'timeout.log');
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: root, log, timeoutMs: 100,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.ok(await fs.stat(log));
});

test('progress narration does not end the editing loop', async (t) => {
  const { config } = await fixture(t);
  const requests = [];
  mockModel(t, [
    { choices: [{ finish_reason: 'stop', message: { content: "I'll try a different approach." } }] },
    calls(['read_file', { path: 'pom.xml' }]),
    calls(['replace_text', { path: 'pom.xml', old_text: '<version>52</version>', new_text: '<version>99</version>' }]),
    finish(),
  ], requests);
  const result = await new Provider({ config }).callApi('Upgrade');
  assert.equal(result.metadata.completion.status, 'completed');
  assert.match(requests[1].messages.at(-1).content, /progress narration/);
  assert.equal((await parentGrade('', { providerResponse: result })).pass, true);
});

test('endless narration is bounded and fails without running Maven', async (t) => {
  const { config } = await fixture(t);
  mockModel(t, Array.from({ length: 3 }, () => ({ choices: [{ message: { content: 'Let me investigate further.' } }] })));
  const result = await new Provider({ config }).callApi('Upgrade');
  assert.equal(result.error, undefined);
  assert.equal(result.metadata.completion.status, 'incomplete');
  assert.equal(result.metadata.turns, 3);
  const verification = await grade('BUILD SUCCESS', { providerResponse: result });
  assert.equal(verification.pass, false);
  assert.match(verification.reason, /Maven not run/);
  await assert.rejects(fs.stat(path.join(result.metadata.runDir, 'maven-verify.log')), { code: 'ENOENT' });
});

test('confusing a skill with a tool gets an actionable error, not implicit skill loading', async (t) => {
  const { config } = await fixture(t);
  const requests = [];
  mockModel(t, [calls(['update-sling-parent-pom', { version: 'latest' }]),
    calls(['read_skill', { name: 'update-sling-parent-pom' }]), finish('Blocked.', 'blocked')], requests);
  const result = await new Provider({ config }).callApi('Upgrade');
  assert.match(requests[1].messages.at(-1).content, /Call read_skill/);
  assert.equal(result.metadata.toolCalls[0].is_error, true);
  assert.deepEqual(result.metadata.skillCalls, [{ name: 'update-sling-parent-pom', is_error: false }]);
  assert.equal(skillGrade('', { providerResponse: { metadata: { skillsInstalled: true, skillCalls: [] } } }).pass, false);
});

test('repeated failed URL fetches are cached and a stalled loop stops early', async (t) => {
  const { config } = await fixture(t);
  const requests = [];
  let urlFetches = 0;
  mockModel(t, Array.from({ length: 4 }, () => calls(['fetch_url', { url: 'https://example.invalid/missing' }])), requests);
  const modelFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) === 'https://example.invalid/missing') {
      urlFetches++;
      return new Response('Not found', { status: 404 });
    }
    return modelFetch(url, init);
  });
  const result = await new Provider({ config }).callApi('Upgrade');
  assert.equal(urlFetches, 1);
  assert.equal(result.metadata.completion.status, 'incomplete');
  assert.match(result.metadata.completion.summary, /stalled tool loop/);
  assert.equal(result.metadata.toolCalls[1].cached, true);
  assert.equal(JSON.parse(result.output).sources.length, 1);
});

test('old verbose tool outputs are archived but skill instructions remain available', async (t) => {
  const { source, config } = await fixture(t);
  await fs.writeFile(path.join(source, 'large.txt'), `START-${'x'.repeat(12000)}-END`);
  await exec('git', ['add', 'large.txt'], { cwd: source });
  await exec('git', ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'large fixture'], { cwd: source });
  const requests = [];
  mockModel(t, [calls(['read_skill', { name: 'update-sling-parent-pom' }], ['read_file', { path: 'large.txt' }]),
    calls(['read_file', { path: 'pom.xml' }]), finish('Blocked.', 'blocked')], requests);
  const result = await new Provider({ config: { ...config, recentToolTurns: 1, toolOutputChars: 2000 } }).callApi('Upgrade');
  const history = requests[1].messages.filter((message) => message.role === 'tool');
  assert.match(history[0].content, /Updating the Sling Parent POM/);
  assert.equal(JSON.parse(history[1].content).archived, true);
  assert.ok(history[1].content.length < 1500);
  assert.equal(result.metadata.toolCalls[1].output.length, 12010);
  assert.match(await fs.readFile(path.join(result.metadata.runDir, 'model-responses.jsonl'), 'utf8'), /finish_task/);
});

test('parent assertion reads actual XML and rejects unchanged, downgraded, snapshot and unrelated parents', async (t) => {
  const { config } = await fixture(t);
  const metadata = await Provider.prepare(config);
  metadata.completion = { status: 'completed', summary: 'Trust me!' };
  const context = { providerResponse: { metadata } };
  for (const invalid of [pom(), pom('51'), pom('66-SNAPSHOT'), pom('99', 'unrelated'), pom('99', 'sling', 'other.group')]) {
    await fs.writeFile(path.join(metadata.workingDir, 'pom.xml'), invalid);
    assert.equal((await parentGrade('Claimed upgrade', context)).pass, false);
  }
  await fs.writeFile(path.join(metadata.workingDir, 'pom.xml'),
    `<?xml version="1.0"?><project xmlns="http://maven.apache.org/POM/4.0.0"><!-- <parent><version>1000</version></parent> --><parent><groupId>org.apache.sling</groupId><artifactId>sling</artifactId><version>66</version></parent></project>`);
  assert.equal((await parentGrade('', context)).pass, true);
  metadata.completion.status = 'blocked';
  assert.equal((await parentGrade('', context)).pass, false);
  metadata.completion.status = 'completed';
  await fs.writeFile(path.join(metadata.workingDir, 'pom.xml'), '<project><build><parent><version>999</version></parent></build></project>');
  assert.equal((await parentGrade('', context)).pass, false);
});

test('completed-without-edits cannot trigger a successful baseline Maven build', async (t) => {
  const { config } = await fixture(t);
  mockModel(t, [finish('Done!')]);
  const result = await new Provider({ config }).callApi('Upgrade');
  assert.equal(result.metadata.workspaceDiff, '');
  const verification = await grade('', { providerResponse: result });
  assert.equal(verification.pass, false);
  assert.match(verification.reason, /Parent was not upgraded/);
  await assert.rejects(fs.stat(path.join(result.metadata.runDir, 'maven-verify.log')), { code: 'ENOENT' });
});

test('HTML extraction removes script/style noise while retaining useful links', () => {
  const extracted = htmlToText('<html><style>body{color:red}</style><script>window.track()</script><p>Parent &amp; releases</p><a href="/maven-metadata.xml">Metadata</a></html>', 'https://example.invalid/');
  assert.doesNotMatch(extracted, /track|color:red|<html>/);
  assert.match(extracted, /Parent & releases/);
  assert.match(extracted, /\[Metadata\]\(https:\/\/example.invalid\/maven-metadata.xml\)/);
});
