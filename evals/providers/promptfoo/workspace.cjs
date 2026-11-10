const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readParent } = require('../../shared/parent-upgrade.cjs');
const { prepareFixture } = require('../../shared/fixture.cjs');
const { projectRoot } = require('../../shared/scenarios.cjs');
const { childEnvironment } = require('./environment.cjs');

const exec = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await exec('git', args, {
    cwd, maxBuffer: 20 * 1024 * 1024,
    env: childEnvironment(),
  });
  return stdout;
}

function isSubdirectory(root, directory) {
  const relative = path.relative(root, directory);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function prepare(config) {
  if (config.scenario) {
    if (process.env.PROMPTFOO_REPO !== undefined) throw new Error('PROMPTFOO_REPO cannot override a pinned scenario');
    const tempRoot = process.env.PROMPTFOO_WORKSPACE_ROOT || path.join(os.tmpdir(), 'opencode');
    await fs.mkdir(tempRoot, { recursive: true });
    const runDir = await fs.mkdtemp(path.join(tempRoot, 'sling-skill-eval-'));
    try {
      const fixture = await prepareFixture(config.scenario, runDir, { env: childEnvironment() });
      const skills = await installSkills(config, runDir);
      return { runDir, ...fixture, skills, config };
    } catch (error) {
      error.message += `; fixture artifacts: ${runDir}`;
      throw error;
    }
  }
  const requested = process.env.PROMPTFOO_REPO ?? config.working_dir;
  if (typeof requested !== 'string' || !requested.trim()) {
    throw new Error('working_dir or PROMPTFOO_REPO must name a repository subdirectory of repos');
  }
  const repos = path.join(projectRoot, 'repos');
  const requestedPath = path.resolve(projectRoot, requested);
  const boundaryError = 'Evaluation repository must be a strict subdirectory of repos (including resolved symlinks)';
  if (!isSubdirectory(repos, requestedPath)) throw new Error(boundaryError);
  const [reposRoot, source] = await Promise.all([fs.realpath(repos), fs.realpath(requestedPath)]);
  if (!isSubdirectory(reposRoot, source)) throw new Error(boundaryError);
  if ((await git(source, ['rev-parse', '--show-toplevel'])).trim() !== source) {
    throw new Error('working_dir must be the root of a Git repository');
  }
  const dirty = (await git(source, ['status', '--porcelain', '--untracked-files=normal'])).trim();
  if (dirty) {
    throw new Error(`The source repository must be clean; commit or move local changes before evaluating: ${source}\n${dirty}`);
  }
  const baselineCommit = (await git(source, ['rev-parse', 'HEAD'])).trim();
  let name = path.basename(source);
  if ((await git(source, ['remote'])).split('\n').includes('origin')) {
    const origin = (await git(source, ['remote', 'get-url', 'origin'])).trim();
    name = origin.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).at(-1).replace(/\.git$/, '') || name;
  }
  const repository = { name, revision: baselineCommit, directory: path.join('repos', path.relative(reposRoot, source)) };
  const tempRoot = process.env.PROMPTFOO_WORKSPACE_ROOT || path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(tempRoot, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(tempRoot, 'sling-skill-eval-'));
  await fs.writeFile(path.join(runDir, 'repository.json'), JSON.stringify(repository, null, 2));
  const workingDir = path.join(runDir, 'project');
  await git(source, ['clone', '--quiet', '--no-local', '--no-hardlinks', source, workingDir]);
  await git(workingDir, ['checkout', '--quiet', '--detach', baselineCommit]);
  await git(workingDir, ['remote', 'remove', 'origin']);
  const skills = await installSkills(config, runDir);
  const initialParent = await readParent(path.join(workingDir, 'pom.xml'));
  return { runDir, workingDir, baselineCommit, repository, initialParent, skills, config };
}

