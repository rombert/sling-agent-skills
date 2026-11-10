module.exports = (_output, context) => {
  const metadata = context.providerResponse?.metadata;
  if (typeof metadata?.skillsInstalled !== 'boolean') {
    return { pass: false, score: 0, reason: 'Missing skill installation metadata' };
  }
  const successful = (metadata.skillCalls ?? []).filter((call) => !call.is_error);
  const ambient = successful.filter((call) => call.installed === false);
  if (ambient.length) {
    return { pass: false, score: 0,
      reason: `Uninstalled host skills were read; arm contaminated: ${ambient.map((call) => call.path).join(', ')}` };
  }
  const loaded = successful.map((call) => call.name);
  const pass = metadata.skillsInstalled ? loaded.includes('update-sling-parent-pom') : loaded.length === 0;
  return {
    pass, score: pass ? 1 : 0,
    reason: metadata.skillsInstalled ?
      `Required update-sling-parent-pom; loaded skills: ${loaded.join(', ') || 'none'}` :
      `No-skills baseline; loaded skills: ${loaded.join(', ') || 'none'}`,
  };
};
