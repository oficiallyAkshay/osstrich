#!/usr/bin/env node
// Entry point: wires real fs/exec/prompts into whichever command was named,
// and maps every thrown OsstrichError (or anything unexpected) to the exit
// codes described in lib/errors.mjs.
import os from 'node:os';
import fs, { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import * as prompts from '@clack/prompts';
import { loadEnv } from '../lib/env.mjs';
import { OsstrichError, formatFailure } from '../lib/errors.mjs';
import { dispatchCore } from '../lib/cli-dispatch.mjs';
import * as initCommand from '../lib/commands/init.mjs';
import * as configCommand from '../lib/commands/config.mjs';
import * as envCommand from '../lib/commands/env.mjs';
import * as statusCommand from '../lib/commands/status.mjs';

export const USAGE = `usage: osstrich <command> [options]

Commands:
  init [--yes]                     detect tooling and write .osstrich.json
  config get|set <key> [value]     read or write a dotted config key
  env list                         show which env vars osstrich reads (never values)
  env set <NAME> [value]           set one env var (via dotenvx when detected)
  status [--run <id>]              show the phases of a run
  discover [--headless|--table]    rank upstream contribution candidates
  build [<owner/repo#n|url>]       run one contribution to a merged PR
  scrub                            check a draft for personal/internal info
  recheck                          re-verify a previously tracked contribution
`;

const CORE_COMMANDS = new Set(['discover', 'build', 'scrub', 'recheck']);

export function buildDeps({ argv = process.argv, env = process.env } = {}) {
  const cwd = process.cwd();
  const homedir = os.homedir();
  const mergedEnv = loadEnv({ repoRoot: cwd, fs, env });
  return {
    fs,
    env: mergedEnv,
    stdout: process.stdout,
    stderr: process.stderr,
    exec: execa,
    prompts,
    homedir,
    cwd,
    argv,
  };
}

export { formatFailure };

export async function main(argv, deps) {
  const [command, ...rest] = argv;

  if (!command) {
    deps.stderr.write(USAGE);
    return 2;
  }
  if (command === '--help' || command === '-h') {
    deps.stdout.write(USAGE);
    return 0;
  }

  try {
    if (command === 'init') return await initCommand.run(rest, deps);
    if (command === 'config') return await configCommand.run(rest, deps);
    if (command === 'env') return await envCommand.run(rest, deps);
    if (command === 'status') return await statusCommand.run(rest, deps);
    if (CORE_COMMANDS.has(command)) return await dispatchCore(command, rest, deps);

    deps.stderr.write(USAGE);
    return 2;
  } catch (error) {
    deps.stderr.write(formatFailure(command, error));
    return 2;
  }
}

/* c8 ignore start -- exercised via the bin, not unit tests */
function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
}

if (isMain()) {
  const deps = buildDeps();
  main(process.argv.slice(2), deps).then((code) => {
    process.exitCode = code;
  });
}
/* c8 ignore stop */
