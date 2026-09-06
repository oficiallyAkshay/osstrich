import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryOnce } from '../lib/retry.mjs';

test('retryOnce: a call that succeeds first try runs exactly once', async () => {
  let calls = 0;
  const retrier = retryOnce({ backoffMs: 1, shouldRetry: () => true });

  const result = await retrier(() => {
    calls += 1;
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retryOnce: a retryable failure is retried exactly once, then succeeds', async () => {
  let calls = 0;
  const retrier = retryOnce({ backoffMs: 1, shouldRetry: () => true });

  const result = await retrier(() => {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('retryOnce: a failure that keeps failing runs at most twice, then throws', async () => {
  let calls = 0;
  const retrier = retryOnce({ backoffMs: 1, shouldRetry: () => true });

  await assert.rejects(
    retrier(() => {
      calls += 1;
      throw new Error('still broken');
    }),
    /still broken/,
  );
  assert.equal(calls, 2);
});

test('retryOnce: a failure shouldRetry rejects is never retried', async () => {
  let calls = 0;
  const retrier = retryOnce({ backoffMs: 1, shouldRetry: () => false });

  await assert.rejects(
    retrier(() => {
      calls += 1;
      throw new Error('not worth retrying');
    }),
    /not worth retrying/,
  );
  assert.equal(calls, 1);
});

test('retryOnce: shouldRetry sees the actual thrown error', async () => {
  let calls = 0;
  let seen;
  class TaggedError extends Error {
    constructor(retryable) {
      super('tagged');
      this.retryable = retryable;
    }
  }
  const retrier = retryOnce({
    backoffMs: 1,
    shouldRetry: (error) => {
      seen = error;
      return error.retryable === true;
    },
  });

  await assert.rejects(
    retrier(() => {
      calls += 1;
      throw new TaggedError(false);
    }),
  );
  assert.equal(calls, 1);
  assert.equal(seen?.retryable, false);
});
