const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { load, select, projectRoot, safePath } = require('../../shared/scenarios.cjs');
const { digest, writeJson } = require('./generate.cjs');

async function launch(args, { stdoutFile, stderrFile } = {}) {
  const output = stdoutFile ? await fs.open(stdoutFile, 'wx') : undefined;
  let diagnostics;
  try { diagnostics = stderrFile ? await fs.open(stderrFile, 'wx') : undefined; }
  catch (error) { await output?.close(); throw error; }
  const child = spawn('tessl', args, { cwd: projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '';
  let persisted = Promise.resolve();
  const save = (handle, data) => {
    if (handle) { persisted = persisted.then(() => handle.write(data)); persisted.catch(() => {}); }
  };
  child.stdout.on('data', (data) => { stdout += data; save(output, data); });
  child.stderr.on('data', (data) => { stderr += data; process.stderr.write(data); save(diagnostics, data); });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    await persisted;
    return { code, stdout, stderr };
  } finally { await output?.close(); await diagnostics?.close(); }
}

async function plan(options, env = process.env) {
  const manifest = JSON.parse(await fs.readFile(path.join(options.output, 'manifest.json')));
  const selected = select(await load(), options.selector);
  if (manifest.schemaVersion !== 1 || manifest.provider !== 'tessl' || manifest.arm !== options.arm ||
      JSON.stringify(manifest.scenarios) !== JSON.stringify(selected)) {
    throw new Error('Tessl generation is stale or selections differ; run make generate-eval with the same options');
  }
  const arms = options.arm === 'both' ? ['with-skills', 'without-skills'] : [options.arm];
  if (JSON.stringify(manifest.variants.map((item) => item.label)) !== JSON.stringify(arms)) throw new Error('Tessl variant mismatch');
  for (const [name, hash] of Object.entries(manifest.artifacts)) {
    if (!safePath(name) || digest(await fs.readFile(path.join(manifest.generation, name))) !== hash) {
      throw new Error(`Generated Tessl input changed: ${name}; regenerate before running`);
    }
  }
  const max = env.TESSL_MAX_SOLVES ?? '1';
  if (!/^[1-9]\d*$/.test(max) || !Number.isSafeInteger(Number(max))) throw new Error('Invalid TESSL_MAX_SOLVES');
  const solves = selected.length * arms.length * options.runs;
  if (!Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > 10 || solves > Math.min(2000, Number(max))) {
    throw new Error(`Tessl would submit ${solves} solves (${selected.length} scenarios × ${arms.length} arms × ${options.runs} repeats); ` +
      `TESSL_MAX_SOLVES=${max}. Set an explicit solve budget before spending shared credits`);
  }
  return { manifest, solves };
}

function args(manifest, runs) {
  return ['eval', 'run', manifest.source, '--context', manifest.context,
    '--variant-json', path.join(manifest.generation, 'variants.json'), '--runs', String(runs),
    '--env-file', path.join(manifest.generation, 'runtime.env'),
    '--scorer-agent', manifest.config.scorerAgent, '--scorer-model', manifest.config.scorerModel,
    ...(manifest.config.skipForcedContextActivation ? ['--skip-forced-context-activation'] : []),
    '--wait', '--json', '--label', `sling-${manifest.fingerprint.slice(0, 12)}`];
}

function completed(result) {
  const statuses = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.status === 'string') statuses.push(value.status.toLowerCase());
    for (const item of Object.values(value)) if (typeof item === 'object') visit(item);
  };
  visit(result);
  return statuses.length > 0 && statuses.every((status) => ['completed', 'succeeded', 'success'].includes(status));
}

const setupFailed = (result) => (Array.isArray(result) ? result : [result]).some((run) =>
  run?.failure?.kind === 'SETUP_FAILED' || run?.failure?.reasons?.some((reason) => reason.kind === 'SETUP_FAILED'));

