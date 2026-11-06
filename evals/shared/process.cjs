const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

// Persist full logs without buffering an entire Maven build in memory.
async function run(command, args, { cwd, log, timeoutMs = 1200000, signal, env = process.env } = {}) {
  const handle = await fs.open(log, 'w');
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: ['ignore', handle.fd, handle.fd],
        env: childEnvironment(env),
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

// Repository commands must not inherit another checkout's Git context. Provider
// adapters additionally remove their own model credentials before calling us.
const childEnvironment = (env = process.env) => Object.fromEntries(
  Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));

module.exports = { run, tail, childEnvironment };
