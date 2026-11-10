const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepare, result } = require('./workspace.cjs');
const { boundaryVersion } = require('./file-boundary.cjs');

const exec = promisify(execFile);
const providerId = 'apache-evals';

function compactionSettings(config) {
  const contextWindow = config.contextWindow;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error('contextWindow must be an explicit positive integer matching the selected model');
  }
  const maxTokens = config.maxTokens ?? 8192;
  const settings = { enabled: true, reserveTokens: maxTokens + 8192, keepRecentTokens: 20000,
    ...config.piCompaction };
  if (typeof settings.enabled !== 'boolean') throw new Error('piCompaction.enabled must be a boolean');
  if (settings.enabled && (!Number.isSafeInteger(settings.reserveTokens) ||
      settings.reserveTokens < maxTokens + 4096 || settings.reserveTokens >= contextWindow ||
      !Number.isSafeInteger(settings.keepRecentTokens) || settings.keepRecentTokens < 0 ||
      settings.keepRecentTokens >= contextWindow - settings.reserveTokens)) {
    throw new Error('piCompaction must reserve at least maxTokens + 4096 tokens, less than contextWindow, and keepRecentTokens must fit below the compaction threshold');
  }
  return settings;
}

async function configure(state) {
  const { config, runDir } = state;
  const compaction = compactionSettings(config);
  const agentDir = path.join(runDir, 'pi-agent');
  await fs.mkdir(agentDir, { mode: 0o700 });
  const model = {
    // Metadata alone does not disable server-side thinking; chatTemplateKwargs does.
    id: config.model, reasoning: false, input: ['text'],
    contextWindow: config.contextWindow, maxTokens: config.maxTokens ?? 8192,
    samplingParams: { temperature: config.temperature ?? 0,
      ...(config.chatTemplateKwargs ? { chat_template_kwargs: config.chatTemplateKwargs } : {}) },
  };
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {
    [providerId]: {
      baseUrl: config.apiBaseUrl, api: 'openai-completions', apiKey: '$LITELLM_API_KEY',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false,
        supportsStore: false, maxTokensField: 'max_tokens' },
      models: [model],
    },
  } }, null, 2));
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: providerId, defaultModel: config.model, defaultThinkingLevel: 'off',
    compaction, retry: { enabled: false }, cacheWarming: 'off',
    enableInstallTelemetry: false, enableAnalytics: false,
  }, null, 2));
  await fs.writeFile(path.join(agentDir, 'eval.json'), JSON.stringify({
    maxTurns: config.maxTurns ?? 80, maxTextOnlyTurns: config.maxTextOnlyTurns ?? 3,
    maxToolRepeats: config.maxToolRepeats ?? 3,
    commandTimeoutMs: config.mavenTimeoutMs ?? 1200000,
    fileBoundary: state.fileBoundary = { version: boundaryVersion, projectRoot: state.workingDir,
      skillRoots: state.skills.map(skill => skill.directory) },
  }));
  return agentDir;
}

function instructions() {
  return [
    'You are editing a real Maven project. Make the requested changes on disk, not just suggestions.',
    'Read files before editing. Start by reading pom.xml to identify the actual parent coordinates; do not guess.',
    'Use bash with curl or another installed HTTP client for current public reference material.',
    'For Maven Central metadata use https://repo.maven.apache.org/maven2/<groupId with dots replaced by slashes>/<artifactId>/maven-metadata.xml, using coordinates read from the POM.',
    'Use bash to inspect the Java/Maven environment and validate changes. Preserve the current Java environment.',
    'Do not publish, release, stage, commit, push, disable checks, skip tests, or make unrelated changes.',
    'Load relevant skill instructions with read on the entire SKILL.md (no offset or limit), not bash, so skill use can be audited. Read supporting references as needed.',
    'Native file tools are confined to the project and explicitly advertised copied skills; copied skills and Git metadata are read-only. Do not search for host skills or use bash to circumvent these boundaries.',
    'Plain text is progress narration, NOT completion. Keep using tools until finished or genuinely blocked.',
    'End by calling finish_task ALONE, with status completed or blocked and an honest summary. Never promise future actions in a completion summary.',
  ].join('\n');
}

