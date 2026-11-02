module.exports = (_output, context) => {
  const metadata = context.providerResponse?.metadata;
  if (typeof metadata?.skillsInstalled !== 'boolean') {
    return { pass: false, score: 0, reason: 'Missing skill installation metadata' };
  }
  const loaded = (metadata.skillCalls ?? []).filter((call) => !call.is_error).map((call) => call.name);
  const pass = metadata.skillsInstalled ? loaded.includes('update-sling-parent-pom') : loaded.length === 0;
  return {
    pass, score: pass ? 1 : 0,
    reason: metadata.skillsInstalled ?
      `Required update-sling-parent-pom; loaded skills: ${loaded.join(', ') || 'none'}` :
      `No-skills baseline; loaded skills: ${loaded.join(', ') || 'none'}`,
  };
};
