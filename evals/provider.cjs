const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { definitions, executeTool, listFiles, readText } = require('./tools.cjs');
const { readParent } = require('./parent-upgrade.cjs');

const exec = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');

async function git(cwd, args) {
  const { stdout } = await exec('git', args, {
    cwd, maxBuffer: 20 * 1024 * 1024,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  });
  return stdout;
}

async function prepare(config) {
  const source = await fs.realpath(path.resolve(projectRoot, config.working_dir));
  if ((await git(source, ['rev-parse', '--show-toplevel'])).trim() !== source) {
    throw new Error('working_dir must be the root of a Git repository');
  }
  if ((await git(source, ['status', '--porcelain', '--untracked-files=normal'])).trim()) {
    throw new Error('The source repository must be clean; commit or move local changes before evaluating');
  }
  const baselineCommit = (await git(source, ['rev-parse', 'HEAD'])).trim();
  const tempRoot = process.env.PROMPTFOO_WORKSPACE_ROOT || path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(tempRoot, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(tempRoot, 'sling-skill-eval-'));
  const workingDir = path.join(runDir, 'project');
  await git(source, ['clone', '--quiet', '--no-local', '--no-hardlinks', source, workingDir]);
  await git(workingDir, ['checkout', '--quiet', '--detach', baselineCommit]);
  await git(workingDir, ['remote', 'remove', 'origin']);
  const skills = [];
  if (config.install_skills) {
    const installed = path.join(runDir, 'skills');
    await fs.cp(path.resolve(projectRoot, config.skills_dir), installed, { recursive: true });
    for (const entry of await fs.readdir(installed, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(installed, entry.name);
      const { text } = await readText(path.join(directory, 'SKILL.md'));
      skills.push({
        name: entry.name,
        description: text.match(/^description:\s*(.+)$/m)?.[1] ?? entry.name,
        directory,
      });
    }
  }
  const initialParent = await readParent(path.join(workingDir, 'pom.xml'));
  return { runDir, workingDir, baselineCommit, initialParent, skills, config, mavenCalls: 0 };
}

async function diff(workingDir, baselineCommit) {
  let patch = await git(workingDir, ['diff', '--no-ext-diff', baselineCommit, '--', '.']);
  for (const file of (await git(workingDir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) {
    try {
      patch += await git(workingDir, ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', file]);
    } catch (error) {
      if (error.code !== 1) throw error; // git diff exits 1 when files differ.
      patch += error.stdout;
    }
  }
  return patch;
}

function shorten(text, limit) {
  if (text.length <= limit) return text;
  const tail = Math.min(300, Math.floor(limit / 4));
  return `${text.slice(0, limit - tail)}\n[truncated; full result retained in run artifacts]\n${text.slice(-tail)}`;
}

function toolKey(name, args) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return `${name}:${JSON.stringify(canonical(args))}`;
}

function compactHistory(history, turn, recentTurns) {
  for (const item of history) {
    // Keep loaded skill instructions, but stop resending old file/HTTP/build dumps.
    if (item.archived || item.record.name === 'read_skill' || turn - item.record.turn < recentTurns) continue;
    const { record, message } = item;
    message.content = JSON.stringify({
      archived: true, tool: record.name, input: shorten(JSON.stringify(record.input), 400), is_error: Boolean(record.is_error),
      code: record.output?.code, log: record.output?.log,
      excerpt: shorten(JSON.stringify(record.output), 600),
      note: `Full result is tool-calls.json entry ${record.index}. Read the file or fetch the URL again if needed.`,
    });
    item.archived = true;
  }
}

function graderSources(toolCalls) {
  const byUrl = new Map(toolCalls.filter((call) => call.name === 'fetch_url').map((call) => [call.input?.url, call]));
  let remaining = 16000;
  return [...byUrl.values()].map((call) => {
    const text = JSON.stringify(call.output);
    const output = shorten(text, Math.max(100, Math.min(4000, remaining)));
    remaining = Math.max(0, remaining - output.length);
    return { url: call.input?.url, is_error: Boolean(call.is_error), output };
  }).filter((_call, index) => index < 12);
}

module.exports = class CodingProvider {
  constructor(options) {
    this.config = options.config;
  }

  id() {
    return `sling-parent:${this.config.model}:${this.config.install_skills ? 'with' : 'without'}-skills`;
  }

  async callApi(prompt, _context, options = {}) {
    if (!process.env.LITELLM_API_KEY) return { error: 'LITELLM_API_KEY is not set' };
    let state;
    const toolCalls = [];
    const skillCalls = [];
    const tokenUsage = { prompt: 0, completion: 0, total: 0 };
    try {
      state = await prepare(this.config);
      state.signal = options.abortSignal;
      const catalog = state.skills.map(({ name, description }) => ({ name, description }));
      const messages = [
        { role: 'system', content: [
          'You are editing a real Maven project using the supplied tools.',
          'Make the requested changes on disk, not just suggestions or a patch in your answer.',
          'Paths are relative to the project. Read files before editing them.',
          'Start by reading pom.xml to identify the actual parent coordinates; do not guess artifact names or versions.',
          'Use fetch_url for current public reference material. Use run_maven to inspect the Java/Maven environment and validate your changes.',
          'For Maven Central metadata use https://repo.maven.apache.org/maven2/<groupId with dots replaced by slashes>/<artifactId>/maven-metadata.xml, using coordinates read from the POM.',
          'Do not publish, release, commit, disable checks, skip tests, or make unrelated changes.',
          'Plain text is progress narration, NOT task completion. Keep using tools until finished or genuinely blocked.',
          'End by calling finish_task ALONE, with status completed or blocked and an honest summary. Never promise future actions in a completion summary.',
          'Skills are instruction documents, NOT functions. Load a relevant skill with read_skill({"name":"<catalog name>"}), then read_skill_file for its references.',
          `Installed skill catalog (names/descriptions only): ${JSON.stringify(catalog)}`,
          `Initial project files: ${JSON.stringify(await listFiles(state.workingDir))}`,
        ].join('\n') },
        { role: 'user', content: prompt },
      ];
      const history = [];
      const fetchCache = new Map();
      const repeats = new Map();
      let textOnlyTurns = 0;
      let turns = 0;
      for (let turn = 0; turn < (this.config.maxTurns ?? 80); turn++) {
        turns = turn + 1;
        compactHistory(history, turn, this.config.recentToolTurns ?? 4);
        const response = await fetch(`${this.config.apiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.LITELLM_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.config.model, messages, tools: definitions, temperature: 0 }),
          signal: AbortSignal.any([AbortSignal.timeout(300000), ...(options.abortSignal ? [options.abortSignal] : [])]),
        });
        if (!response.ok) throw new Error(`LiteLLM HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
        const data = await response.json();
        await fs.appendFile(path.join(state.runDir, 'model-responses.jsonl'), `${JSON.stringify({ turn, response: data })}\n`);
        tokenUsage.prompt += data.usage?.prompt_tokens ?? 0;
        tokenUsage.completion += data.usage?.completion_tokens ?? 0;
        tokenUsage.total += data.usage?.total_tokens ?? 0;
        const choice = data.choices?.[0];
        const message = choice?.message;
        if (!message) throw new Error(`LiteLLM returned no message: ${JSON.stringify(data).slice(0, 2000)}`);
        if (choice.finish_reason === 'length') throw new Error('Model response was truncated');
        if (!message.tool_calls?.length) {
          if (!message.content) throw new Error('Model returned neither text nor tool calls');
          messages.push({ role: 'assistant', content: shorten(message.content, 2000) });
          if (++textOnlyTurns >= (this.config.maxTextOnlyTurns ?? 3)) {
            state.completion = { status: 'incomplete', summary: 'Stopped after repeated text-only responses without finish_task.' };
            break;
          }
          messages.push({ role: 'user', content: 'That was progress narration, not completion. Perform the next action with a supplied tool, or call finish_task with status completed or blocked and a truthful summary. Skill names are documents loaded through read_skill, not callable tools.' });
          continue;
        }
        textOnlyTurns = 0;
        messages.push({ role: 'assistant', content: message.content ? shorten(message.content, 2000) : null, tool_calls: message.tool_calls });
        let stalled;
        for (const call of message.tool_calls) {
          const record = { index: toolCalls.length, turn, name: call.function.name, input: call.function.arguments };
          try {
            record.input = JSON.parse(call.function.arguments);
            if (!record.input || typeof record.input !== 'object' || Array.isArray(record.input)) throw new Error('Tool arguments must be a JSON object');
            const key = toolKey(record.name, record.input);
            const count = (repeats.get(key) ?? 0) + 1;
            repeats.set(key, count);
            if (count > (this.config.maxToolRepeats ?? 3)) {
              stalled = `Repeated ${record.name} with identical arguments without edits; stopping a stalled tool loop.`;
              throw new Error(stalled);
            }
            if (record.name === 'finish_task' && message.tool_calls.length !== 1) {
              throw new Error('Call finish_task alone, after all editing/verification tools have returned');
            }
            if (record.name === 'fetch_url' && fetchCache.has(key)) {
              Object.assign(record, fetchCache.get(key), { cached: true });
            } else {
              try {
                record.output = await executeTool(record.name, record.input, state);
              } catch (error) {
                if (options.abortSignal?.aborted) throw error;
                record.is_error = true;
                record.output = { error: error.message };
              }
              if (record.name === 'fetch_url') fetchCache.set(key, { output: record.output, is_error: record.is_error });
            }
            if (['replace_text', 'write_file'].includes(record.name) && !record.is_error) repeats.clear();
          } catch (error) {
            if (options.abortSignal?.aborted) throw error;
            record.is_error = true;
            record.output = { error: error.message };
          }
          toolCalls.push(record);
          if (record.name === 'read_skill') skillCalls.push({ name: record.input?.name, is_error: Boolean(record.is_error) });
          const toolMessage = { role: 'tool', tool_call_id: call.id,
            content: shorten(JSON.stringify(record.output), this.config.toolOutputChars ?? 8000) };
          messages.push(toolMessage);
          history.push({ message: toolMessage, record });
          await fs.writeFile(path.join(state.runDir, 'tool-calls.json'), JSON.stringify(toolCalls, null, 2));
        }
        if (stalled && !state.completion) state.completion = { status: 'incomplete', summary: stalled };
        if (state.completion) break;
      }
      state.completion ??= { status: 'incomplete', summary: `Model did not call finish_task within ${this.config.maxTurns ?? 80} turns.` };
      const { summary } = state.completion;
      const workspaceDiff = await diff(state.workingDir, state.baselineCommit);
      await fs.writeFile(path.join(state.runDir, 'changes.patch'), workspaceDiff);
      await fs.writeFile(path.join(state.runDir, 'summary.txt'), summary);
      await fs.writeFile(path.join(state.runDir, 'completion.json'), JSON.stringify(state.completion, null, 2));
      let finalParent;
      try { finalParent = await readParent(path.join(state.workingDir, 'pom.xml')); }
      catch (error) { finalParent = { error: error.message }; }
      return {
        // The grader sees actual edits and fetched sources, not just self-report.
        output: JSON.stringify({ ...state.completion, initialParent: state.initialParent, finalParent,
          loadedSkills: skillCalls.filter((call) => !call.is_error).map((call) => call.name),
          diff: shorten(workspaceDiff, 60000), sources: graderSources(toolCalls) }),
        cached: false,
        tokenUsage,
        metadata: {
          workingDir: state.workingDir, runDir: state.runDir,
          baselineCommit: state.baselineCommit, workspaceDiff,
          initialParent: state.initialParent, completion: state.completion, turns,
          skillsInstalled: Boolean(this.config.install_skills),
          skillCalls, toolCalls, mavenTimeoutMs: this.config.mavenTimeoutMs,
        },
      };
    } catch (error) {
      return { error: error.message, cached: false, tokenUsage, metadata: { runDir: state?.runDir } };
    }
  }
};

module.exports.prepare = prepare;
