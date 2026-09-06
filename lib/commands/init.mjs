// `osstrich init` — detect what's on PATH and how the repo is set up, ask at
// most two questions, and write agent.command/agent.model to .osstrich.json.
// Never writes an env value; only ever names which one is missing.
import { saveConfig } from '../config.mjs';
import { AGENT_TOOLS, PROVIDER_VAR, headlessCommandFor, toolForCommand } from '../agent-registry.mjs';
import { detectDotenvxUsage } from '../dotenvx-detect.mjs';

const DETECT_TOOLS = [
  { name: 'gh', args: ['--version'] },
  { name: 'gitleaks', args: ['version'] },
  { name: 'dotenvx', args: ['--version'] },
];

async function toolFound(exec, name, args) {
  try {
    await exec(name, args);
    return true;
  } catch {
    return false;
  }
}

async function detectAgent(exec) {
  for (const tool of AGENT_TOOLS) {
    // Sequential and blocking on purpose: "first found" means we stop
    // probing as soon as one hits, in a fixed priority order.
    // eslint-disable-next-line no-await-in-loop
    if (await toolFound(exec, tool, ['--version'])) {
      return { tool, command: headlessCommandFor(tool) };
    }
  }
  return null;
}

function setHint({ dotenvxPresent, name }) {
  return dotenvxPresent ? `dotenvx set ${name} value` : `add ${name}= to .env`;
}

export async function run(argv, deps) {
  const { fs, env, stdout, prompts, cwd } = deps;
  const yes = argv.includes('--yes') || argv.includes('-y');
  const repoRoot = cwd;

  const detections = [];
  for (const tool of DETECT_TOOLS) {
    // eslint-disable-next-line no-await-in-loop
    const found = await toolFound(deps.exec, tool.name, tool.args);
    detections.push({ name: tool.name, found });
  }
  const dotenvxTool = detections.find((detection) => detection.name === 'dotenvx');
  const dotenvxEncrypted = detectDotenvxUsage({ fs, repoRoot });

  const agent = await detectAgent(deps.exec);

  for (const detection of detections) {
    let line = `${detection.name}: ${detection.found ? 'found' : 'not found'}`;
    if (detection.name === 'dotenvx' && dotenvxEncrypted) {
      line += ' (encrypted .env detected)';
    }
    stdout.write(`${line}\n`);
  }
  stdout.write(`agent: ${agent ? `${agent.tool} (${agent.command})` : 'not found'}\n`);

  let resolvedCommand = agent?.command ?? null;
  let resolvedModel = env.OSSTRICH_MODEL || null;

  if (!yes) {
    const commandAnswer = await prompts.text({
      message: 'Agent command',
      placeholder: resolvedCommand ?? '',
      initialValue: resolvedCommand ?? undefined,
    });
    if (prompts.isCancel(commandAnswer)) {
      prompts.cancel('osstrich init cancelled.');
      return 2;
    }
    if (commandAnswer) resolvedCommand = commandAnswer;

    const modelAnswer = await prompts.text({
      message: 'Model',
      placeholder: resolvedModel ?? '',
      initialValue: resolvedModel ?? undefined,
    });
    if (prompts.isCancel(modelAnswer)) {
      prompts.cancel('osstrich init cancelled.');
      return 2;
    }
    if (modelAnswer) resolvedModel = modelAnswer;
  }

  const agentPatch = {};
  if (resolvedCommand) agentPatch.command = resolvedCommand;
  if (resolvedModel) agentPatch.model = resolvedModel;
  const patch = Object.keys(agentPatch).length > 0 ? { agent: agentPatch } : {};

  saveConfig({ repoRoot, fs, patch });

  const agentTool = toolForCommand(resolvedCommand);
  const providerVar = agentTool ? PROVIDER_VAR[agentTool] : null;
  const dotenvxPresent = Boolean(dotenvxTool?.found);

  if (!env.OSSTRICH_MODEL) {
    stdout.write(`OSSTRICH_MODEL unset: ${setHint({ dotenvxPresent, name: 'OSSTRICH_MODEL' })}\n`);
  }
  if (providerVar && !env[providerVar]) {
    stdout.write(`${providerVar} unset: ${setHint({ dotenvxPresent, name: providerVar })}\n`);
  }

  return 0;
}
