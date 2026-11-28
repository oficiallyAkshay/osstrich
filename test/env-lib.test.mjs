import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnv } from '../lib/env.mjs';
import { runAgentStage } from '../lib/agent.mjs';

test('loadEnv returns the env unchanged when there is no .env file', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'osstrich-env-'));
  const merged = loadEnv({ repoRoot, fs, env: { FOO: 'bar' } });
  assert.deepEqual(merged, { FOO: 'bar' });
});

test('loadEnv merges .env values without mutating process.env', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'osstrich-env-'));
  writeFileSync(path.join(repoRoot, '.env'), 'OSSTRICH_STATE_DIR=hello\n');

  const before = process.env.OSSTRICH_STATE_DIR;
  const merged = loadEnv({ repoRoot, fs, env: { KEPT: '1' } });

  assert.equal(merged.OSSTRICH_STATE_DIR, 'hello');
  assert.equal(merged.KEPT, '1');
  assert.equal(process.env.OSSTRICH_STATE_DIR, before);
});

test('an agent stage gets only the .env settings osstrich uses', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'osstrich-env-'));
  writeFileSync(path.join(repoRoot, '.env'), 'UNRELATED_SECRET=made-up\nANTHROPIC_API_KEY=made-up-key\nGH_TOKEN=from-file\n');
  const env = loadEnv({ repoRoot, fs, env: { KEPT: '1', GH_TOKEN: 'from-process' } });

  let received;
  await runAgentStage({
    stage: 'inventory', prompt: 'p', cwd: repoRoot, command: 'claude -p', env,
    runDir: path.join(repoRoot, 'run'), timeoutMs: 5000,
    exec: async (file, args, opts) => { received = opts.env; return { exitCode: 0 }; },
  });

  assert.equal(Object.hasOwn(received, 'UNRELATED_SECRET'), false);
  assert.equal(received.ANTHROPIC_API_KEY, 'made-up-key');
  assert.equal(received.GH_TOKEN, 'from-process');
  assert.equal(received.KEPT, '1');
});
