const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const Provider = require('./pi-provider.cjs');
const parentGrade = require('./assertions/parent-upgrade.cjs');
const skillGrade = require('./assertions/skill-usage.cjs');
const { projectRoot } = require('../../shared/scenarios.cjs');

const exec = promisify(execFile);
const pom = '<project><parent><groupId>org.apache.sling</groupId><artifactId>sling-bundle-parent</artifactId><version>52</version></parent></project>\n';
const restoredEnvs = new WeakMap();

function setEnv(t, name, value) {
  if (!restoredEnvs.has(t)) restoredEnvs.set(t, new Set());
  const restored = restoredEnvs.get(t);
  if (!restored.has(name)) {
    restored.add(name);
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function fixture(t) {
  const reposRoot = path.join(projectRoot, 'repos');
  await fs.mkdir(reposRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(reposRoot, '.sling-pi-test-'));
  t.after(() => process.env.PI_EVAL_KEEP_ARTIFACTS ? undefined :
    fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  setEnv(t, 'PROMPTFOO_REPO', undefined);
  setEnv(t, 'PROMPTFOO_WORKSPACE_ROOT', path.join(root, 'runs'));
  setEnv(t, 'LITELLM_API_KEY', 'local-test-key');
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await exec('git', ['init', '--quiet', source]);
  await fs.writeFile(path.join(source, 'pom.xml'), pom);
  await fs.writeFile(path.join(source, '.gitignore'), 'target/\n.tokensave/\n');
  await exec('git', ['add', '.'], { cwd: source });
  await exec('git', ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture'], { cwd: source });
  const command = path.join(root, 'fake-pi');
  await fs.writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('1.4.0-test'); process.exit(0); }
const args = process.argv.slice(2);
const root = path.dirname(process.cwd());
const scenario = process.env.TEST_PI_SCENARIO || 'complete';
fs.writeFileSync(path.join(root, 'invocation.json'), JSON.stringify({ args, agentDir: process.env.PI_CODING_AGENT_DIR,
  offline: process.env.PI_OFFLINE, telemetry: process.env.PI_TELEMETRY, gitDir: process.env.GIT_DIR }));
const emit = (event) => console.log(JSON.stringify(event));
const usage = { input: 10, output: 2, totalTokens: 12 };
let index = 0;
const call = (name, input, output = {}) => {
  const id = 'call-' + index++;
  emit({ type: 'turn_start' });
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Narration' } });
  emit({ type: 'message_end', message: { role: 'assistant', usage, stopReason: 'toolUse' } });
  emit({ type: 'tool_execution_start', toolCallId: id, toolName: name, args: input });
  emit({ type: 'tool_execution_end', toolCallId: id, toolName: name, result: output, isError: false });
};
emit({ type: 'session' });
if (scenario === 'timeout') { setInterval(() => {}, 1000); }
else if (scenario === 'malformed') { console.log('not json'); }
else if (scenario === 'exit') { process.exit(2); }
else if (['error', 'length'].includes(scenario)) {
  emit({ type: 'message_end', message: { role: 'assistant', usage, stopReason: scenario, errorMessage: 'test failure' } });
  emit({ type: 'agent_settled', aborted: false });
} else if (scenario === 'incomplete') { emit({ type: 'agent_settled', aborted: false }); }
else if (scenario === 'context-length' || scenario === 'reasoning-length') {
  const context = scenario === 'context-length';
  emit({ type: 'entry_appended', entry: { type: 'custom', customType: 'eval-request', data: {
    maxTokens: context ? 1 : 8192, contextTokens: context ? 29148 : 13475, contextWindow: 32768 } } });
  emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'length', usage: {
    input: context ? 29083 : 13433, output: context ? 1 : 8192, reasoning: context ? 1 : 7541,
    totalTokens: context ? 29084 : 21625 } } });
  emit({ type: 'agent_settled', aborted: false });
}
else if (scenario === 'unsettled') { /* exit without a terminal event */ }
else {
  if (scenario === 'compacted') {
    const result = { tokensBefore: 25000, estimatedTokensAfter: 8000,
      usage: { input: 100, output: 20, reasoning: 7, totalTokens: 120 } };
    emit({ type: 'entry_appended', entry: { type: 'compaction', usage: result.usage } });
    emit({ type: 'compaction_end', reason: 'threshold', result, aborted: false, willRetry: false });
  }
  if (args.includes('--skill')) call('read', { path: path.join(args[args.indexOf('--skill') + 1], 'update-sling-parent-pom', 'SKILL.md') });
  fs.writeFileSync('pom.xml', fs.readFileSync('pom.xml', 'utf8').replace('<version>52</version>', '<version>99</version>'));
  call('edit', { path: 'pom.xml' });
  call('bash', { command: 'curl https://example.invalid/metadata' }, { content: [{ type: 'text', text: 'Release 99' }] });
  call('finish_task', { status: 'completed', summary: 'Upgraded.\\u2028Verified.' });
  emit({ type: 'entry_appended', entry: { type: 'custom', customType: 'eval-completion', data: { status: 'completed', summary: 'Upgraded.\\u2028Verified.' } } });
  if (scenario === 'abort-tail' || scenario === 'post-completion-error') {
    emit({ type: 'turn_start' });
    emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 0, output: 0, totalTokens: 0 },
      stopReason: 'error', errorMessage: scenario === 'abort-tail' ? 'This operation was aborted' : '401 Unauthorized' } });
  }
  emit({ type: 'agent_settled', aborted: true });
}
`, { mode: 0o755 });
  return { root, source, config: {
    working_dir: source, skills_dir: './skills', install_skills: true,
    model: 'shared-model', apiBaseUrl: 'https://llm.example.invalid/v1',
    temperature: 0.25, maxTokens: 1024, contextWindow: 32768, chatTemplateKwargs: { enable_thinking: false },
    piCompaction: { keepRecentTokens: 6000 }, // Deliberately small context for starvation/compaction regressions.
    maxTurns: 8, maxTextOnlyTurns: 3, mavenTimeoutMs: 2000, piCommand: command,
  } };
}

test('Pi adapter applies generation config, grades actual edits, and isolates resources', async (t) => {
  const { source, config } = await fixture(t);
  // An inherited PI directory must never override the private evaluation config.
  setEnv(t, 'PI_CODING_AGENT_DIR', '/does/not/exist');
  const result = await new Provider({ config }).callApi('Upgrade');
  assert.equal(result.error, undefined);
  assert.equal(result.cached, false);
  assert.equal(result.tokenUsage.total, 48); // message_update usage must not be double-counted
  assert.equal(result.metadata.harness, 'pi');
  assert.equal(result.metadata.piVersion, '1.4.0-test');
  assert.equal(result.metadata.completion.status, 'completed');
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
  const repository = { name: 'source', revision, directory: path.relative(projectRoot, source) };
  assert.deepEqual(result.metadata.repository, repository);
  assert.deepEqual(JSON.parse(result.output).repository, repository);
  assert.equal((await parentGrade('', { providerResponse: result })).pass, true);
  assert.equal(skillGrade('', { providerResponse: result }).pass, true);
  assert.match(JSON.parse(result.output).sources[0].command, /curl/);
  assert.match(JSON.parse(result.output).sources[0].output, /Release 99/);
  const invocation = JSON.parse(await fs.readFile(path.join(result.metadata.runDir, 'invocation.json')));
  assert.equal(invocation.offline, '1');
  assert.equal(invocation.telemetry, '0');
  for (const flag of ['--no-session', '--no-extensions', '--no-mcp', '--no-context-files', '--no-skills', '--no-approve']) {
    assert.ok(invocation.args.includes(flag), flag);
  }
  assert.ok(!invocation.args.includes('local-test-key'));
  const modelsText = await fs.readFile(path.join(invocation.agentDir, 'models.json'), 'utf8');
  assert.doesNotMatch(modelsText, /local-test-key/);
  const provider = JSON.parse(modelsText).providers['apache-evals'];
  assert.equal(provider.baseUrl, config.apiBaseUrl);
  assert.equal(provider.apiKey, '$LITELLM_API_KEY');
  assert.equal(provider.models[0].id, config.model);
  assert.equal(provider.models[0].samplingParams.temperature, 0.25);
  assert.equal(provider.models[0].maxTokens, 1024);
  assert.equal(provider.models[0].contextWindow, 32768);
  assert.deepEqual(provider.models[0].samplingParams.chat_template_kwargs, { enable_thinking: false });
  assert.equal(provider.compat.maxTokensField, 'max_tokens');
  const settings = JSON.parse(await fs.readFile(path.join(invocation.agentDir, 'settings.json')));
  assert.equal(settings.compaction.enabled, true);
  assert.ok(settings.compaction.reserveTokens >= config.maxTokens + 4096);
  assert.ok(settings.compaction.keepRecentTokens < config.contextWindow - settings.compaction.reserveTokens);
  const controls = JSON.parse(await fs.readFile(path.join(invocation.agentDir, 'eval.json')));
  assert.equal(controls.maxToolRepeats, 3);
  assert.equal(await fs.readFile(path.join(source, 'pom.xml'), 'utf8'), pom);
  assert.equal((await exec('git', ['remote'], { cwd: result.metadata.workingDir })).stdout, '');
});

test('Pi uses the corrected context and default compaction budgets with thinking enabled', async (t) => {
  const { config } = await fixture(t);
  const result = await new Provider({ config: { ...config, model: 'qwen3.8-27b',
    temperature: 0, maxTokens: 8192, contextWindow: 131072, piCompaction: undefined,
    chatTemplateKwargs: { enable_thinking: true } } }).callApi('Upgrade');
  assert.equal(result.error, undefined);
  const agentDir = path.join(result.metadata.runDir, 'pi-agent');
  const model = JSON.parse(await fs.readFile(path.join(agentDir, 'models.json'))).providers['apache-evals'].models[0];
  assert.equal(model.contextWindow, 131072);
  assert.equal(model.maxTokens, 8192);
  assert.equal(model.samplingParams.temperature, 0);
  assert.deepEqual(model.samplingParams.chat_template_kwargs, { enable_thinking: true });
  const settings = JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json')));
  assert.deepEqual(settings.compaction, { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
  assert.equal(model.contextWindow - settings.compaction.reserveTokens, 114688);
  assert.equal(result.metadata.contextWindow, 131072);
  assert.deepEqual(result.metadata.chatTemplateKwargs, { enable_thinking: true });
  const controls = JSON.parse(await fs.readFile(path.join(agentDir, 'eval.json')));
  assert.equal(controls.maxToolRepeats, 3);
});

test('Pi requires explicit model context even with compaction disabled', async (t) => {
  const { config } = await fixture(t);
  for (const contextWindow of [undefined, 0, -1, 131072.5, '131072']) {
    const result = await new Provider({ config: { ...config, contextWindow,
      piCompaction: { enabled: false } } }).callApi('Upgrade');
    assert.match(result.error, /contextWindow must be an explicit positive integer/);
    await assert.rejects(fs.stat(path.join(result.metadata.runDir, 'invocation.json')), { code: 'ENOENT' });
  }
});

test('Pi length errors expose usage, effective budgets, and retained diagnostics', async (t) => {
  const { config } = await fixture(t);
  for (const [scenario, reason, output, reasoning] of [
    ['context-length', /context\/output budget exhausted/, 1, 1],
    ['reasoning-length', /output-token limit reached/, 8192, 7541],
  ]) {
    setEnv(t, 'TEST_PI_SCENARIO', scenario);
    const result = await new Provider({ config: { ...config, maxTokens: 8192 } }).callApi('Upgrade');
    assert.match(result.error, reason);
    assert.match(result.error, /effective max_tokens=/);
    assert.ok(result.error.includes(result.metadata.runDir));
    assert.equal(result.tokenUsage.completion, output);
    assert.equal(result.tokenUsage.completionDetails.reasoning, reasoning);
    const error = JSON.parse(await fs.readFile(path.join(result.metadata.runDir, 'error.json')));
    assert.equal(error.diagnostics.modelCalls[0].stopReason, 'length');
    assert.equal(error.tokenUsage.completionDetails.reasoning, reasoning);
    assert.ok(await fs.stat(path.join(result.metadata.runDir, 'diagnostics.json')));
  }
});

test('Pi rejects compaction settings that leave no answer budget', async (t) => {
  const { config } = await fixture(t);
  const result = await new Provider({ config: { ...config,
    piCompaction: { reserveTokens: 4096, keepRecentTokens: 20000 } } }).callApi('Upgrade');
  assert.match(result.error, /piCompaction must reserve at least maxTokens \+ 4096/);
});

test('Pi counts summarization usage once, with reasoning already included in output', async (t) => {
  const { config } = await fixture(t);
  setEnv(t, 'TEST_PI_SCENARIO', 'compacted');
  const result = await new Provider({ config }).callApi('Upgrade');
  assert.equal(result.error, undefined);
  assert.equal(result.tokenUsage.prompt, 140);
  assert.equal(result.tokenUsage.completion, 28);
  assert.equal(result.tokenUsage.total, 168);
  assert.equal(result.tokenUsage.completionDetails.reasoning, 7);
  assert.equal(result.metadata.diagnostics.compactions.length, 1);
});

test('Pi no-skills variant has no skill path and disables ambient discovery', async (t) => {
  const { config } = await fixture(t);
  const result = await new Provider({ config: { ...config, install_skills: false } }).callApi('Upgrade');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.metadata.skillCalls, []);
  assert.equal(skillGrade('', { providerResponse: result }).pass, true);
  const invocation = JSON.parse(await fs.readFile(path.join(result.metadata.runDir, 'invocation.json')));
  assert.ok(!invocation.args.includes('--skill'));
  await assert.rejects(fs.stat(path.join(result.metadata.runDir, 'skills')), { code: 'ENOENT' });
});

test('Pi only ignores an empty cancellation tail after explicit completion', async (t) => {
  const { config } = await fixture(t);
  setEnv(t, 'TEST_PI_SCENARIO', 'abort-tail');
  const completed = await new Provider({ config }).callApi('Upgrade');
  assert.equal(completed.error, undefined);
  assert.equal(completed.metadata.turns, 4);
  assert.equal(completed.tokenUsage.total, 48);
  setEnv(t, 'TEST_PI_SCENARIO', 'post-completion-error');
  assert.match((await new Provider({ config }).callApi('Upgrade')).error, /401 Unauthorized/);
});

test('Pi model errors, truncation, malformed events, bad exits and missing settlement are errors', async (t) => {
  const { config } = await fixture(t);
  for (const [scenario, expected] of [['error', /Pi model error/], ['length', /Pi model length/],
    ['malformed', /JSON|Unexpected token/], ['exit', /Pi exited 2/], ['unsettled', /without agent_settled/]]) {
    setEnv(t, 'TEST_PI_SCENARIO', scenario);
    const result = await new Provider({ config }).callApi('Upgrade');
    assert.match(result.error, expected);
    assert.ok(result.metadata.runDir);
    assert.equal(result.metadata.repository.name, 'source');
    assert.match(result.metadata.repository.revision, /^[a-f0-9]{40,64}$/);
    assert.equal(result.metadata.baselineCommit, result.metadata.repository.revision);
    const error = JSON.parse(await fs.readFile(path.join(result.metadata.runDir, 'error.json')));
    assert.deepEqual(error.repository, result.metadata.repository);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.metadata.runDir, 'repository.json'))), result.metadata.repository);
  }
});

test('Pi missing completion and timeout are failed tasks, not successful evaluations', async (t) => {
  const { config } = await fixture(t);
  for (const scenario of ['incomplete', 'timeout']) {
    setEnv(t, 'TEST_PI_SCENARIO', scenario);
    const result = await new Provider({ config: { ...config, piTimeoutMs: 200 } }).callApi('Upgrade');
    assert.equal(result.error, undefined);
    assert.equal(result.metadata.completion.status, 'incomplete');
    assert.equal((await parentGrade('', { providerResponse: result })).pass, false);
    assert.ok(await fs.stat(path.join(result.metadata.runDir, 'completion.json')));
  }
});

test('Pi aborts and missing credentials fail without treating them as task completion', async (t) => {
  const { config } = await fixture(t);
  const aborted = await new Provider({ config }).callApi('Upgrade', {}, { abortSignal: AbortSignal.abort() });
  assert.match(aborted.error, /abort/i);
  setEnv(t, 'TEST_PI_SCENARIO', 'timeout');
  const running = await new Provider({ config }).callApi('Upgrade', {}, { abortSignal: AbortSignal.timeout(300) });
  assert.match(running.error, /abort|timeout/i);
  setEnv(t, 'LITELLM_API_KEY', undefined);
  const missingKey = await new Provider({ config }).callApi('Upgrade');
  assert.match(missingKey.error, /LITELLM_API_KEY/);
  assert.equal(missingKey.metadata.repository.name, 'source');
});

test('Pi validates repository boundaries before invoking any Pi command and retains provenance if Pi is missing', async (t) => {
  const { config } = await fixture(t);
  const piCommand = '/does/not/exist';
  const invalid = await new Provider({ config: { ...config, working_dir: '/tmp/opencode', piCommand } }).callApi('Upgrade');
  assert.match(invalid.error, /subdirectory of repos/);
  assert.equal(invalid.metadata.runDir, undefined);
  const missingPi = await new Provider({ config: { ...config, piCommand } }).callApi('Upgrade');
  assert.match(missingPi.error, /ENOENT/);
  assert.equal(missingPi.metadata.repository.name, 'source');
  assert.match(missingPi.metadata.repository.revision, /^[a-f0-9]{40,64}$/);
});

test('Pi JSONL parser preserves Unicode line separators and split UTF-8 data', async (t) => {
  const root = await fs.mkdtemp('/tmp/opencode/sling-jsonl-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  const value = { text: `${'x'.repeat(65520)}\u2028\u2029\u00e9` };
  await fs.writeFile(file, `${JSON.stringify(value)}\r\n${JSON.stringify({ done: true })}`);
  assert.deepEqual(await Array.fromAsync(Provider.events(file)), [value, { done: true }]);
});

// Opt-in: uses the installed Pi CLI and a loopback SSE endpoint, never a paid model.
test('installed Pi uses native tools and the configured request settings', {
  skip: !process.env.PI_EVAL_INTEGRATION, timeout: 120000,
}, async (t) => {
  const { source, config } = await fixture(t);
  let requests = [];
  let responses = [];
  let shellReady;
  let summaryRequests = [];
  let summarize = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/reference') { res.end('Latest release: 99'); return; }
    if (req.url.startsWith('/shell-ready?')) {
      res.end('ready');
      shellReady?.(Number(new URL(req.url, 'http://localhost').searchParams.get('pid')));
      return;
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    const summary = summarize && !body.tools?.length;
    if (summary) summaryRequests.push(body);
    const response = summary ? { content: '## Goal\nUpgrade the Sling parent.\n## Progress\nRead project files. Continue editing and call finish_task.',
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 7 } } } : responses.shift();
    if (!response) { res.writeHead(500).end('Unexpected model request'); return; }
    if (response.error) { res.writeHead(401).end('Test authentication failure'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (choices, usage) => res.write(`data: ${JSON.stringify({ id: `test-${requests.length}`, object: 'chat.completion.chunk',
      created: 1, model: config.model, choices, ...(usage ? { usage } : {}) })}\n\n`);
    const { usage, finishReason, ...delta } = response;
    chunk([{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }]);
    chunk([{ index: 0, delta: {}, finish_reason: finishReason ?? (response.tool_calls ? 'tool_calls' : 'stop') }]);
    chunk([], usage ?? { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let nextCall = 0;
  const tool = (...items) => ({ tool_calls: items.map(([name, args], index) => ({ index, id: `call-${nextCall++}`,
    type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  const evaluate = (overrides = {}, options) => new Provider({ config: { ...config,
    piCommand: process.env.PI_EVAL_COMMAND ?? 'pi', apiBaseUrl: `${base}/v1`,
    install_skills: false, piTimeoutMs: 20000, ...overrides,
  } }).callApi('Upgrade', {}, options);
  for (const install_skills of [true, false]) for (const enable_thinking of [true, false]) {
    requests = [];
    // The catalog contains the per-run private path; use it in the server response.
    responses = [
      { content: 'Let me investigate further.' },
      tool(['read', { path: 'pom.xml' }]),
      tool(['edit', { path: 'pom.xml', oldText: '<version>52</version>', newText: '<version>99</version>' }]),
      tool(['bash', { command: `node -e 'if (process.env.LITELLM_API_KEY) process.exit(1); require("node:fs").writeFileSync("native.txt", "safe\\n")'` }]),
      tool(['bash', { command: `curl --fail --silent ${base}/reference` }]),
      tool(['finish_task', { status: 'completed', summary: 'Upgraded.\u2028Verified.' }]),
    ];
    if (install_skills) {
      const readPom = responses[1];
      // Fill the skill read after the first request exposes Pi's actual catalog.
      Object.defineProperty(readPom, 'tool_calls', { enumerable: true, get() {
        const prompt = JSON.stringify(requests[0].body.messages);
        const match = prompt.match(/\/[^\s<>"\\]*\/skills\/update-sling-parent-pom\/SKILL\.md/);
        assert.ok(match, 'private skill path advertised by native Pi');
        return tool(['read', { path: match[0] }], ['read', { path: 'pom.xml' }]).tool_calls;
      } });
    }
    const result = await new Provider({ config: { ...config, piCommand: process.env.PI_EVAL_COMMAND ?? 'pi',
      apiBaseUrl: `${base}/v1`, install_skills, piTimeoutMs: 20000,
      chatTemplateKwargs: { enable_thinking } } }).callApi('Upgrade');
    assert.equal(result.error, undefined, result.error && `${result.error}; artifacts: ${result.metadata.runDir}`);
    assert.equal(result.metadata.completion.status, 'completed');
    assert.equal(result.metadata.turns, 6);
    assert.equal(result.tokenUsage.total, 72);
    assert.equal((await parentGrade('', { providerResponse: result })).pass, true);
    assert.equal(skillGrade('', { providerResponse: result }).pass, true);
    assert.equal(await fs.readFile(path.join(result.metadata.workingDir, 'native.txt'), 'utf8'), 'safe\n');
    assert.ok(result.metadata.toolCalls.every((call) => !call.is_error));
    for (const request of requests) {
      assert.equal(request.authorization, 'Bearer local-test-key');
      assert.equal(request.body.model, config.model);
      assert.equal(request.body.temperature, config.temperature);
      assert.equal(request.body.max_tokens, config.maxTokens);
      assert.deepEqual(request.body.chat_template_kwargs, { enable_thinking });
      assert.equal(request.body.stream, true);
      assert.ok(!request.body.messages.some((message) => message.role === 'developer'));
      assert.equal(request.body.reasoning_effort, undefined);
      assert.ok(request.body.tools.some((item) => item.function.name === 'edit'));
      assert.ok(!request.body.tools.some((item) => item.function.name === 'replace_text'));
      if (!install_skills) assert.doesNotMatch(JSON.stringify(request.body.messages), /<available_skills>|osgi-scr-migrator/);
    }
    assert.match(JSON.stringify(JSON.parse(result.output).sources), /Latest release: 99/);
  }
  assert.equal(await fs.readFile(path.join(source, 'pom.xml'), 'utf8'), pom);

  // The corrected window must retain the full output allowance beyond the old
  // 32,768-token limit, without premature native summarization.
  requests = [];
  summaryRequests = [];
  summarize = true;
  responses = [
    { ...tool(['read', { path: 'pom.xml' }]), reasoning_content: 'Inspect the parent.',
      usage: { prompt_tokens: 90000, completion_tokens: 20, total_tokens: 90020,
        completion_tokens_details: { reasoning_tokens: 7 } } },
    tool(['finish_task', { status: 'blocked', summary: 'Context budget verified.' }]),
  ];
  const largeContext = await evaluate({ model: 'qwen3.8-27b', temperature: 0,
    contextWindow: 131072, maxTokens: 8192,
    piCompaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    chatTemplateKwargs: { enable_thinking: true } });
  assert.equal(largeContext.error, undefined, largeContext.error);
  assert.equal(summaryRequests.length, 0);
  assert.equal(largeContext.metadata.diagnostics.compactions.length, 0);
  assert.equal(largeContext.tokenUsage.completionDetails.reasoning, 7);
  assert.equal(largeContext.metadata.contextWindow, 131072);
  assert.ok(largeContext.metadata.diagnostics.requests.every((request) => request.contextWindow === 131072));
  assert.equal(requests.length, 2);
  for (const { body } of requests) {
    assert.equal(body.model, 'qwen3.8-27b');
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 8192);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
  }
  summarize = false;

  // Reproduce the original one-token failure when native compaction is disabled.
  requests = [];
  responses = [
    { ...tool(['read', { path: 'pom.xml' }]), usage: { prompt_tokens: 29000, completion_tokens: 1, total_tokens: 29001 } },
    { reasoning_content: ' ', finishReason: 'length', usage: { prompt_tokens: 29083, completion_tokens: 1, total_tokens: 29084,
      completion_tokens_details: { reasoning_tokens: 1 } } },
  ];
  const starved = await evaluate({ maxTokens: 8192, piCompaction: { enabled: false } });
  assert.match(starved.error, /context\/output budget exhausted/);
  assert.match(starved.error, /effective max_tokens=1/);
  assert.equal(requests.at(-1).body.max_tokens, 1);

  // High reported usage must trigger real native summarization before the next
  // model turn. Its extra usage is included, not hidden from the comparison.
  await fs.writeFile(path.join(source, 'large.txt'), 'x'.repeat(24000));
  await exec('git', ['add', 'large.txt'], { cwd: source });
  await exec('git', ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'large fixture'], { cwd: source });
  requests = [];
  summarize = true;
  responses = [
    { ...tool(['read', { path: 'large.txt' }]), usage: { prompt_tokens: 25000, completion_tokens: 2, total_tokens: 25002 } },
    tool(['edit', { path: 'pom.xml', oldText: '<version>52</version>', newText: '<version>99</version>' }]),
    tool(['finish_task', { status: 'completed', summary: 'Upgraded after compaction.' }]),
  ];
  const compacted = await evaluate({ maxTokens: 8192, chatTemplateKwargs: { enable_thinking: true } });
  assert.equal(compacted.error, undefined, compacted.error);
  assert.equal(compacted.metadata.completion.status, 'completed');
  assert.ok(summaryRequests.length > 0);
  assert.ok(compacted.metadata.diagnostics.compactions.some((item) => item.tokensBefore > 16000));
  assert.equal(compacted.tokenUsage.total, 25002 + 24 + summaryRequests.length * 120);
  assert.equal(compacted.tokenUsage.completionDetails.reasoning, summaryRequests.length * 7);
  assert.ok(requests.filter((request) => request.body.tools?.length).every((request) => request.body.max_tokens === 8192));
  assert.ok(summaryRequests.every((request) => request.chat_template_kwargs.enable_thinking === true));

  // A context-clamped length attempt recovered by Pi must not poison the result.
  summaryRequests = [];
  responses = [
    { reasoning_content: ' ', finishReason: 'length', usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } },
    tool(['finish_task', { status: 'blocked', summary: 'Recovered, but cannot continue.' }]),
  ];
  const recovered = await evaluate({ maxTokens: 8192, piCompaction: { keepRecentTokens: 0 } });
  assert.equal(recovered.error, undefined, recovered.error);
  assert.equal(recovered.metadata.completion.status, 'blocked');
  assert.ok(recovered.metadata.diagnostics.modelCalls.some((call) => call.stopReason === 'length'));
  assert.ok(recovered.metadata.diagnostics.modelCalls.find((call) => call.stopReason === 'length').recovered);
  assert.ok(recovered.metadata.diagnostics.compactions.some((item) => item.willRetry));
  assert.equal(recovered.tokenUsage.total, 101 + 12 + summaryRequests.length * 120);
  summarize = false;

  // The fourth identical call must be blocked BEFORE it executes, including
  // calls whose JSON object keys arrive in a different order.
  requests = [];
  const counter = path.join(path.dirname(source), 'repeat-counter');
  const repeatedCommand = `node -e 'require("node:fs").appendFileSync("${counter}", "x")'`;
  responses = Array.from({ length: 4 }, (_, index) => tool(['bash', index % 2 ?
    { timeout: 1, command: repeatedCommand } : { command: repeatedCommand, timeout: 1 }]));
  const repeated = await evaluate();
  assert.equal(repeated.error, undefined);
  assert.match(repeated.metadata.completion.summary, /stalled tool loop/);
  assert.equal(repeated.metadata.completion.status, 'incomplete');
  assert.equal(repeated.metadata.turns, 4);
  assert.equal(requests.length, 4);
  assert.equal(await fs.readFile(counter, 'utf8'), 'xxx');
  assert.equal(repeated.metadata.toolCalls.at(-1).is_error, true);

  responses = Array.from({ length: 4 }, () => tool(['bash', {
    command: 'mkdir -p target && printf x >> target/repeat-counter',
  }]));
  const ignoredOutputs = await evaluate();
  assert.equal(ignoredOutputs.error, undefined);
  assert.match(ignoredOutputs.metadata.completion.summary, /stalled tool loop/);
  assert.equal(await fs.readFile(path.join(ignoredOutputs.metadata.workingDir, 'target/repeat-counter'), 'utf8'), 'xxx');

  responses = Array.from({ length: 2 }, () => tool(['bash', { command: 'printf configurable-limit' }]));
  const configuredLimit = await evaluate({ maxToolRepeats: 1 });
  assert.equal(configuredLimit.error, undefined);
  assert.equal(configuredLimit.metadata.turns, 2);
  assert.match(configuredLimit.metadata.completion.summary, /more than 1 times/);

  // Counts span alternating cycles, not just consecutive identical calls.
  requests = [];
  responses = Array.from({ length: 12 }, (_, index) => tool(['bash', { command: `printf command-${index % 3}` }]));
  const cycling = await evaluate({ maxTurns: 20 });
  assert.equal(cycling.error, undefined);
  assert.match(cycling.metadata.completion.summary, /stalled tool loop/);
  assert.equal(cycling.metadata.turns, 10);
  assert.equal(requests.length, 10);

  responses = Array.from({ length: 4 }, () => tool(['bash', { command: 'false' }]));
  const repeatedFailure = await evaluate();
  assert.equal(repeatedFailure.error, undefined);
  assert.match(repeatedFailure.metadata.completion.summary, /stalled tool loop/);
  assert.equal(repeatedFailure.metadata.turns, 4);

  // Successful native edits and actual shell-side project edits reset counts.
  for (const edit of [
    tool(['edit', { path: 'pom.xml', oldText: '<version>52</version>', newText: '<version>99</version>' }]),
    tool(['bash', { command: `node -e 'const fs=require("node:fs"); fs.writeFileSync("pom.xml",fs.readFileSync("pom.xml","utf8").replace("<version>52</version>","<version>99</version>"))'` }]),
    tool(['bash', { command: 'printf progress > progress.txt' }]),
  ]) {
    responses = [
      ...Array.from({ length: 3 }, () => tool(['read', { path: 'pom.xml' }])), edit,
      ...Array.from({ length: 3 }, () => tool(['read', { path: 'pom.xml' }])),
      tool(['finish_task', { status: 'completed', summary: 'Made progress and verified it.' }]),
    ];
    const progressing = await evaluate();
    assert.equal(progressing.error, undefined);
    assert.equal(progressing.metadata.completion.status, 'completed');
    assert.ok(progressing.metadata.toolCalls.every((call) => !call.is_error));
  }

  // Compaction is not project progress and must not reset repetition counts.
  summarize = true;
  summaryRequests = [];
  responses = [
    ...Array.from({ length: 3 }, () => tool(['read', { path: 'pom.xml' }])),
    { ...tool(['read', { path: 'large.txt' }]), usage: { prompt_tokens: 25000, completion_tokens: 2, total_tokens: 25002 } },
    tool(['read', { path: 'pom.xml' }]),
  ];
  const compactedLoop = await evaluate({ maxTokens: 8192 });
  assert.equal(compactedLoop.error, undefined);
  assert.match(compactedLoop.metadata.completion.summary, /stalled tool loop/);
  assert.equal(compactedLoop.metadata.turns, 5);
  assert.ok(summaryRequests.length > 0);
  summarize = false;

  for (const [limits, scripted, expectedTurns, reason] of [
    [{ maxTurns: 1 }, [tool(['read', { path: 'pom.xml' }])], 1, /within 1 turns/],
    [{ maxTextOnlyTurns: 2 }, [{ content: 'Investigating.' }, { content: 'Still investigating.' }], 2, /text-only/],
  ]) {
    requests = [];
    responses = scripted;
    const limited = await evaluate(limits);
    assert.equal(limited.error, undefined);
    assert.equal(limited.metadata.completion.status, 'incomplete');
    assert.equal(limited.metadata.turns, expectedTurns);
    assert.match(limited.metadata.completion.summary, reason);
    assert.equal(requests.length, expectedTurns);
  }

  responses = [
    tool(['finish_task', { status: 'completed', summary: 'Too early.' }], ['read', { path: 'pom.xml' }]),
    tool(['finish_task', { status: 'completed', summary: ' ' }]),
    tool(['finish_task', { status: 'blocked', summary: 'Cannot continue.' }]),
  ];
  const blocked = await evaluate();
  assert.equal(blocked.error, undefined);
  assert.equal(blocked.metadata.completion.status, 'blocked');
  assert.deepEqual(blocked.metadata.toolCalls.filter((call) => call.name === 'finish_task').map((call) => call.is_error), [true, true, false]);

  responses = [tool(['bash', { command: 'sleep 5', timeout: 100 }]),
    tool(['finish_task', { status: 'blocked', summary: 'Command timed out.' }])];
  const commandTimeout = await evaluate({ mavenTimeoutMs: 100 });
  assert.equal(commandTimeout.error, undefined);
  assert.equal(commandTimeout.metadata.toolCalls[0].is_error, true);
  assert.match(JSON.stringify(commandTimeout.metadata.toolCalls[0].output), /timed out/);

  // Pi shell processes use detached groups. A parent-only kill would leak this
  // grandchild, so verify Pi's SIGTERM cleanup on both cancellation and timeout.
  for (const externalAbort of [true, false]) {
    const controller = new AbortController();
    let childPid;
    let abortTimer;
    shellReady = (pid) => {
      childPid = pid;
      t.after(() => {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      });
      if (externalAbort) abortTimer = setTimeout(() => controller.abort(), 50);
    };
    const script = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); require("node:http").get("${base}/shell-ready?pid="+child.pid); setInterval(()=>{},1000);`;
    responses = [tool(['bash', { command: `node -e '${script}'` }])];
    const stopped = await evaluate({ piTimeoutMs: externalAbort ? 10000 : 3000, mavenTimeoutMs: 20000 },
      externalAbort ? { abortSignal: controller.signal } : undefined);
    clearTimeout(abortTimer);
    assert.ok(childPid, 'native command started before stopping Pi');
    if (externalAbort) assert.match(stopped.error, /abort/i);
    else {
      assert.equal(stopped.error, undefined);
      assert.equal(stopped.metadata.completion.status, 'incomplete');
      assert.match(stopped.metadata.completion.summary, /wall-clock/);
    }
    try {
      const stat = await fs.readFile(`/proc/${childPid}/stat`, 'utf8');
      assert.match(stat, /^\d+ \(.+\) Z /, 'grandchild must be dead, not still running');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  shellReady = undefined;

  responses = [{ error: true }];
  const failed = await evaluate();
  assert.match(failed.error, /Pi model error/);
});
