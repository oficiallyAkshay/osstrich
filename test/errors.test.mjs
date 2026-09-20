import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OsstrichError, ERROR_CODES, formatFailure } from '../lib/errors.mjs';

test('every documented error code is constructible', () => {
  for (const code of ERROR_CODES) {
    const err = new OsstrichError(code, `${code} broke`);
    assert.equal(err.code, code);
    assert.equal(err.message, `${code} broke`);
    assert.equal(err.name, 'OsstrichError');
    assert.equal(err.hint, null);
  }
});

test('carries an optional cause and hint', () => {
  const cause = new Error('root cause');
  const err = new OsstrichError('AGENT', 'agent failed', { cause, hint: 'try again' });
  assert.equal(err.cause, cause);
  assert.equal(err.hint, 'try again');
});

test('an unknown code throws immediately', () => {
  assert.throws(() => new OsstrichError('NOPE', 'x'), /unknown code/);
});

test('formatFailure: an Error uses its own .message; a non-Error thrown value is stringified instead', () => {
  assert.equal(formatFailure('build', new Error('boom')), 'osstrich build: FAILED — boom\n');
  assert.equal(formatFailure('build', 'a bare string throw'), 'osstrich build: FAILED — a bare string throw\n');
  assert.equal(formatFailure('build', 42), 'osstrich build: FAILED — 42\n');
});

test('formatFailure: an OsstrichError with a hint appends it; one with no hint (or a plain Error) never does', () => {
  const withHint = new OsstrichError('AGENT', 'agent failed', { hint: 'run osstrich init' });
  assert.equal(formatFailure('discover', withHint), 'osstrich discover: FAILED — agent failed\nrun osstrich init\n');

  const withoutHint = new OsstrichError('AGENT', 'agent failed');
  assert.equal(formatFailure('discover', withoutHint), 'osstrich discover: FAILED — agent failed\n');

  const plainError = new Error('not an OsstrichError at all');
  assert.equal(formatFailure('discover', plainError), 'osstrich discover: FAILED — not an OsstrichError at all\n');
});
