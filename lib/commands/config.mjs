// `osstrich config get|set <key> [value]` — dotted-key access over the
// resolved config (get) or the on-disk patch (set).
import { loadConfig, saveConfig } from '../config.mjs';

// Only keys an env var can override are worth annotating on `get`.
const ENV_FOR_KEY = {
  stateDir: 'OSSTRICH_STATE_DIR',
  'agent.command': 'OSSTRICH_AGENT',
  'agent.model': 'OSSTRICH_MODEL',
};

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setPath(dotted, value) {
  const parts = dotted.split('.');
  const root = {};
  let cursor = root;
  parts.forEach((key, i) => {
    if (i === parts.length - 1) {
      cursor[key] = value;
    } else {
      cursor[key] = {};
      cursor = cursor[key];
    }
  });
  return root;
}

function runGet(rest, deps) {
  const { fs, env, stdout, stderr, cwd, homedir } = deps;
  const [key] = rest;
  if (!key) {
    stderr.write('usage: osstrich config get <key>\n');
    return 2;
  }
  const config = loadConfig({ repoRoot: cwd, fs, env, homedir });
  const value = getPath(config, key);
  const envVar = ENV_FOR_KEY[key];
  if (envVar && env[envVar]) {
    stdout.write(`${JSON.stringify(value)} (from ${envVar})\n`);
  } else {
    stdout.write(`${JSON.stringify(value)}\n`);
  }
  return 0;
}

function runSet(rest, deps) {
  const { fs, stderr, cwd } = deps;
  const [key, value] = rest;
  if (!key || value === undefined) {
    stderr.write('usage: osstrich config set <key> <value>\n');
    return 2;
  }
  saveConfig({ repoRoot: cwd, fs, patch: setPath(key, value) });
  return 0;
}

export async function run(argv, deps) {
  const [sub, ...rest] = argv;
  if (sub === 'get') return runGet(rest, deps);
  if (sub === 'set') return runSet(rest, deps);
  deps.stderr.write('usage: osstrich config <get|set> <key> [value]\n');
  return 2;
}
