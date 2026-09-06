// `osstrich env list` / `osstrich env set <NAME> [value]`. `list` never
// prints a value, only presence; `set` goes through dotenvx when the repo
// already uses it, otherwise hand-edits .env while preserving every other
// line untouched.
import path from 'node:path';
import { parse as parseDotenv } from '@dotenvx/dotenvx';
import { loadConfig } from '../config.mjs';
import { detectDotenvxUsage } from '../dotenvx-detect.mjs';
import { PROVIDER_VAR, toolForCommand } from '../agent-registry.mjs';

const READ_VARS = ['OSSTRICH_STATE_DIR', 'OSSTRICH_MODEL', 'OSSTRICH_AGENT', 'GH_TOKEN'];

function varsToReport({ env, homedir, fs, cwd }) {
  const config = loadConfig({ repoRoot: cwd, fs, env, homedir });
  const vars = [...READ_VARS];
  const agentTool = toolForCommand(config.agent.command);
  const providerVar = agentTool ? PROVIDER_VAR[agentTool] : null;
  if (providerVar && !vars.includes(providerVar)) vars.push(providerVar);
  return vars;
}

function runList(deps) {
  const { env, fs, homedir, cwd, stdout } = deps;
  const vars = varsToReport({ env, homedir, fs, cwd });
  for (const name of vars) {
    stdout.write(`${name} ${env[name] ? 'set' : 'unset'}\n`);
  }
  return 0;
}

function upsertEnvLine(existingText, name, value) {
  const parsed = parseDotenv(existingText);
  const exists = Object.prototype.hasOwnProperty.call(parsed, name);

  const rawLines = existingText.length > 0 ? existingText.split('\n') : [];
  // A trailing newline in the source produces a trailing '' entry here; drop
  // it once, since we always re-add exactly one trailing newline ourselves.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  let replaced = false;
  const nextLines = rawLines.map((line) => {
    if (replaced || !exists) return line;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && match[1] === name) {
      replaced = true;
      return `${name}=${value}`;
    }
    return line;
  });

  if (!replaced) {
    nextLines.push(`${name}=${value}`);
  }

  return `${nextLines.join('\n')}\n`;
}

async function runSet(rest, deps) {
  const { fs, stdout, stderr, exec, prompts, cwd } = deps;
  const [name, ...valueParts] = rest;
  if (!name) {
    stderr.write('usage: osstrich env set <NAME> [value]\n');
    return 2;
  }

  let value = valueParts.length > 0 ? valueParts.join(' ') : undefined;
  if (value === undefined) {
    const answer = await prompts.password({ message: `Value for ${name}` });
    if (prompts.isCancel(answer)) {
      prompts.cancel('osstrich env set cancelled.');
      return 2;
    }
    value = answer;
  }

  if (detectDotenvxUsage({ fs, repoRoot: cwd })) {
    await exec('dotenvx', ['set', name, value], { cwd });
    stdout.write(`${name} set\n`);
    return 0;
  }

  const envPath = path.join(cwd, '.env');
  const existingText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  fs.writeFileSync(envPath, upsertEnvLine(existingText, name, value));
  stdout.write(`${name} set\n`);
  return 0;
}

export async function run(argv, deps) {
  const [sub, ...rest] = argv;
  if (sub === 'list') return runList(deps);
  if (sub === 'set') return runSet(rest, deps);
  deps.stderr.write('usage: osstrich env <list|set> ...\n');
  return 2;
}
