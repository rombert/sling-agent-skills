const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { run, tail, childEnvironment } = require('./process.cjs');
const { checkUpgrade } = require('./parent-upgrade.cjs');
const { readProject, children, child, value, text, iterText } = require('./xml.cjs');

const exec = promisify(execFile);

async function readTarget(file) {
  const root = await readProject(file);
  const props = new Map(children(child(root, 'properties')).map((item) => [item.name, value(item).trim()]));
  const resolve = (initial) => {
    let result = initial;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!result.includes('${')) return result;
      const updated = result.replace(/\$\{([^}]+)\}/g, (match, name) => props.get(name) ?? match);
      if (updated === result) break;
      result = updated;
    }
    throw new Error(`Unresolved compiler target: ${result}`);
  };
  const configuration = (element) => {
    const config = child(element, 'configuration');
    if (!config) return {};
    const args = resolve([...iterText(config)].join(' '));
    if (/(?:^|\s)(?:--release(?:=|\s)|-target(?:=|\s))/.test(args) ||
        children(child(config, 'compilerArguments')).some((arg) => ['target', 'release'].includes(arg.name))) {
      throw new Error('Custom compiler target arguments cannot be graded safely');
    }
    return Object.fromEntries(children(config).map((item) => [item.name, value(item).trim()]));
  };
  const compiler = children(child(child(root, 'build'), 'plugins'), 'plugin').find((plugin) =>
    text(plugin, 'artifactId') === 'maven-compiler-plugin' &&
    text(plugin, 'groupId', 'org.apache.maven.plugins') === 'org.apache.maven.plugins');
  if (!compiler) throw new Error('No active Maven compiler plugin in the effective POM');
  const common = configuration(compiler);
  const target = (config, test) => {
    const settings = [...(test ? ['testRelease'] : []), 'release', ...(test ? ['testTarget'] : []), 'target'];
    for (const setting of settings) {
      for (const [candidate, source] of [[config[setting], setting],
        [props.get(`maven.compiler.${setting}`), `maven.compiler.${setting}`]]) {
        if (!candidate) continue;
        const resolved = resolve(candidate).replace(/^1\./, '');
        if (!/^[1-9]\d?$/.test(resolved)) throw new Error(`Invalid compiler target: ${resolved}`);
        return { target: Number(resolved), setting: source };
      }
    }
    throw new Error('No resolved compiler release/target; refusing to infer it from the build JDK');
  };
  const evidence = [];
  for (const execution of children(child(compiler, 'executions'), 'execution')) {
    const goals = child(execution, 'goals');
    if (!goals) continue;
    const config = { ...common, ...configuration(execution) };
    for (const goal of children(goals, 'goal')) {
      if (!['compile', 'testCompile'].includes(value(goal))) continue;
      if (text(execution, 'phase') === 'none') throw new Error('Compiler execution disabled');
      const kind = value(goal) === 'testCompile' ? 'test' : 'main';
      evidence.push({ kind, execution: text(execution, 'id'), ...target(config, kind === 'test') });
    }
  }
  for (const kind of ['main', 'test']) {
    if (!evidence.some((item) => item.kind === kind)) {
      evidence.push({ kind, execution: 'implicit-default', ...target(common, kind === 'test') });
    }
  }
  const targets = Object.fromEntries(['main', 'test'].map((kind) =>
    [kind, [...new Set(evidence.filter((item) => item.kind === kind).map((item) => item.target))].sort((a, b) => a - b)]));
  return { targets, evidence };
}

async function checkJavaTarget(metadata, { env } = {}) {
  const fail = (reason) => ({ pass: false, reason });
  if (!metadata?.runDir || !metadata?.workingDir || !/^[a-f0-9]{40,64}$/.test(metadata.baselineCommit ?? '')) {
    return fail('Missing workspace or baseline commit; cannot verify inherited Java target');
  }
  const upgrade = await checkUpgrade(metadata);
  if (!upgrade.pass) return fail(`Java target not checked: ${upgrade.reason}`);
  let artifacts;
  try {
    artifacts = await fs.mkdtemp(path.join(metadata.runDir, 'java-target-'));
    const baseline = path.join(artifacts, 'baseline');
    const git = (args) => exec('git', args, { timeout: 30000, env: childEnvironment(env) });
    // Never check out/reset the edited workspace or the user's source checkout.
    await git(['clone', '--quiet', '--no-local', '--no-hardlinks', metadata.workingDir, baseline]);
    await git(['-C', baseline, 'checkout', '--quiet', '--detach', metadata.baselineCommit]);
    await git(['-C', baseline, 'remote', 'remove', 'origin']);
    const targets = {};
    for (const [label, cwd] of [['before', baseline], ['after', metadata.workingDir]]) {
      const file = path.join(artifacts, `${label}-effective-pom.xml`);
      const log = path.join(artifacts, `${label}-maven.log`);
      const result = await run('mvn', ['-B', '-ntp',
        'org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom', `-Doutput=${file}`], {
        cwd, log, timeoutMs: metadata.mavenTimeoutMs ?? 1200000, env,
      });
      if (result.code !== 0 || result.timedOut) {
        throw new Error(`${label} effective POM ${result.timedOut ? 'timed out' : `exited ${result.code}`}. Log: ${log}\n${await tail(log)}`);
      }
      targets[label] = await readTarget(file);
    }
    const changes = ['main', 'test'].filter((kind) =>
      JSON.stringify(targets.before.targets[kind]) !== JSON.stringify(targets.after.targets[kind]));
    const pass = changes.length === 0;
    await fs.writeFile(path.join(artifacts, 'comparison.json'), JSON.stringify({
      baselineCommit: metadata.baselineCommit, ...targets, pass,
    }, null, 2));
    return { pass, reason: pass ?
      `Java bytecode targets preserved: main=${targets.before.targets.main}, test=${targets.before.targets.test}. Evidence: ${artifacts}` :
      `Java bytecode target changed: ${changes.map((kind) => `${kind} ${targets.before.targets[kind]} -> ${targets.after.targets[kind]}`).join('; ')}. Build JDK requirements do not justify changing the bytecode target. Evidence: ${artifacts}` };
  } catch (error) {
    return fail(`Cannot validate Java bytecode target: ${error.message}${artifacts ? `; artifacts: ${artifacts}` : ''}`);
  }
}

module.exports = { checkJavaTarget, readTarget };