// Let Pi handle SIGTERM first: its native shell tools run in separate process groups,
// and Pi knows which of those groups need killing. Escalate if Pi itself hangs.
async function invoke(command, args, state, agentDir, signal) {
  const stdout = await fs.open(path.join(state.runDir, 'pi-events.jsonl'), 'w');
  const stderr = await fs.open(path.join(state.runDir, 'pi-stderr.log'), 'w');
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: state.workingDir, detached: true, stdio: ['ignore', stdout.fd, stderr.fd],
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            !key.startsWith('GIT_') && !key.startsWith('PI_'))),
          PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0',
        },
      });
      let timedOut = false;
      let escalation;
      const stop = () => {
        if (!child.pid || escalation) return;
        try { child.kill('SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        escalation = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }, 3000);
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, state.config.piTimeoutMs ?? 3600000);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(escalation);
        signal?.removeEventListener('abort', stop);
      };
      child.once('error', (error) => { cleanup(); reject(error); });
      child.once('close', (code, killedBy) => {
        cleanup();
        resolve({ code, signal: killedBy, timedOut });
      });
    });
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

// Split only on LF: readline also splits Unicode separators that are legal in JSON strings.
async function* events(file) {
  let pending = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      if (line) yield JSON.parse(line);
    }
    if (pending.length > 32 * 1024 * 1024) throw new Error('Pi JSONL record exceeds 32 MiB');
  }
  if (pending.trim()) yield JSON.parse(pending);
}

