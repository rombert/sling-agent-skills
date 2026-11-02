const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAVEN_COMMANDS = ['mvn', 'mvn8', 'mvn11', 'mvn17', 'mvn21'];

// Persist full logs without buffering an entire Maven build in memory.
async function run(command, args, { cwd, log, timeoutMs = 1200000, signal } = {}) {
  const handle = await fs.open(log, 'w');
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: ['ignore', handle.fd, handle.fd],
        // Maven needs the normal Java/Maven environment, but not the model key.
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          key !== 'LITELLM_API_KEY' && !key.startsWith('GIT_'))),
      });
      let timedOut = false;
      const kill = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const abort = () => kill();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      child.once('error', (error) => { cleanup(); reject(error); });
      child.once('close', (code, killedBy) => {
        cleanup();
        resolve({ code, signal: killedBy, timedOut, log });
      });
    });
  } finally {
    await handle.close();
  }
}

async function tail(file, bytes = 12000) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, bytes));
    await handle.read(buffer, 0, buffer.length, Math.max(0, size - bytes));
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

// Resolve existing ancestors too, so symlinks cannot escape the workspace.
async function safePath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) {
    throw new Error('Use a path relative to the project or skill directory');
  }
  const target = path.resolve(root, relative);
  const inside = path.relative(root, target);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) ||
      inside.split(path.sep).includes('.git')) {
    throw new Error('Path is outside the allowed files');
  }
  let ancestor = root;
  for (const component of inside.split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, component);
    try {
      const stat = await fs.lstat(ancestor);
      if (!stat.isSymbolicLink()) continue;
      const real = await fs.realpath(ancestor);
      const rel = path.relative(root, real);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || rel.split(path.sep).includes('.git')) {
        throw new Error('Symlink points outside the allowed files');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling link is not a safe destination for a new file either.
      try {
        if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('Dangling symlink is not allowed');
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      break;
    }
  }
  return target;
}

async function listFiles(root, directory = '.', limit = 1000) {
  const files = [];
  async function visit(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) return;
      if (['.git', 'target', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files.push(path.relative(root, file));
    }
  }
  await visit(await safePath(root, directory));
  return files;
}

// Some older Sling POMs declare Latin-1. Preserve their encoding when editing.
async function readText(file) {
  const bytes = await fs.readFile(file);
  const encoding = /encoding=["']ISO-8859-1["']/i.test(bytes.subarray(0, 200).toString()) ? 'latin1' : 'utf8';
  return { text: bytes.toString(encoding), encoding };
}

function htmlToText(text, baseUrl) {
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
      try {
        const url = new URL(href, baseUrl);
        return url.protocol === 'https:' ? `[${label.replace(/<[^>]+>/g, '')}](${url})` : label;
      } catch { return label; }
    })
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    })[entity])
    .replace(/[\t ]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

function definition(name, description, properties, required = Object.keys(properties)) {
  return { type: 'function', function: { name, description, parameters: {
    type: 'object', properties, required, additionalProperties: false,
  } } };
}

const string = { type: 'string' };
const definitions = [
  definition('list_files', 'List project files recursively (excluding .git and target).', { directory: string }),
  definition('read_file', 'Read project text, optionally a 1-based line range.', {
    path: string, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 },
  }, ['path']),
  definition('replace_text', 'Replace exactly one occurrence of old_text in a project file. Read before editing.', {
    path: string, old_text: string, new_text: string,
  }),
  definition('write_file', 'Create or replace a project text file.', { path: string, content: string }),
  definition('run_maven', 'Run Maven in the project; returns exit code and log tail. Use ["--version"] for environment details.', {
    command: { type: 'string', enum: MAVEN_COMMANDS }, args: { type: 'array', items: string },
  }),
  definition('fetch_url', 'Fetch public HTTPS reference material or Maven repository metadata.', { url: string }),
  definition('read_skill', 'Load a skill by its catalog name, e.g. read_skill({"name":"update-sling-parent-pom"}). Skill names are NOT callable tools.', { name: string }),
  definition('read_skill_file', 'Read a supporting file relative to an installed skill directory.', { name: string, path: string }),
  definition('finish_task', 'Explicitly end the task. Use completed only when the requested edits are finished; use blocked with an honest explanation if unable to finish.', {
    status: { type: 'string', enum: ['completed', 'blocked'] }, summary: string,
  }),
];

