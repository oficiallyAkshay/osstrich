import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run as configRun } from '../lib/commands/config.mjs';
import { createFakeFs } from './helpers/fake-fs.mjs';
import { createSink } from './helpers/fake-io.mjs';

const repoRoot = '/repo';
const homedir = '/home/tester';

function baseDeps(overrides = {}) {
  return {
    fs: createFakeFs(),
    env: {},
    stdout: createSink(),
    stderr: createSink(),
    homedir,
    cwd: repoRoot,
    ...overrides,
  };
}

test('config set writes a dotted key through saveConfig', async () => {
  const deps = baseDeps();
  const code = await configRun(['set', 'agent.model', 'gpt-5'], deps);
  assert.equal(code, 0);
  const saved = JSON.parse(deps.fs.readFileSync('/repo/.osstrich.json'));
  assert.deepEqual(saved, { agent: { model: 'gpt-5' } });
});

test('config get prints the resolved value with no env annotation when unset', async () => {
  const fs = createFakeFs({ '/repo/.osstrich.json': JSON.stringify({ agent: { model: 'gpt-5' } }) });
  const stdout = createSink();
  const deps = baseDeps({ fs, stdout });

  const code = await configRun(['get', 'agent.model'], deps);
  assert.equal(code, 0);
  assert.equal(stdout.text, '"gpt-5"\n');
});

test('config get names the env var when the value came from one', async () => {
  const fs = createFakeFs({ '/repo/.osstrich.json': JSON.stringify({ agent: { model: 'gpt-5' } }) });
  const stdout = createSink();
  const deps = baseDeps({ fs, stdout, env: { OSSTRICH_MODEL: 'sonnet' } });

  const code = await configRun(['get', 'agent.model'], deps);
  assert.equal(code, 0);
  assert.equal(stdout.text, '"sonnet" (from OSSTRICH_MODEL)\n');
});

test('config get with a missing key argument exits 2', async () => {
  const stderr = createSink();
  const deps = baseDeps({ stderr });
  const code = await configRun(['get'], deps);
  assert.equal(code, 2);
  assert.match(stderr.text, /usage: osstrich config get/);
});

test('config set with a missing value argument exits 2', async () => {
  const stderr = createSink();
  const deps = baseDeps({ stderr });
  const code = await configRun(['set', 'agent.model'], deps);
  assert.equal(code, 2);
  assert.match(stderr.text, /usage: osstrich config set/);
});

test('an unknown subcommand exits 2 with usage', async () => {
  const stderr = createSink();
  const deps = baseDeps({ stderr });
  const code = await configRun(['delete', 'agent.model'], deps);
  assert.equal(code, 2);
  assert.match(stderr.text, /usage: osstrich config <get\|set>/);
});
