import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadEnv } from '../lib/env.mjs';

test('loadEnv returns the env unchanged when there is no .env file', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'osstrich-env-'));
  const merged = loadEnv({ repoRoot, fs, env: { FOO: 'bar' } });
  assert.deepEqual(merged, { FOO: 'bar' });
});

test('loadEnv merges .env values without mutating process.env', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'osstrich-env-'));
  writeFileSync(path.join(repoRoot, '.env'), 'FROM_FILE=hello\n');

  const before = process.env.FROM_FILE;
  const merged = loadEnv({ repoRoot, fs, env: { KEPT: '1' } });

  assert.equal(merged.FROM_FILE, 'hello');
  assert.equal(merged.KEPT, '1');
  assert.equal(process.env.FROM_FILE, before);
});
