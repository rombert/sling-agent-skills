const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
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
      await fs.access(path.join(directory, 'SKILL.md'));
      skills.push({ name: entry.name, directory });
    }
  }
  const initialParent = await readParent(path.join(workingDir, 'pom.xml'));
  return { runDir, workingDir, baselineCommit, initialParent, skills, config };
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

async function result(state, { toolCalls, skillCalls, tokenUsage, turns, ...metadata }) {
  const workspaceDiff = await diff(state.workingDir, state.baselineCommit);
  await fs.writeFile(path.join(state.runDir, 'changes.patch'), workspaceDiff);
  await fs.writeFile(path.join(state.runDir, 'summary.txt'), state.completion.summary);
  await fs.writeFile(path.join(state.runDir, 'completion.json'), JSON.stringify(state.completion, null, 2));
  await fs.writeFile(path.join(state.runDir, 'tool-calls.json'), JSON.stringify(toolCalls, null, 2));
  let finalParent;
  try { finalParent = await readParent(path.join(state.workingDir, 'pom.xml')); }
  catch (error) { finalParent = { error: error.message }; }
  return {
    output: JSON.stringify({ ...state.completion, initialParent: state.initialParent, finalParent,
      loadedSkills: skillCalls.filter((call) => !call.is_error).map((call) => call.name),
      diff: shorten(workspaceDiff, 60000), sources: graderSources(toolCalls) }),
    cached: false,
    tokenUsage,
    metadata: {
      workingDir: state.workingDir, runDir: state.runDir,
      baselineCommit: state.baselineCommit, workspaceDiff,
      initialParent: state.initialParent, completion: state.completion, turns,
      skillsInstalled: Boolean(state.config.install_skills),
      skillCalls, toolCalls, mavenTimeoutMs: state.config.mavenTimeoutMs,
      ...metadata,
    },
  };
}

module.exports = { prepare, result };
