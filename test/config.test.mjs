import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SKIP_DIRS, OsstrichConfigError, loadConfig, saveConfig, expandString } from '../lib/config.mjs';
import { OsstrichError } from '../lib/errors.mjs';
import { createFakeFs } from './helpers/fake-fs.mjs';

const repoRoot = '/repo';
const homedir = '/home/tester';

test('loadConfig applies every built-in default when no file exists', () => {
  const fs = createFakeFs();
  const config = loadConfig({ repoRoot, fs, env: {}, homedir });

  assert.equal(config.stateDir, '/home/tester/.osstrich');
  assert.equal(config.classification, null);
  assert.equal(config.scrubTerms, null);
  assert.equal(config.hosts, null);
  assert.deepEqual(config.ignore, []);
  assert.deepEqual(config.skipDirs, ['node_modules', '.git', 'coverage', 'dist', 'build']);
  assert.deepEqual(config.stopwords, []);
  assert.equal(config.maxFileBytes, 262144);
  assert.deepEqual(config.hooks, { runEnd: null });
  assert.deepEqual(config.agent, { command: null, model: null });
});

test('OSSTRICH_STATE_DIR wins over the config file and the default', () => {
  const fs = createFakeFs({
    '/repo/.osstrich.json': JSON.stringify({ stateDir: '/wherever' }),
  });
  const config = loadConfig({ repoRoot, fs, env: { OSSTRICH_STATE_DIR: '/from-env' }, homedir });
  assert.equal(config.stateDir, '/from-env');
});

test('OSSTRICH_AGENT and OSSTRICH_MODEL win over configured agent values', () => {
  const fs = createFakeFs({
    '/repo/.osstrich.json': JSON.stringify({ agent: { command: 'aider', model: 'file-model' } }),
  });
  const config = loadConfig({
    repoRoot,
    fs,
    env: { OSSTRICH_AGENT: 'codex exec', OSSTRICH_MODEL: 'env-model' },
    homedir,
  });
  assert.equal(config.agent.command, 'codex exec');
  assert.equal(config.agent.model, 'env-model');
});

test('expandString expands a leading ~ against homedir', () => {
  assert.equal(expandString('~', { env: {}, homedir }), homedir);
  assert.equal(expandString('~/.osstrich', { env: {}, homedir }), '/home/tester/.osstrich');
});

test('expandString expands ${VAR} and ${VAR:-default}', () => {
  const env = { FOO: 'bar' };
  assert.equal(expandString('${FOO}/x', { env, homedir }), 'bar/x');
  assert.equal(expandString('${MISSING:-fallback}', { env, homedir }), 'fallback');
  assert.equal(expandString('${MISSING}', { env, homedir }), '');
});

test('a relative default file path resolves to null when the file is absent, and to a path when present', () => {
  const fsMissing = createFakeFs();
  const missing = loadConfig({ repoRoot, fs: fsMissing, env: {}, homedir });
  assert.equal(missing.classification, null);

  const fsPresent = createFakeFs({
    '/repo/.osstrich/classification.md': '# classification',
  });
  const present = loadConfig({ repoRoot, fs: fsPresent, env: {}, homedir });
  assert.equal(present.classification, '/repo/.osstrich/classification.md');
});

test('a configured relative path for classification/scrubTerms/hosts resolves against repoRoot', () => {
  const fs = createFakeFs({
    '/repo/custom/scrub.txt': 'term\n',
  });
  const config = loadConfig({
    repoRoot,
    fs,
    env: {},
    homedir,
    ...{},
  });
  const withPatch = loadConfig({
    repoRoot,
    fs: createFakeFs({
      '/repo/.osstrich.json': JSON.stringify({ scrubTerms: 'custom/scrub.txt' }),
      '/repo/custom/scrub.txt': 'term\n',
    }),
    env: {},
    homedir,
  });
  assert.equal(withPatch.scrubTerms, '/repo/custom/scrub.txt');
  assert.equal(config.scrubTerms, null); // sanity: default path, file absent here
});

test('malformed JSON throws a CONFIG error naming the file', () => {
  const fs = createFakeFs({ '/repo/.osstrich.json': '{ not json' });
  assert.throws(
    () => loadConfig({ repoRoot, fs, env: {}, homedir }),
    (err) => {
      assert.ok(err instanceof OsstrichError);
      assert.ok(err instanceof OsstrichConfigError);
      assert.equal(err.code, 'CONFIG');
      assert.match(err.message, /\/repo\/\.osstrich\.json/);
      return true;
    },
  );
});

