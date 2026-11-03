// Evaluation controls only. Pi owns model requests, native tools, and the agent loop.
import { readFileSync } from 'node:fs';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBashToolDefinition, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { toolKey } from './tool-key.cjs';

const exec = promisify(execFile);

// Bash can edit too (e.g. spotless:apply). Detect project changes without
// treating ignored build outputs, outside downloads, or compaction as progress.
async function workspaceFingerprint(cwd: string) {
  const git = (args: string[]) => exec('git', args, { cwd, maxBuffer: 20 * 1024 * 1024,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      key !== 'LITELLM_API_KEY' && !key.startsWith('GIT_'))),
  });
  const [{ stdout: diff }, { stdout: untracked }] = await Promise.all([
    git(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', '.']),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const hash = createHash('sha256').update(diff);
  for (const file of untracked.split('\0').filter(Boolean).sort()) {
    const absolute = join(cwd, file);
    const stat = await lstat(absolute);
    hash.update(file).update('\0');
    if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
    else if (stat.isFile()) hash.update(await readFile(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export default function (pi: ExtensionAPI) {
  const config = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, 'eval.json'), 'utf8'));
  let turns = 0;
  let textOnlyTurns = 0;
  let callCount = 0;
  let failure = false;
  let completion: { status: string; summary: string } | undefined;
  const repeats = new Map<string, number>();
  let fingerprint: string;
  let stalled: string | undefined;

  pi.on('session_start', async (_event, ctx) => {
    fingerprint = await workspaceFingerprint(ctx.cwd);
  });
  pi.on('tool_call', (event) => {
    if (stalled) return { block: true, reason: stalled };
    const key = toolKey(event.toolName, event.input);
    const count = (repeats.get(key) ?? 0) + 1;
    repeats.set(key, count);
    if (count > config.maxToolRepeats) {
      stalled = `Repeated ${event.toolName} with identical arguments more than ${config.maxToolRepeats} times without edits; stopping a stalled tool loop.`;
      pi.appendEntry('eval-stall', { tool: event.toolName, input: event.input, count });
      return { block: true, reason: stalled };
    }
  });
  pi.on('tool_result', async (event, ctx) => {
    if (stalled || !['edit', 'write', 'bash'].includes(event.toolName)) return;
    const current = await workspaceFingerprint(ctx.cwd);
    if (current !== fingerprint || (!event.isError && ['edit', 'write'].includes(event.toolName))) {
      repeats.clear();
    }
    fingerprint = current;
  });

  pi.on('before_provider_request', (event, ctx) => {
    const payload = event.payload as Record<string, unknown>;
    // Audit effective limits, not prompts, headers, or credentials. Pi may clamp
    // max_tokens below the configured model limit as context grows.
    pi.appendEntry('eval-request', {
      model: payload.model, maxTokens: payload.max_tokens ?? payload.max_completion_tokens,
      contextTokens: ctx.getContextUsage()?.tokens, contextWindow: ctx.model?.contextWindow,
    });
  });

  const bash = createBashToolDefinition(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => ({ command, cwd,
      env: Object.fromEntries(Object.entries(env).filter(([key]) =>
        key !== 'LITELLM_API_KEY' && !key.startsWith('GIT_'))),
    }),
  });
  pi.registerTool({ ...bash,
    execute(id, params, signal, onUpdate, ctx) {
      const maximum = config.commandTimeoutMs / 1000;
      return bash.execute(id, { ...params, timeout: Math.min(params.timeout ?? maximum, maximum) }, signal, onUpdate, ctx);
    },
  });
  pi.registerTool({
    name: 'finish_task', label: 'Finish task',
    description: 'Report completed or genuinely blocked work with an honest summary. Call this tool alone.',
    parameters: Type.Object({ status: Type.Union([Type.Literal('completed'), Type.Literal('blocked')]), summary: Type.String() }),
    async execute(_id, params) {
      if (callCount !== 1) throw new Error('Call finish_task alone, after all editing/verification tools have returned');
      if (!params.summary.trim()) throw new Error('finish_task requires a non-empty summary');
      completion = { status: params.status, summary: params.summary };
      return { content: [{ type: 'text', text: 'Task completion accepted.' }], details: { completion } };
    },
  });

  pi.on('turn_start', () => { turns++; });
  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant') return;
    callCount = event.message.content.filter((part) => part.type === 'toolCall').length;
    textOnlyTurns = callCount ? 0 : textOnlyTurns + 1;
    failure = ['error', 'length', 'aborted'].includes(event.message.stopReason);
  });
  pi.on('turn_end', (_event, ctx) => {
    if (failure) return;
    if (stalled) completion = { status: 'incomplete', summary: stalled };
    if (!completion && turns >= config.maxTurns) {
      completion = { status: 'incomplete', summary: `Model did not call finish_task within ${config.maxTurns} turns.` };
    }
    if (!completion && textOnlyTurns >= config.maxTextOnlyTurns) {
      completion = { status: 'incomplete', summary: 'Stopped after repeated text-only responses without finish_task.' };
    }
    if (completion) {
      pi.appendEntry('eval-completion', completion);
      // Abort at the turn boundary, after the finish tool result has been emitted.
      // The adapter distinguishes this deliberate stop from an external abort.
      ctx.abort();
    }
  });
  pi.on('agent_before_settle', () => {
    if (completion || failure) return;
    return { continue: true, entries: [{
      type: 'custom_message', customType: 'eval-reminder', display: false,
      content: 'That was progress narration, not completion. Perform the next action with a tool, or call finish_task with status completed or blocked and a truthful summary.',
    }] };
  });
}
