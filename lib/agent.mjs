// Runs one agent stage (a headless coding-agent invocation): the timeout
// is execa's own job (`timeout` + `forceKillAfterDelay` below — it kills
// the process itself, not just the promise), wrapped in this package's one
// retry policy (lib/retry.mjs — a constant 5s backoff, one retry, ever).
// Every attempt's combined stdout+stderr streams to <runDir>/<stage>.log;
// the final outcome lands in status.json (via lib/status.mjs) and, on
// failure, a line in <runDir>/errors.jsonl.
import { appendFileSync, createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { markPhase } from './status.mjs';
import { retryOnce } from './retry.mjs';

const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const RETRY_BACKOFF_MS = 5_000;
const FORCE_KILL_DELAY_MS = 5_000;

// `claude -p` and `codex exec` take the model on argv; every other
// configured agent gets OSSTRICH_MODEL in its environment instead.
const ARGV_MODEL_COMMANDS = new Set(['claude -p', 'codex exec']);

// Any thrown error (network, non-zero exit, execa's own timeout) is worth
// one retry — the agent invocation as a whole, not any particular failure
// mode of it.
const retryStage = retryOnce({ backoffMs: RETRY_BACKOFF_MS, shouldRetry: () => true });

function buildInvocation({ command, model, env }) {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const [file, ...rest] = parts;
  const args = [...rest];
  const execEnv = { ...env };
  if (model) {
    if (ARGV_MODEL_COMMANDS.has(command.trim())) {
      args.push('--model', model);
    } else {
      execEnv.OSSTRICH_MODEL = model;
    }
  }
  return { file, args, execEnv };
}

function appendError(runDir, record) {
  mkdirSync(runDir, { recursive: true });
  appendFileSync(path.join(runDir, 'errors.jsonl'), `${JSON.stringify(record)}\n`);
}

function errorMessage(error) {
  return error?.shortMessage || error?.message || String(error);
}

// Waits for the log file to actually be flushed to disk before we hand the
// log path back to the caller — createWriteStream's writes are async, so a
// bare `.end()` can return before anything is on disk.
function closeStream(stream) {
  return new Promise((resolve) => {
    stream.end(resolve);
  });
}

export async function runAgentStage({
  stage,
  prompt,
  cwd,
  command,
  model,
  env,
  runDir,
  exec,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  mkdirSync(runDir, { recursive: true });
  const logPath = path.join(runDir, `${stage}.log`);
  const logStream = createWriteStream(logPath, { flags: 'a' });

  const { file, args, execEnv } = buildInvocation({ command, model, env });

  const startedAt = new Date().toISOString();
  let attempts = 0;
  markPhase(runDir, { stage, state: 'running', attempts, startedAt });

  try {
    const result = await retryStage(() => {
      attempts += 1;
      return exec(file, args, {
        cwd,
        env: execEnv,
        input: prompt,
        stdout: ['pipe', logStream],
        stderr: ['pipe', logStream],
        timeout: timeoutMs,
        forceKillAfterDelay: FORCE_KILL_DELAY_MS,
      });
    });
    markPhase(runDir, {
      stage,
      state: 'done',
      attempts,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    return { ok: true, exitCode: result?.exitCode ?? 0, logPath };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = errorMessage(error);
    markPhase(runDir, { stage, state: 'failed', attempts, startedAt, finishedAt, error: message });
    appendError(runDir, { time: finishedAt, stage, source: 'agent', error: message });
    return { ok: false, exitCode: error?.exitCode ?? 1, logPath };
  } finally {
    await closeStream(logStream);
  }
}
