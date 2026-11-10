const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { generate } = require('./generate.cjs');
const { load, select } = require('../../shared/scenarios.cjs');

// Opt-in: native Promptfoo, an echo coding provider and loopback grading only.
// No Pi, Maven or paid model calls; keep Promptfoo's database private as well.
test('native Promptfoo grading does not retry transport failures', {
  skip: !process.env.PROMPTFOO_EVAL_INTEGRATION, timeout: 120000,
}, async (t) => {
  const directory = await fs.mkdtemp('/tmp/opencode/promptfoo-grading-test-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the request without logging credentials */ }
    requests++;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Local test service unavailable' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const output = path.join(directory, 'config.json');
  const { config } = await generate({ scenarios: select(await load()).slice(0, 1), arm: 'with-skills', output });
  config.providers = ['echo'];
  config.prompts = ['Local test output'];
  config.defaultTest.options.provider.config.apiBaseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  config.tests = [{ assert: [{ type: 'llm-rubric', value: 'The output is correct.' }] }];
  await fs.writeFile(output, JSON.stringify(config));
  const results = path.join(directory, 'results.json');
  const log = await fs.open(path.join(directory, 'promptfoo.log'), 'w');
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const child = spawn('npx', ['--yes', 'promptfoo@0.125.1', 'eval', '--config', output,
        '--no-cache', '--output', results], {
        stdio: ['ignore', log.fd, log.fd], env: { ...process.env,
          LITELLM_API_KEY: 'loopback-test-only', PROMPTFOO_CONFIG_DIR: path.join(directory, 'state'),
          PROMPTFOO_DISABLE_TELEMETRY: '1' },
      });
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally { await log.close(); }
  assert.notEqual(code, 0, 'a grader transport error must not pass');
  assert.equal(requests, 1, 'maxRetries: 0 must reach the native grading HTTP client');
  const native = JSON.parse(await fs.readFile(results));
  const [result] = native.results.results;
  assert.equal(result.success, false);
  const [grade] = result.gradingResult.componentResults;
  assert.match(grade.reason, /503/);
});