async function collect(state, tokenUsage) {
  const toolCalls = [];
  const skillCalls = [];
  const pending = new Map();
  let turns = 0;
  let settled = false;
  let aborted = false;
  let failure;
  let modelFailure;
  let recoveryPending = false;
  let recoveringCall;
  let abortTail = false;
  const diagnostics = state.diagnostics = { requests: [], modelCalls: [], compactions: [], fileBoundaryDenials: [] };
  const addUsage = (usage = {}) => {
    tokenUsage.prompt += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    tokenUsage.completion += usage.output ?? 0;
    tokenUsage.total += usage.totalTokens ?? 0;
    // Reasoning is already part of output; retain the breakdown without adding it twice.
    tokenUsage.completionDetails.reasoning += usage.reasoning ?? 0;
  };
  for await (const event of events(path.join(state.runDir, 'pi-events.jsonl'))) {
    if (event.type === 'entry_appended' && event.entry?.type === 'custom') {
      if (event.entry.customType === 'eval-controls') diagnostics.controls = event.entry.data;
      if (event.entry.customType === 'eval-file-boundary') diagnostics.fileBoundaryDenials.push(event.entry.data);
      if (event.entry.customType === 'eval-file-access') {
        const record = pending.get(event.entry.data?.toolCallId);
        if (record) record.resolvedPath = event.entry.data.path;
      }
    }
    if (event.type === 'entry_appended' && event.entry?.type === 'custom' && event.entry.customType === 'eval-request') {
      diagnostics.requests.push(event.entry.data);
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      // Pi 1.4 may emit an empty, already-aborted next turn after ctx.abort() at
      // turn_end. It is not a request or model failure. Never mask other errors.
      if (state.completion && ['error', 'aborted'].includes(message.stopReason) &&
          !message.content?.length && message.usage?.totalTokens === 0 && /abort/i.test(message.errorMessage ?? message.stopReason)) {
        abortTail = true;
        continue;
      }
      turns++;
      addUsage(message.usage);
      const call = { turn: turns, stopReason: message.stopReason, usage: message.usage,
        request: diagnostics.requests.at(-1) };
      diagnostics.modelCalls.push(call);
      if (['error', 'length', 'aborted'].includes(message.stopReason)) {
        const request = call.request;
        const budget = request ? `; effective max_tokens=${request.maxTokens}, context=${request.contextTokens ?? 'unknown'}/${request.contextWindow ?? state.config.contextWindow}` : '';
        const explanation = message.stopReason === 'length' ?
          (request?.maxTokens === 1 ? 'context/output budget exhausted' : 'output-token limit reached') :
          message.errorMessage ?? 'no complete response';
        modelFailure = `Pi model ${message.stopReason} at turn ${turns}: ${explanation}; input=${message.usage?.input ?? 0}, output=${message.usage?.output ?? 0}, reasoning=${message.usage?.reasoning ?? 0}; configured maxTokens=${state.config.maxTokens ?? 8192}${budget}`;
        call.error = modelFailure;
      } else if (recoveryPending) {
        // Pi may compact and retry a context-clamped response. Keep the failed
        // attempt and its usage in the audit, but do not fail a recovered run.
        modelFailure = undefined;
        if (recoveringCall) recoveringCall.recovered = true;
        recoveryPending = false;
      }
    }
    if (event.type === 'tool_execution_start') {
      pending.set(event.toolCallId, { index: toolCalls.length, turn: turns - 1,
        name: event.toolName, input: event.args, toolCallId: event.toolCallId });
    }
    if (event.type === 'tool_execution_end') {
      const record = pending.get(event.toolCallId);
      if (!record) throw new Error(`Pi returned an unmatched tool result: ${event.toolCallId}`);
      pending.delete(event.toolCallId);
      Object.assign(record, { index: toolCalls.length, output: event.result,
        is_error: Boolean(event.isError), durationMs: event.durationMs });
      toolCalls.push(record);
      if (record.name === 'read' && typeof record.input?.path === 'string') {
        const file = record.resolvedPath ?? path.resolve(state.workingDir, record.input.path);
        const skill = state.skills.find((item) => file === path.join(item.directory, 'SKILL.md'));
        if (skill && (record.input.offset ?? 1) === 1 && record.input.limit === undefined) {
          skillCalls.push({ name: skill.name, is_error: record.is_error });
        } else if (!skill && path.basename(file) === 'SKILL.md') {
          // Ambient discovery is disabled, but native tools are not a filesystem
          // sandbox. A host skill read is exposure even when it is only partial;
          // never silently count it as a clean no-skills baseline or as the
          // explicitly installed skill required by the skills arm.
          skillCalls.push({ name: path.basename(path.dirname(file)), is_error: record.is_error,
            installed: false, path: file, offset: record.input.offset, limit: record.input.limit });
        }
      }
    }
    if (event.type === 'entry_appended' && event.entry?.type === 'custom' && event.entry.customType === 'eval-completion') {
      const completion = event.entry.data;
      if (!['completed', 'blocked', 'incomplete'].includes(completion?.status) ||
          typeof completion.summary !== 'string' || !completion.summary.trim()) {
        throw new Error('Pi emitted invalid completion metadata');
      }
      state.completion = completion;
    }
    if (event.type === 'agent_settled') {
      settled = true;
      aborted = Boolean(event.aborted);
    }
    if (event.type === 'compaction_end') {
      diagnostics.compactions.push({ reason: event.reason, aborted: event.aborted,
        willRetry: event.willRetry, error: event.errorMessage,
        tokensBefore: event.result?.tokensBefore, estimatedTokensAfter: event.result?.estimatedTokensAfter,
        usage: event.result?.usage });
      addUsage(event.result?.usage);
      if (event.result && !event.aborted && event.willRetry) {
        recoveryPending = true;
        recoveringCall = diagnostics.modelCalls.at(-1);
      }
    }
    if (event.type === 'extension_error') failure = `Pi extension error: ${event.error}`;
  }
  if (abortTail && !aborted) failure = 'Pi emitted a cancellation tail without an aborted settlement';
  return { toolCalls, skillCalls, turns, settled, aborted, failure: failure ?? modelFailure };
}

