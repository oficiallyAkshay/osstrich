import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStatus, writeStatus, markPhase } from '../lib/status.mjs';
import { run as statusRun } from '../lib/commands/status.mjs';
import { createFakeFs } from './helpers/fake-fs.mjs';
import { createSink } from './helpers/fake-io.mjs';

test('readStatus returns null when the file does not exist', () => {
  const fs = createFakeFs();
  assert.equal(readStatus('/state/run-1', { fs }), null);
});

test('writeStatus writes atomically: no leftover temp file, final file readable', () => {
  const fs = createFakeFs();
  writeStatus('/state/run-1', { phases: [] }, { fs });
  assert.deepEqual(readStatus('/state/run-1', { fs }), { phases: [] });
  const leftoverTemp = [...fs._files.keys()].some((key) => key.includes('.tmp-'));
  assert.equal(leftoverTemp, false);
});

test('markPhase inserts a new phase then updates it in place', () => {
  const fs = createFakeFs();
  markPhase('/state/run-1', { stage: 'inventory', state: 'running', attempts: 0 }, { fs });
  markPhase('/state/run-1', { stage: 'inventory', state: 'done', attempts: 1 }, { fs });
  markPhase('/state/run-1', { stage: 'rank', state: 'pending', attempts: 0 }, { fs });

  const status = readStatus('/state/run-1', { fs });
  assert.equal(status.phases.length, 2);
  const inventory = status.phases.find((p) => p.stage === 'inventory');
  assert.equal(inventory.state, 'done');
  assert.equal(inventory.attempts, 1);
});

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

test('status exits 2 when no run exists at all', async () => {
  const stderr = createSink();
  const deps = baseDeps({ stderr });
  const code = await statusRun([], deps);
  assert.equal(code, 2);
  assert.match(stderr.text, /no run exists/);
});

test('status defaults to the newest run and prints one line per phase', async () => {
  const fs = createFakeFs();
  writeStatus(
    '/home/tester/.osstrich/2026-01-01-old',
    { phases: [{ stage: 'inventory', state: 'done', attempts: 1 }] },
    { fs },
  );
  // Force a distinguishable, later mtime for the "new" run.
  writeStatus(
    '/home/tester/.osstrich/2026-01-02-new',
    { phases: [{ stage: 'inventory', state: 'failed', attempts: 2, error: 'boom' }] },
    { fs },
  );

  const stdout = createSink();
  const deps = baseDeps({ fs, stdout });
  const code = await statusRun([], deps);

  assert.equal(code, 0);
  assert.match(stdout.text, /inventory failed attempts=2 error=boom/);
});

test('status --run <id> reads that specific run, even if not newest', async () => {
  const fs = createFakeFs();
  writeStatus(
    '/home/tester/.osstrich/2026-01-01-old',
    { phases: [{ stage: 'inventory', state: 'done', attempts: 1 }] },
    { fs },
  );
  writeStatus(
    '/home/tester/.osstrich/2026-01-02-new',
    { phases: [{ stage: 'inventory', state: 'failed', attempts: 2, error: 'boom' }] },
    { fs },
  );

  const stdout = createSink();
  const deps = baseDeps({ fs, stdout });
  const code = await statusRun(['--run', '2026-01-01-old'], deps);

  assert.equal(code, 0);
  assert.match(stdout.text, /inventory done attempts=1/);
  assert.doesNotMatch(stdout.text, /boom/);
});

test('status --run <id> exits 2 when that run does not exist', async () => {
  const stderr = createSink();
  const deps = baseDeps({ stderr });
  const code = await statusRun(['--run', 'nope'], deps);
  assert.equal(code, 2);
  assert.match(stderr.text, /no run exists/);
});
