import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OsstrichError, ERROR_CODES } from '../lib/errors.mjs';

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
