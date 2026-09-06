import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgentStage } from '../lib/agent.mjs';
import { readStatus } from '../lib/status.mjs';

// runAgentStage writes real files (log, status.json, errors.jsonl) under
// runDir, so these tests use real temp directories rather than a fake fs —
// still no network and no real terminal.
function tmpRunDir() {
  return mkdtempSync(path.join(tmpdir(), 'osstrich-agent-'));
}

test('a successful stage records state "done" with one attempt and streams the log', async () => {
  const runDir = tmpRunDir();
  let received;
  const exec = async (file, args, opts) => {
    received = { file, args, opts };
    opts.stdout[1].write('agent output\n');
    return { exitCode: 0 };
  };

  const result = await runAgentStage({
    stage: 'inventory',
    prompt: 'list the dependencies',
    cwd: runDir,
    command: 'claude -p',
    model: 'sonnet',
    env: { PATH: '/usr/bin' },
    runDir,
    exec,
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(received.file, 'claude');
  assert.deepEqual(received.args, ['-p', '--model', 'sonnet']);
  assert.equal(received.opts.input, 'list the dependencies');

  const status = readStatus(runDir);
  const phase = status.phases.find((p) => p.stage === 'inventory');
  assert.equal(phase.state, 'done');
  assert.equal(phase.attempts, 1);

  assert.equal(existsSync(result.logPath), true);
});

test('a non-argv-model agent gets OSSTRICH_MODEL in its environment instead', async () => {
  const runDir = tmpRunDir();
  let receivedEnv;
  const exec = async (file, args, opts) => {
    receivedEnv = opts.env;
    return { exitCode: 0 };
  };

  await runAgentStage({
    stage: 'rank',
    prompt: 'p',
    cwd: runDir,
    command: 'aider',
    model: 'gpt-5',
    env: {},
    runDir,
    exec,
    timeoutMs: 5_000,
  });

  assert.equal(receivedEnv.OSSTRICH_MODEL, 'gpt-5');
});

test('a failing stage retries once, then records "failed" and appends errors.jsonl', async () => {
  const runDir = tmpRunDir();
  let callCount = 0;
  const exec = async () => {
    callCount += 1;
    throw new Error('agent exploded');
  };

  const result = await runAgentStage({
    stage: 'scrub',
    prompt: 'p',
    cwd: runDir,
    command: 'aider',
    model: null,
    env: {},
    runDir,
    exec,
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, false);
  assert.equal(callCount, 2);

  const status = readStatus(runDir);
  const phase = status.phases.find((p) => p.stage === 'scrub');
  assert.equal(phase.state, 'failed');
  assert.equal(phase.attempts, 2);
  assert.match(phase.error, /agent exploded/);

  const errorsText = readFileSync(path.join(runDir, 'errors.jsonl'), 'utf8');
  const lines = errorsText.trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.stage, 'scrub');
  assert.equal(record.source, 'agent');
  assert.match(record.error, /agent exploded/);
});

test('a hung stage times out per attempt and gives up after one retry', async () => {
  const runDir = tmpRunDir();
  let callCount = 0;
  // Real execa enforces `opts.timeout` (+ `forceKillAfterDelay`) itself —
  // runAgentStage no longer wraps a cockatiel timeout policy around it, so
  // this fake has to reject on the same option a real execa call would
  // honor, rather than hanging forever.
  const exec = async (file, args, opts) => {
    callCount += 1;
    return new Promise((_resolve, reject) => {
      setTimeout(() => {
        const error = new Error('Command timed out');
        error.timedOut = true;
        reject(error);
      }, opts.timeout);
    });
  };

  const result = await runAgentStage({
    stage: 'upstream',
    prompt: 'p',
    cwd: runDir,
    command: 'aider',
    model: null,
    env: {},
    runDir,
    exec,
    timeoutMs: 50,
  });

  assert.equal(result.ok, false);
  assert.equal(callCount, 2);

  const status = readStatus(runDir);
  const phase = status.phases.find((p) => p.stage === 'upstream');
  assert.equal(phase.state, 'failed');
  assert.equal(phase.attempts, 2);
});
