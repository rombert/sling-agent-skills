// Explicit adapter registry. Shared code never imports providers; only the
// top-level commands dispatch through this boundary.
function getProvider(name) {
  if (name === 'promptfoo') return require('./promptfoo/index.cjs');
  if (name === 'tessl') return require('./tessl/index.cjs');
  if (name === 'inspect') return require('./inspect/index.cjs');
  throw new Error(`Unsupported evaluation provider: ${name}; adapter is not implemented yet`);
}

module.exports = { getProvider };