module.exports = class PiProvider {
  constructor(options) {
    this.config = options.config;
  }

  id() {
    return `sling-parent:pi:${this.config.model}:${this.config.install_skills ? 'with' : 'without'}-skills`;
  }

  async callApi(prompt, context, options = {}) {
    let state;
    const tokenUsage = { prompt: 0, completion: 0, total: 0, completionDetails: { reasoning: 0 } };
    try {
      options.abortSignal?.throwIfAborted();
      const scenario = context?.vars?.scenario;
      state = await prepare(scenario ? { ...this.config, scenario,
        mavenTimeoutMs: scenario.environment.command_timeout_seconds * 1000 } : this.config);
      if (!process.env.LITELLM_API_KEY) throw new Error('LITELLM_API_KEY is not set');
      const command = this.config.piCommand ?? 'pi';
      const { stdout: version } = await exec(command, ['--version'], { timeout: 10000, signal: options.abortSignal });
      const agentDir = await configure(state);
      const args = [
        '--mode', 'json', '--no-session', '--offline', '--no-extensions', '--no-mcp',
        '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve', '--no-skills',
        '--provider', providerId, '--model', this.config.model, '--thinking', 'off',
        '--tools', 'read,bash,edit,write,grep,find,ls,finish_task',
        '--extension', path.join(__dirname, 'pi-eval.ts'), '--append-system-prompt', instructions(),
      ];
      if (state.skills.length) args.push('--skill', path.join(state.runDir, 'skills'));
      args.push('--', prompt);
      const processResult = await invoke(command, args, state, agentDir, options.abortSignal);
      const collected = await collect(state, tokenUsage);
      await fs.writeFile(path.join(state.runDir, 'diagnostics.json'), JSON.stringify(state.diagnostics, null, 2));
      await fs.writeFile(path.join(state.runDir, 'tool-calls.json'), JSON.stringify(collected.toolCalls, null, 2));
      options.abortSignal?.throwIfAborted();
      const { failure, settled, aborted, ...records } = collected;
      if (processResult.timedOut) {
        state.completion = { status: 'incomplete', summary: 'Pi exceeded the evaluation wall-clock timeout.' };
      } else {
        if (failure) throw new Error(failure);
        if (processResult.code !== 0) throw new Error(`Pi exited ${processResult.code} (${processResult.signal ?? 'no signal'}); see pi-stderr.log`);
        if (!settled) throw new Error('Pi exited without agent_settled');
        if (aborted && !state.completion) throw new Error('Pi was aborted without an evaluation completion');
      }
      state.completion ??= { status: 'incomplete', summary: 'Pi stopped without calling finish_task.' };
      return await result(state, { ...records, tokenUsage, harness: 'pi', piVersion: version.trim(),
        model: this.config.model, apiBaseUrl: this.config.apiBaseUrl,
        temperature: this.config.temperature ?? 0, maxTokens: this.config.maxTokens ?? 8192,
        contextWindow: this.config.contextWindow, chatTemplateKwargs: this.config.chatTemplateKwargs,
        piCompaction: compactionSettings(this.config), diagnostics: state.diagnostics,
        harnessControls: { nativeFileBoundary: state.fileBoundary } });
    } catch (error) {
      const message = `${error.message}${state?.runDir ? `; artifacts: ${state.runDir}` : ''}`;
      if (state?.runDir) {
        // Preserve the original failure even if persisting additional diagnostics fails.
        await fs.writeFile(path.join(state.runDir, 'error.json'), JSON.stringify({
          error: message, repository: state.repository, tokenUsage, diagnostics: state.diagnostics,
        }, null, 2)).catch(() => {});
      }
      return { error: message, cached: false, tokenUsage,
        metadata: { runDir: state?.runDir, repository: state?.repository,
          baselineCommit: state?.baselineCommit, diagnostics: state?.diagnostics,
          harnessControls: { nativeFileBoundary: state?.fileBoundary } } };
    }
  }
};

module.exports.events = events;
