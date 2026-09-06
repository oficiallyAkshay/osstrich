// The npm-installed `node_modules/.bin/osstrich` is a symlink to the real
// bin file. `bin/osstrich.mjs` decides whether it's being run directly (vs.
// imported as a library) by comparing `import.meta.url` against
// `process.argv[1]`; when invoked through a symlink, argv[1] is the
// symlink's own path, not the real file's, so a raw string compare would
// fail the check and the CLI would silently print nothing and exit 0. The
// fix resolves both sides with `realpathSync` before comparing. This test
// guards that fix across all three shapes: symlink invocation, direct
// invocation, and import-as-a-library (which must NOT run main()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BIN_PATH = fileURLToPath(new URL('../bin/osstrich.mjs', import.meta.url));

test('invoking the bin through a symlink prints usage and exits 0', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'osstrich-symlink-'));
  const symlinkPath = path.join(dir, 'osstrich');
  try {
    symlinkSync(BIN_PATH, symlinkPath);
    const output = execFileSync(process.execPath, [symlinkPath, '--help'], { encoding: 'utf8' });
    assert.match(output, /usage: osstrich <command> \[options\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invoking the bin directly prints usage and exits 0', () => {
  const output = execFileSync(process.execPath, [BIN_PATH, '--help'], { encoding: 'utf8' });
  assert.match(output, /usage: osstrich <command> \[options\]/);
});

test('importing the bin as a library prints nothing (main() does not run)', () => {
  const binUrl = pathToFileURL(BIN_PATH).href;
  const output = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(binUrl)})`], {
    encoding: 'utf8',
  });
  assert.equal(output, '');
});
