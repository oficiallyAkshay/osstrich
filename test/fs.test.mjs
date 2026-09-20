import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execGh, classifySkipDirs, lineOf, stripPnpmPatchVersion } from '../lib/fs.mjs';

test('execGh: a spawn-level failure (no captured exit) is retried once, then succeeds', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('spawn gh ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return { stdout: '{"ok":true}' };
  };

  const result = await execGh(exec, ['api', 'repos/acme/widget']);

  assert.equal(calls, 2);
  assert.deepEqual(result, { stdout: '{"ok":true}' });
});

test('execGh: a non-zero exit with empty stdout is retried once, then succeeds', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('gh exited 1');
      error.code = 1;
      error.stdout = '';
      throw error;
    }
    return { stdout: '{"ok":true}' };
  };

  const result = await execGh(exec, ['api', 'repos/acme/widget']);

  assert.equal(calls, 2);
  assert.deepEqual(result, { stdout: '{"ok":true}' });
});

test('execGh: a 404 body is never retried', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    const error = new Error('gh exited 1');
    error.code = 1;
    error.stdout = '{"message":"Not Found"}';
    throw error;
  };

  await assert.rejects(execGh(exec, ['api', 'repos/acme/missing']), /gh exited 1/);
  assert.equal(calls, 1);
});

test('execGh: a repeated transient failure still gives up after the one retry', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    const error = new Error('gh exited 1');
    error.code = 1;
    error.stdout = '';
    throw error;
  };

  await assert.rejects(execGh(exec, ['api', 'repos/acme/widget']), /gh exited 1/);
  assert.equal(calls, 2);
});

test('execGh: passes the package standard timeout/buffer options through to exec', async () => {
  let receivedOpts;
  const exec = async (file, args, opts) => {
    receivedOpts = opts;
    return { stdout: 'ok' };
  };

  await execGh(exec, ['api', 'rate_limit']);

  assert.equal(receivedOpts.encoding, 'utf8');
  assert.equal(receivedOpts.timeout, 15_000);
  assert.equal(receivedOpts.maxBuffer, 10 * 1024 * 1024);
});

test('classifySkipDirs: a nullish skipDirs falls back to an empty list; a non-string/empty entry is skipped', () => {
  assert.deepEqual(classifySkipDirs(), { names: new Set(), prefixes: [] });
  assert.deepEqual(classifySkipDirs(null), { names: new Set(), prefixes: [] });
  const config = classifySkipDirs(['node_modules', '', 42, null, 'packages/legacy/']);
  assert.deepEqual(config.names, new Set(['node_modules']));
  assert.deepEqual(config.prefixes, ['packages/legacy']);
});

test('lineOf: a needle that never appears in text returns null', () => {
  assert.equal(lineOf('one\ntwo\nthree', 'four'), null);
  assert.equal(lineOf('one\ntwo\nthree', 'two'), 2);
});

test('stripPnpmPatchVersion: a key with no "@" at all, or a leading "@" only (a scoped name with no version), passes through unchanged', () => {
  assert.equal(stripPnpmPatchVersion('lodash'), 'lodash');
  assert.equal(stripPnpmPatchVersion('@babel/core'), '@babel/core');
  assert.equal(stripPnpmPatchVersion('lodash@4.17.21'), 'lodash');
  assert.equal(stripPnpmPatchVersion('@babel/core@7.10.0'), '@babel/core');
});