async function executeTool(name, args, state) {
  const { workingDir, skills, runDir, config, signal } = state;
  const projectPath = (file) => safePath(workingDir, file);
  const skill = () => {
    const found = skills.find((item) => item.name === args.name);
    if (!found) throw new Error(`Skill is not installed: ${args.name}`);
    return found;
  };
  switch (name) {
    case 'list_files': return listFiles(workingDir, args.directory);
    case 'read_file': {
      const { text } = await readText(await projectPath(args.path));
      return text.split('\n').slice((args.start ?? 1) - 1, args.end ?? 1000).join('\n');
    }
    case 'replace_text': {
      if (typeof args.old_text !== 'string' || !args.old_text || typeof args.new_text !== 'string') {
        throw new Error('old_text must be a non-empty string and new_text must be a string');
      }
      const file = await projectPath(args.path);
      const { text, encoding } = await readText(file);
      if (text.split(args.old_text).length !== 2) throw new Error('old_text must match exactly once');
      await fs.writeFile(file, text.replace(args.old_text, () => args.new_text), encoding);
      return 'File updated';
    }
    case 'write_file': {
      if (typeof args.content !== 'string') throw new Error('content must be a string');
      const file = await projectPath(args.path);
      let encoding = 'utf8';
      try { ({ encoding } = await readText(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, args.content, encoding);
      return 'File written';
    }
    case 'run_maven': {
      if (!MAVEN_COMMANDS.includes(args.command) || !Array.isArray(args.args) ||
          args.args.some((arg) => typeof arg !== 'string' || /^(deploy|release:)/.test(arg))) {
        throw new Error('Expected a supported Maven command; publishing/releasing is not allowed');
      }
      const log = path.join(runDir, `maven-tool-${state.mavenCalls++}.log`);
      const result = await run(args.command, args.args, {
        cwd: workingDir, log, timeoutMs: config.mavenTimeoutMs, signal,
      });
      return { ...result, output: await tail(log, config.toolOutputChars ?? 8000) };
    }
    case 'fetch_url': {
      const url = new URL(args.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a public HTTPS URL');
      const response = await fetch(url, { signal: AbortSignal.any([
        AbortSignal.timeout(60000), ...(signal ? [signal] : []),
      ]) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      const html = /text\/html/i.test(response.headers.get('content-type') ?? '') || /^\s*(?:<!doctype html|<html\b)/i.test(body);
      return (html ? htmlToText(body, response.url || url) : body).slice(0, 60000);
    }
    case 'read_skill': {
      const selected = skill();
      return {
        instructions: (await readText(path.join(selected.directory, 'SKILL.md'))).text,
        files: await listFiles(selected.directory),
      };
    }
    case 'read_skill_file': return (await readText(await safePath(skill().directory, args.path))).text;
    case 'finish_task': {
      if (!['completed', 'blocked'].includes(args.status) || typeof args.summary !== 'string' || !args.summary.trim()) {
        throw new Error('finish_task requires status completed or blocked and a non-empty summary');
      }
      state.completion = { status: args.status, summary: args.summary };
      return { accepted: true, status: args.status };
    }
    default: {
      const installed = skills.find((item) => item.name === name);
      if (installed) throw new Error(`"${name}" is a skill, not a tool. Call read_skill({"name":"${name}"}) to load its instructions.`);
      throw new Error(`Unknown tool: ${name}. Available tools: ${definitions.map((item) => item.function.name).join(', ')}`);
    }
  }
}

module.exports = { definitions, executeTool, htmlToText, listFiles, readText, run, safePath, tail };
