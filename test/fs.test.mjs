import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execGh } from '../lib/fs.mjs';

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