test('DEFAULT_SKIP_DIRS is exported and matches loadConfig\'s own built-in default', () => {
  assert.deepEqual(DEFAULT_SKIP_DIRS, ['node_modules', '.git', 'coverage', 'dist', 'build']);
  const fs = createFakeFs();
  const config = loadConfig({ repoRoot, fs, env: {}, homedir });
  assert.deepEqual(config.skipDirs, DEFAULT_SKIP_DIRS);
});

// A relative config `stateDir` must never silently join against repoRoot —
// discover.md's run-directory invariant is "never inside the repo," and a
// run's partials can carry upstream issue/PR text, not just our own code.
test('a relative config stateDir throws OsstrichConfigError instead of resolving inside the repo', () => {
  const fs = createFakeFs({ '/repo/.osstrich.json': JSON.stringify({ stateDir: 'relative-state-dir' }) });
  assert.throws(
    () => loadConfig({ repoRoot, fs, env: {}, homedir }),
    (err) => {
      assert.ok(err instanceof OsstrichConfigError);
      assert.match(err.message, /relative-state-dir/);
      assert.match(err.message, /state dir must be absolute and outside the repository/);
      return true;
    },
  );
});

test('a relative OSSTRICH_STATE_DIR throws the same way as a relative config value', () => {
  const fs = createFakeFs();
  assert.throws(
    () => loadConfig({ repoRoot, fs, env: { OSSTRICH_STATE_DIR: 'relative-env-state-dir' }, homedir }),
    (err) => err instanceof OsstrichConfigError,
  );
});

test('an absolute stateDir nested inside repoRoot throws too, and names the resolved value', () => {
  const fs = createFakeFs({ '/repo/.osstrich.json': JSON.stringify({ stateDir: '/repo/osstrich-runs' }) });
  assert.throws(
    () => loadConfig({ repoRoot, fs, env: {}, homedir }),
    (err) => {
      assert.ok(err instanceof OsstrichConfigError);
      assert.match(err.message, /\/repo\/osstrich-runs/);
      return true;
    },
  );
});

test('a stateDir equal to repoRoot itself throws too, not just a nested one', () => {
  const fs = createFakeFs({ '/repo/.osstrich.json': JSON.stringify({ stateDir: '/repo' }) });
  assert.throws(
    () => loadConfig({ repoRoot, fs, env: {}, homedir }),
    (err) => err instanceof OsstrichConfigError,
  );
});

test('an absolute stateDir outside repoRoot resolves with no throw', () => {
  const fs = createFakeFs({ '/repo/.osstrich.json': JSON.stringify({ stateDir: '/elsewhere/state' }) });
  const config = loadConfig({ repoRoot, fs, env: {}, homedir });
  assert.equal(config.stateDir, '/elsewhere/state');
});

test('a wrong-typed value throws a named CONFIG error', () => {
  const fs = createFakeFs({
    '/repo/.osstrich.json': JSON.stringify({ maxFileBytes: 'not-a-number' }),
  });
  assert.throws(
    () => loadConfig({ repoRoot, fs, env: {}, homedir }),
    (err) => {
      assert.ok(err instanceof OsstrichError);
      assert.equal(err.code, 'CONFIG');
      return true;
    },
  );
});

test('saveConfig creates the file when absent and deep-merges into it when present', () => {
  const fs = createFakeFs();
  const first = saveConfig({ repoRoot, fs, patch: { agent: { command: 'claude -p' } } });
  assert.deepEqual(first, { agent: { command: 'claude -p' } });

  const second = saveConfig({ repoRoot, fs, patch: { agent: { model: 'sonnet' } } });
  assert.deepEqual(second, { agent: { command: 'claude -p', model: 'sonnet' } });

  const onDisk = JSON.parse(fs.readFileSync('/repo/.osstrich.json'));
  assert.deepEqual(onDisk, { agent: { command: 'claude -p', model: 'sonnet' } });
});

test('saveConfig raises the same named error on malformed existing JSON', () => {
  const fs = createFakeFs({ '/repo/.osstrich.json': 'not json at all' });
  assert.throws(
    () => saveConfig({ repoRoot, fs, patch: { agent: { model: 'x' } } }),
    (err) => {
      assert.ok(err instanceof OsstrichError);
      assert.equal(err.code, 'CONFIG');
      return true;
    },
  );
});
