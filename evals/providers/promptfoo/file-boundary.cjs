const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');

const boundaryVersion = 'native-file-boundary-v1';
const readTools = ['read', 'grep', 'find', 'ls'];
const writeTools = ['edit', 'write'];
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

// Pi 1.5 normalizes these spellings before executing its file tools. The hook
// then replaces input.path with the checked canonical path (supported native API),
// so the tool cannot reinterpret an unchecked @, ~ or file:// spelling.
function resolveInput(input, cwd) {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('Invalid file path');
  let value = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  if (value.startsWith('@')) value = value.slice(1);
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  else if (value.startsWith('file://')) value = fileURLToPath(value);
  return path.resolve(cwd, value);
}

async function canonicalTarget(file, allowMissing) {
  try { return await fs.realpath(file); }
  catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    // A dangling symlink is NOT a missing file that write may safely create.
    try {
      await fs.lstat(file);
      throw new Error('Unresolved symlink');
    } catch (statError) {
      if (statError.code !== 'ENOENT') throw statError;
    }
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonicalTarget(parent, true), path.basename(file));
  }
}

async function createFileBoundary(config, cwd) {
  if (config?.version !== boundaryVersion || !Array.isArray(config.skillRoots) ||
      !path.isAbsolute(config.projectRoot ?? '') || config.skillRoots.some(root => !path.isAbsolute(root))) {
    throw new Error('Missing or invalid native file-boundary configuration');
  }
  const projectRoot = await fs.realpath(config.projectRoot);
  if (projectRoot !== await fs.realpath(cwd)) throw new Error('File-boundary project does not match Pi cwd');
  const skillRoots = await Promise.all(config.skillRoots.map(root => fs.realpath(root)));
  const policy = { version: boundaryVersion, projectRoot, skillRoots,
    readTools, writeTools, bashConfined: false };
  return { policy, async check(tool, input) {
    const writing = writeTools.includes(tool);
    if (!writing && !readTools.includes(tool)) return undefined;
    try {
      const requested = input.path ?? (['grep', 'find', 'ls'].includes(tool) ? '.' : undefined);
      const file = await canonicalTarget(resolveInput(requested, projectRoot), writing);
      // Re-normalizing the canonical spelling must not change its meaning.
      if (resolveInput(file, projectRoot) !== file) throw new Error('Ambiguous canonical path');
      const roots = writing ? [projectRoot] : [projectRoot, ...skillRoots];
      if (!roots.some(root => inside(root, file))) throw new Error('Path is outside declared roots');
      if (writing && inside(path.join(projectRoot, '.git'), file)) throw new Error('Git metadata is read-only');
      return { allowed: true, path: file };
    } catch {
      // No file content or raw filesystem error is exposed for denied paths.
      return { allowed: false,
        reason: `Native file boundary (${boundaryVersion}): ${tool} denied. ` +
          (writing ? 'Writes are allowed only in project files, not skills or Git metadata.' :
            'Reads/searches are allowed only in the project and explicitly copied skills; the path must resolve.') };
    }
  } };
}

module.exports = { boundaryVersion, createFileBoundary };
