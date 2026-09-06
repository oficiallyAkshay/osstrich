/**
 * lib/retry.mjs — this package's one retry primitive, built on cockatiel's
 * `retry` policy. Every caller (an agent stage in `lib/agent.mjs`, a
 * registry fetch in `lib/inventory.mjs`, a `gh` exec in `lib/fs.mjs`) wants
 * the exact same shape: run once, and if it fails in a way worth retrying,
 * run it exactly one more time after a fixed backoff. `retryOnce` is that
 * shape, parameterized only by the backoff delay and the caller's own
 * "is this worth retrying" predicate.
 *
 * COCKATIEL'S `maxAttempts` COUNTS RETRIES, NOT TOTAL CALLS — verified
 * against cockatiel 4.0.0's own `RetryPolicy.execute` (node_modules/
 * cockatiel/dist/RetryPolicy.js): the loop invokes `fn` once unconditionally,
 * then retries while `retries < maxAttempts`. `maxAttempts: 1` therefore
 * means "at most one retry" — two total invocations — not "never retries".
 * `retryOnce` always passes `maxAttempts: 1` for exactly this reason: one
 * retry, two calls, ever.
 */
import { ConstantBackoff, handleWhen, retry } from 'cockatiel';

/**
 * Builds a `fn => policy.execute(fn)` retrier. `fn` is called at most
 * twice: the initial call, then — only if it throws and `shouldRetry(error)`
 * is true — one retry after `backoffMs`. A throw that fails `shouldRetry`
 * propagates immediately, on the first attempt; the second attempt's
 * failure always propagates, retried or not.
 */
export function retryOnce({ backoffMs, shouldRetry }) {
  const policy = retry(handleWhen(shouldRetry), {
    maxAttempts: 1,
    backoff: new ConstantBackoff(backoffMs),
  });
  return (fn) => policy.execute(fn);
}
