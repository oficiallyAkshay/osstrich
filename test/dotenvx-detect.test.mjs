import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDotenvxUsage } from '../lib/dotenvx-detect.mjs';
import { createFakeFs } from './helpers/fake-fs.mjs';

test('detects a .env.keys file', () => {
  const fs = createFakeFs({ '/repo/.env.keys': 'DOTENV_PRIVATE_KEY=x\n' });
  assert.equal(detectDotenvxUsage({ fs, repoRoot: '/repo' }), true);
});

test('detects DOTENV_PUBLIC_KEY inside .env', () => {
  const fs = createFakeFs({ '/repo/.env': 'DOTENV_PUBLIC_KEY=abc\nFOO=bar\n' });
  assert.equal(detectDotenvxUsage({ fs, repoRoot: '/repo' }), true);
});

test('detects a package.json dependency on @dotenvx/dotenvx', () => {
  const fs = createFakeFs({
    '/repo/package.json': JSON.stringify({ dependencies: { '@dotenvx/dotenvx': '2.23.0' } }),
  });
  assert.equal(detectDotenvxUsage({ fs, repoRoot: '/repo' }), true);

  const fsDev = createFakeFs({
    '/repo/package.json': JSON.stringify({ devDependencies: { '@dotenvx/dotenvx': '2.23.0' } }),
  });
  assert.equal(detectDotenvxUsage({ fs: fsDev, repoRoot: '/repo' }), true);
});

test('returns false when nothing indicates dotenvx use', () => {
  const fs = createFakeFs({
    '/repo/.env': 'FOO=bar\n',
    '/repo/package.json': JSON.stringify({ dependencies: { execa: '10.0.1' } }),
  });
  assert.equal(detectDotenvxUsage({ fs, repoRoot: '/repo' }), false);
});

test('a malformed package.json is treated as inconclusive, not a crash', () => {
  const fs = createFakeFs({ '/repo/package.json': 'not json' });
  assert.equal(detectDotenvxUsage({ fs, repoRoot: '/repo' }), false);
});

test('returns false when nothing exists at all', () => {
  const fs = createFakeFs();
  assert.equal(detectDotenvxUsage({ fs, repoRoot: '/repo' }), false);
});