async function run(options, { invoke = launch, prepare = require('./prepare.cjs').prepare,
  verifyContext = require('./prepare.cjs').verifyPackedContext,
  collect = require('./collect.cjs').collect, env = process.env } = {}) {
  const blockFile = path.join(options.output, 'remote-setup-block.json');
  try {
    const block = JSON.parse(await fs.readFile(blockFile));
    if (block.state !== 'resolved' && env.TESSL_RESUME_AFTER_SETUP_REVIEW !== '1') {
      throw new Error(`Tessl submissions are blocked after remote setup failure: ${blockFile}. ` +
        `No new credits will be spent. Investigate run ${block.evalRunIds?.join(', ') ?? 'recorded in that file'} before explicitly authorizing another batch`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { manifest, solves } = await plan(options, env);
  const ledgerDir = path.join(options.output, 'submissions');
  const ledger = path.join(ledgerDir, `${manifest.fingerprint}-${options.runs}.json`);
  try { await fs.access(ledger); throw new Error(`This exact Tessl batch was already attempted: ${ledger}. View it; do not resubmit on timeout or error`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lint = await invoke(['eval', 'lint', manifest.source]);
  if (lint.code !== 0) throw new Error(`Tessl lint failed: ${lint.stdout}\n${lint.stderr}`);
  const packed = await invoke(['plugin', 'pack', manifest.context, '--output', path.join(manifest.generation, 'context-preflight.tgz')]);
  if (packed.code !== 0) throw new Error(`Tessl local context packaging failed: ${packed.stdout}\n${packed.stderr}`);
  await verifyContext(manifest);
  await prepare(manifest); // Clones, bundles and rehearses locally; still no paid call.
  const diagnosis = await invoke(['project', 'repair', '--json']);
  if (diagnosis.code !== 0 || JSON.parse(diagnosis.stdout).status !== 'match') {
    throw new Error('Tessl project link is not a match; inspect tessl project repair. No automatic remote repair was attempted');
  }
  const version = await invoke(['--version']);
  if (version.code !== 0) throw new Error('Cannot identify the Tessl CLI version');
  await fs.mkdir(ledgerDir, { recursive: true });
  const record = { state: 'submission-in-progress', created: new Date().toISOString(), solves,
    runs: options.runs, scenarioIds: manifest.scenarios.map((scenario) => scenario.id),
    variants: manifest.variants, cliVersion: version.stdout.trim(), fingerprint: manifest.fingerprint,
    generation: manifest.generation, args: args(manifest, options.runs) };
  // An exclusive, durable marker precedes the only credit-consuming call. A
  // crash/detach/timeout must never cause an automatic duplicate submission.
  const handle = await fs.open(ledger, 'wx');
  try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  const results = env.EVAL_RESULTS ?? path.join(manifest.generation, 'result.json');
  console.log(`Submitting exactly ${solves} Tessl solve(s); no automatic retries. Record: ${ledger}`);
  try {
    // Persist output while waiting as well as the final response, so a detached
    // client does not lose all diagnostics. The server may continue spending.
    const result = await invoke(record.args, { stdoutFile: results,
      stderrFile: path.join(manifest.generation, 'run.stderr.log') });
    await fs.writeFile(results, result.stdout);
    await fs.writeFile(path.join(manifest.generation, 'run.stderr.log'), result.stderr);
    let response;
    try { response = JSON.parse(result.stdout); } catch { /* Retain raw output for diagnosis; never retry. */ }
    const pass = result.code === 0 && completed(response);
    await writeJson(ledger, { ...record, state: pass ? 'completed' : 'inspect-before-any-rerun',
      exitCode: result.code, results, response });
    if (setupFailed(response)) await writeJson(blockFile, { reason: 'SETUP_FAILED before agent execution',
      evalRunIds: (Array.isArray(response) ? response : [response]).map((run) => run.evalRunId).filter(Boolean),
      ledger, results, created: new Date().toISOString() });
    console.log(`Native Tessl response saved to ${results}. This is judge scoring, not executable verification.`);
    if (pass) {
      // Fetching results and downloading solutions are read-only operations.
      // They do not submit another solve or judge. Native scores stay separate
      // from independent rebuilding through the shared executable checks.
      try {
        const report = await collect({ ...manifest, runs: options.runs }, response, { invoke });
        await writeJson(ledger, { ...record, state: 'completed', exitCode: result.code, results, response,
          verificationReport: path.join(manifest.generation, 'verification-report.json'), pass: report.pass, credits: report.credits });
        try {
          const block = JSON.parse(await fs.readFile(blockFile));
          await writeJson(blockFile, { ...block, state: 'resolved', resolvedBy: response, resolved: new Date().toISOString() });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return report.pass ? 0 : 1;
      } catch (error) {
        await writeJson(ledger, { ...record, state: 'postprocessing-failed', results, response, error: error.message });
        console.error(`Native run completed, but local result collection failed: ${error.message}. Do not resubmit; collection is read-only.`);
        return 1;
      }
    }
    return pass ? 0 : 1;
  } catch (error) {
    await writeJson(ledger, { ...record, state: 'submission-outcome-unknown', error: error.message });
    throw error;
  }
}

async function view() {
  const result = await launch(['eval', 'view', ...(process.env.TESSL_RUN_ID ? [process.env.TESSL_RUN_ID] : ['--last']), '--json']);
  process.stdout.write(result.stdout);
  return result.code;
}

module.exports = { run, view, plan, args, completed, launch, setupFailed };