async function installSkills(config, runDir) {
  const skills = [];
  if (config.install_skills) {
    const installed = path.join(runDir, 'skills');
    await fs.cp(path.resolve(projectRoot, config.skills_dir), installed, { recursive: true });
    for (const entry of await fs.readdir(installed, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(installed, entry.name);
      await fs.access(path.join(directory, 'SKILL.md'));
      skills.push({ name: entry.name, directory });
    }
  }
  return skills;
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

function graderSources(toolCalls) {
  const sources = new Map();
  for (const call of toolCalls) {
    // Shell commands are evidence, not a claim that every URL in them was fetched.
    if (call.name === 'bash' && /https?:\/\/|\b(?:curl|wget)\b/.test(call.input?.command ?? '')) {
      sources.set(call.input.command, call);
    }
  }
  let remaining = 16000;
  return [...sources.values()].slice(0, 12).map((call) => {
    const output = shorten(JSON.stringify(call.output) ?? 'null', Math.max(100, Math.min(4000, remaining)));
    remaining = Math.max(0, remaining - output.length);
    return { command: call.input.command, is_error: Boolean(call.is_error), output };
  });
}

function graderCommandEvidence(toolCalls) {
  const candidates = new Map();
  for (const [toolIndex, call] of toolCalls.entries()) {
    if (call.name !== 'bash' || typeof call.input?.command !== 'string') continue;
    const command = call.input.command;
    // Priorities route untrusted COMMAND INPUT, never verdicts. In particular,
    // flags in fetched/echoed tool output must not manufacture a risky action.
    // A quoted/echoed mention in the command itself is still just evidence for
    // the judge to interpret, not proof that the mentioned action executed.
    const priority = /-D(?:skipTests|maven\.test\.skip|[\w.-]+\.skip)\b/.test(command) ? 4 :
      /\bgit\b/.test(command) && /\b(?:add|commit|push|reset|restore|clean)\b/.test(command) ? 3 :
      /\b(?:cp|rsync)\b|\bgit\s+(?:clone|worktree)\b/.test(command) ? 2 :
      /\b(?:mvn(?:w|\d+)?|maven)\b/.test(command) ? 1 : 0;
    if (priority) candidates.set(command, { toolIndex, call, priority }); // retain the latest repeated call
  }
  const selected = [...candidates.values()].sort((a, b) => b.priority - a.priority || b.toolIndex - a.toolIndex).slice(0, 8);
  const bounded = (text, limit) => {
    if (text.length <= limit) return text;
    const marker = '\n[truncated; full tool record retained]\n';
    if (limit <= marker.length) return text.slice(0, limit);
    const tail = Math.min(200, Math.floor((limit - marker.length) / 4));
    return text.slice(0, limit - marker.length - tail) + marker + text.slice(-tail);
  };
  let remaining = 16000;
  return {
    version: 'bounded-command-evidence-v1', untrusted: true,
    candidateCount: candidates.size, omittedCount: candidates.size - selected.length,
    // Fair shares reserve room for every selected late/risk-relevant record.
    // The limit counts command plus serialized tool-result characters, not tokens.
    textBudget: remaining,
    commands: selected.map(({ toolIndex, call }, index) => {
      const share = Math.floor(remaining / (selected.length - index));
      const command = bounded(call.input.command, Math.min(3000, Math.floor(share * 0.65)));
      const serialized = JSON.stringify(call.output) ?? 'null';
      const output = bounded(serialized, Math.min(1200, share - command.length));
      remaining -= command.length + output.length;
      return { toolIndex, command, is_error: Boolean(call.is_error), output,
        commandTruncated: command.length < call.input.command.length, outputTruncated: output.length < serialized.length };
    }),
  };
}

async function result(state, { toolCalls, skillCalls, tokenUsage, turns, ...metadata }) {
  const workspaceDiff = await diff(state.workingDir, state.baselineCommit);
  await fs.writeFile(path.join(state.runDir, 'changes.patch'), workspaceDiff);
  await fs.writeFile(path.join(state.runDir, 'summary.txt'), state.completion.summary);
  await fs.writeFile(path.join(state.runDir, 'completion.json'), JSON.stringify(state.completion, null, 2));
  await fs.writeFile(path.join(state.runDir, 'tool-calls.json'), JSON.stringify(toolCalls, null, 2));
  await fs.writeFile(path.join(state.runDir, 'repository.json'), JSON.stringify(state.repository, null, 2));
  let finalParent;
  try { finalParent = await readParent(path.join(state.workingDir, 'pom.xml')); }
  catch (error) { finalParent = { error: error.message }; }
  const gitActions = toolCalls.filter((call) => call.name === 'bash' && /\bgit\b/.test(call.input?.command ?? ''));
  return {
    output: JSON.stringify({ ...state.completion, repository: state.repository, initialParent: state.initialParent, finalParent,
      loadedSkills: skillCalls.filter((call) => !call.is_error).map((call) => call.name),
      diff: shorten(workspaceDiff, 60000), sources: graderSources(toolCalls),
      commandEvidence: graderCommandEvidence(toolCalls),
      // Give the native quality judge actual Git-action evidence, not merely an
      // agent's claim that it did not commit. The full transcript stays on disk.
      gitActions: { count: gitActions.length, truncated: gitActions.length > 20,
        commands: gitActions.slice(0, 20).map((call) => ({ command: shorten(call.input.command, 500), is_error: Boolean(call.is_error) })) } }),
    cached: false,
    tokenUsage,
    metadata: {
      workingDir: state.workingDir, runDir: state.runDir,
      baselineCommit: state.baselineCommit, repository: state.repository, workspaceDiff,
      initialParent: state.initialParent, completion: state.completion, turns,
      skillsInstalled: Boolean(state.config.install_skills),
      skillCalls, toolCalls, mavenTimeoutMs: state.config.mavenTimeoutMs,
      ...(state.scenario ? { scenario: state.scenario, environment: state.environment } : {}),
      ...metadata,
    },
  };
}

module.exports = { prepare, result, graderCommandEvidence };
