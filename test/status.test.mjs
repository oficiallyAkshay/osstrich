import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
  const isLeftoverTemp = fs._files.keys().some((key) => key.includes('.tmp-'));
  assert.equal(isLeftoverTemp, false);
});

test('markPhase inserts a new phase then updates it in place, leaving a SIBLING phase untouched', () => {
  const fs = createFakeFs();
  markPhase('/state/run-1', { stage: 'inventory', state: 'running', attempts: 0 }, { fs });
  markPhase('/state/run-1', { stage: 'inventory', state: 'done', attempts: 1 }, { fs });
  markPhase('/state/run-1', { stage: 'rank', state: 'pending', attempts: 0 }, { fs });
  // Update inventory again now that a SIBLING (rank) phase also exists —
  // the update's own `phases.map` must skip over rank unchanged (map's
  // "not the matching index" branch), not just update the sole phase.
  markPhase('/state/run-1', { stage: 'inventory', state: 'done', attempts: 2 }, { fs });

  const status = readStatus('/state/run-1', { fs });
  assert.equal(status.phases.length, 2);
  const inventory = status.phases.find((p) => p.stage === 'inventory');
  assert.equal(inventory.state, 'done');
  assert.equal(inventory.attempts, 2);
  const rank = status.phases.find((p) => p.stage === 'rank');
  assert.deepEqual(rank, { stage: 'rank', state: 'pending', attempts: 0 });
});

test('markPhase: an existing status.json with no .phases field at all (an older/foreign shape) is treated as having none', () => {
  const fs = createFakeFs({ '/state/run-2/status.json': JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z' }) });
  markPhase('/state/run-2', { stage: 'inventory', state: 'running', attempts: 0 }, { fs });
  const status = readStatus('/state/run-2', { fs });
  assert.deepEqual(status.phases, [{ stage: 'inventory', state: 'running', attempts: 0 }]);
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

test('status: a candidate encountered AFTER the current newest, with an equal-or-older mtime, is skipped rather than replacing it', async () => {
  // createFakeFs's own mtime counter always increases in write order, and
  // its readdirSync always returns entries in that same write order — so
  // going through it, a later-iterated candidate can never have an older
  // mtime, and findNewestRun's own `continue` branch can never fire. A
  // small hand-rolled fs stub gives this ONE test the independent control
  // (a directory listing order that DISAGREES with mtime order) needed to
  // exercise that branch directly, matching a real filesystem where
  // readdir order and mtime order are unrelated.
  const statusJson = { phases: [{ stage: 'inventory', state: 'done', attempts: 1 }] };
  const oldStatusJson = { phases: [{ stage: 'inventory', state: 'failed', attempts: 2, error: 'boom' }] };
  const mtimes = { '2026-02-02-new': 500, '2026-02-01-old': 100 };
  const fs = {
    existsSync: () => true,
    readdirSync: () => ['2026-02-02-new', '2026-02-01-old'],
    statSync: (p) => ({ mtimeMs: mtimes[path.basename(path.dirname(p))] }),
    readFileSync: (p) => (path.basename(path.dirname(p)) === '2026-02-01-old' ? JSON.stringify(oldStatusJson) : JSON.stringify(statusJson)),
  };

  const stdout = createSink();
  const deps = baseDeps({ fs, stdout });
  const code = await statusRun([], deps);

  assert.equal(code, 0);
  assert.match(stdout.text, /inventory done attempts=1/);
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

test('status: a status.json with no .phases field at all prints nothing, never throws', async () => {
  const fs = createFakeFs({ '/home/tester/.osstrich/run-1/status.json': JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z' }) });
  const stdout = createSink();
  const deps = baseDeps({ fs, stdout });
  const code = await statusRun(['--run', 'run-1'], deps);
  assert.equal(code, 0);
  assert.equal(stdout.text, '');
});
