// `osstrich status [--run <id>]` — one line per phase of a run: name,
// state, attempts, and the last error if the phase failed. Defaults to the
// newest run under the configured state dir; exits 2 when none exists.
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { readStatus } from '../status.mjs';

function parseArgs(argv) {
  let run = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--run') {
      run = argv[i + 1];
      i += 1;
    }
  }
  return { run };
}

function findNewestRun({ fs, stateDir }) {
  if (!fs.existsSync(stateDir)) return null;
  const candidates = fs
    .readdirSync(stateDir)
    .filter((entry) => fs.existsSync(path.join(stateDir, entry, 'status.json')));

  let newest = null;
  let newestMtime = -Infinity;
  for (const entry of candidates) {
    const mtime = fs.statSync(path.join(stateDir, entry, 'status.json')).mtimeMs;
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newest = entry;
    }
  }
  return newest;
}

export async function run(argv, deps) {
  const { fs, env, stdout, stderr, cwd, homedir } = deps;
  const { run: requestedRun } = parseArgs(argv);
  const config = loadConfig({ repoRoot: cwd, fs, env, homedir });

  const runId = requestedRun ?? findNewestRun({ fs, stateDir: config.stateDir });
  if (!runId) {
    stderr.write('no run exists\n');
    return 2;
  }

  const runDir = path.join(config.stateDir, runId);
  const status = readStatus(runDir, { fs });
  if (!status) {
    stderr.write(`no run exists: ${runId}\n`);
    return 2;
  }

  for (const phase of status.phases ?? []) {
    const errorPart = phase.error ? ` error=${phase.error}` : '';
    stdout.write(`${phase.stage} ${phase.state} attempts=${phase.attempts}${errorPart}\n`);
  }
  return 0;
}
