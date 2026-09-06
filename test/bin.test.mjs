import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, USAGE, formatFailure, buildDeps } from '../bin/osstrich.mjs';
import { dispatchCore } from '../lib/cli-dispatch.mjs';
import { OsstrichError } from '../lib/errors.mjs';
import { createFakeFs } from './helpers/fake-fs.mjs';
import { createSink } from './helpers/fake-io.mjs';

const homedir = '/home/tester';
const cwd = '/repo';

function baseDeps(overrides = {}) {
  return {
    fs: createFakeFs(),
    env: {},
    stdout: createSink(),
    stderr: createSink(),
    homedir,
    cwd,
    ...overrides,
  };
}

test('no command prints usage and exits 2', async () => {
  const deps = baseDeps();
  const code = await main([], deps);
  assert.equal(code, 2);
  assert.equal(deps.stderr.text, USAGE);
});

test('--help prints usage to stdout and exits 0', async () => {
  const deps = baseDeps();
  const code = await main(['--help'], deps);
  assert.equal(code, 0);
  assert.equal(deps.stdout.text, USAGE);
});

test('an unknown command prints usage and exits 2', async () => {
  const deps = baseDeps();
  const code = await main(['frobnicate'], deps);
  assert.equal(code, 2);
  assert.equal(deps.stderr.text, USAGE);
});

test('a known command dispatches and its return code passes through unchanged', async () => {
  const deps = baseDeps();
  // "env list" is a real, side-effect-free command.
  const code = await main(['env', 'list'], deps);
  assert.equal(code, 0);
  assert.match(deps.stdout.text, /OSSTRICH_STATE_DIR/);
});

test('an OsstrichError thrown by a command maps to exit 2 with its hint', async () => {
  const fs = createFakeFs({ '/repo/.osstrich.json': '{ broken' });
  const deps = baseDeps({ fs });
  const code = await main(['config', 'get', 'agent.model'], deps);
  assert.equal(code, 2);
  assert.match(deps.stderr.text, /osstrich config: FAILED/);
  assert.match(deps.stderr.text, /Malformed JSON/);
});

test('formatFailure includes the hint line only for an OsstrichError that has one', () => {
  const withHint = new OsstrichError('CONFIG', 'bad config', { hint: 'fix the file' });
  assert.equal(formatFailure('config', withHint), 'osstrich config: FAILED — bad config\nfix the file\n');

  const plain = new Error('boom');
  assert.equal(formatFailure('status', plain), 'osstrich status: FAILED — boom\n');
});

test('an unexpected throw (not an OsstrichError) still maps to exit 2', async () => {
  const deps = baseDeps({
    fs: {
      ...createFakeFs(),
      existsSync() {
        throw new Error('disk on fire');
      },
    },
  });
  const code = await main(['status'], deps);
  assert.equal(code, 2);
  assert.match(deps.stderr.text, /osstrich status: FAILED — disk on fire/);
});

test('dispatchCore passes the command\'s own exit code through unchanged (clean/findings/candidates)', async () => {
  const deps = baseDeps();
  const cleanCode = await dispatchCore('discover', ['--headless'], deps, {
    importCore: async () => ({ main: async () => 0 }),
  });
  assert.equal(cleanCode, 0);

  const findingsCode = await dispatchCore('discover', ['--headless'], deps, {
    importCore: async () => ({ main: async () => 1 }),
  });
  assert.equal(findingsCode, 1);
});

test('buildDeps wires real fs/exec/prompts and the current process env', () => {
  const deps = buildDeps();
  assert.equal(typeof deps.fs.existsSync, 'function');
  assert.equal(typeof deps.exec, 'function');
  assert.equal(typeof deps.prompts.select, 'function');
  assert.equal(typeof deps.stdout.write, 'function');
  assert.equal(typeof deps.stderr.write, 'function');
  assert.equal(typeof deps.homedir, 'string');
  assert.equal(deps.cwd, process.cwd());
});
