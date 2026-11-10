import { test } from 'node:test';
import assert from 'node:assert/strict';
import realFs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { run as envRun } from '../lib/commands/env.mjs';
import { createFakeFs } from './helpers/fake-fs.mjs';
import { createSink, createFakePrompts } from './helpers/fake-io.mjs';

const repoRoot = '/repo';
const homedir = '/home/tester';
const SECRET = 'ghp_totallySecretToken123';

function baseDeps(overrides = {}) {
  return {
    fs: createFakeFs(),
    env: {},
    stdout: createSink(),
    stderr: createSink(),
    prompts: createFakePrompts(),
    exec: async () => ({ exitCode: 0 }),
    homedir,
    cwd: repoRoot,
    ...overrides,
  };
}

test('env list never prints a value, only presence', async () => {
  const stdout = createSink();
  const deps = baseDeps({
    stdout,
    env: { OSSTRICH_STATE_DIR: '/x', GH_TOKEN: SECRET },
  });

  const code = await envRun(['list'], deps);

  assert.equal(code, 0);
  assert.match(stdout.text, /OSSTRICH_STATE_DIR set/);
  assert.match(stdout.text, /OSSTRICH_MODEL unset/);
  assert.match(stdout.text, /OSSTRICH_AGENT unset/);
  assert.match(stdout.text, /GH_TOKEN set/);
  assert.doesNotMatch(stdout.text, /[=]/);
  assert.doesNotMatch(stdout.text, new RegExp(SECRET));
});

test('env list adds the configured agent\'s provider variable', async () => {
  const fs = createFakeFs({ '/repo/.osstrich.json': JSON.stringify({ agent: { command: 'claude -p' } }) });
  const stdout = createSink();
  const deps = baseDeps({ fs, stdout });

  const code = await envRun(['list'], deps);

  assert.equal(code, 0);
  assert.match(stdout.text, /ANTHROPIC_API_KEY unset/);
});

test('env set shells out to dotenvx when the repo already uses it', async () => {
  const fs = createFakeFs({ '/repo/.env.keys': 'DOTENV_PRIVATE_KEY=x\n' });
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return { exitCode: 0 };
  };
  const deps = baseDeps({ fs, exec });

  const code = await envRun(['set', 'OPENAI_API_KEY', 'sk-abc'], deps);

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'dotenvx');
  assert.deepEqual(calls[0].args, ['set', 'OPENAI_API_KEY', 'sk-abc']);
  // The plain .env file was left completely alone.
  assert.equal(fs.existsSync('/repo/.env'), false);
});

test('env set edits .env directly when dotenvx is not in use, preserving other lines', async () => {
  const fs = createFakeFs({
    '/repo/.env': '# a comment\nFOO=bar\n\nBAZ=qux\n',
  });
  const deps = baseDeps({ fs });

  const code = await envRun(['set', 'BAZ', 'new-value'], deps);

  assert.equal(code, 0);
  const text = fs.readFileSync('/repo/.env');
  assert.equal(text, '# a comment\nFOO=bar\n\nBAZ=new-value\n');
});

test('env set appends a new var without disturbing existing lines', async () => {
  const fs = createFakeFs({
    '/repo/.env': '# a comment\nFOO=bar\n',
  });
  const deps = baseDeps({ fs });

  const code = await envRun(['set', 'NEW_VAR', 'hello'], deps);

  assert.equal(code, 0);
  const text = fs.readFileSync('/repo/.env');
  assert.equal(text, '# a comment\nFOO=bar\nNEW_VAR=hello\n');
});

// Real git in a real temporary folder: git alone knows what it would track.
async function realGitCase({ isGitRepo, ignoreLine }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'osstrich-env-'));
  // Stop git walking up into any checkout that holds the temporary folder.
  const gitEnv = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = gitEnv.GIT_CEILING_DIRECTORIES;
  try {
    if (isGitRepo) {await execa('git', ['init', '-q'], { cwd: dir, env: gitEnv });}
    if (ignoreLine) {writeFileSync(path.join(dir, '.gitignore'), `${ignoreLine}\n`);}
    const stdout = createSink();
    const stderr = createSink();
    const code = await envRun(['set', 'API_KEY', 'made-up-value'], {
      ...baseDeps({ stdout, stderr }), fs: realFs, exec: execa, cwd: dir,
    });
    const envPath = path.join(dir, '.env');
    return { code, stderr, written: existsSync(envPath) ? readFileSync(envPath, 'utf8') : null };
  } finally {
    if (previous === undefined) {delete process.env.GIT_CEILING_DIRECTORIES;} else {process.env.GIT_CEILING_DIRECTORIES = previous;}
    rmSync(dir, { recursive: true, force: true });
  }
}

test('env set writes nothing and fails when git would track .env', async () => {
  const { code, stderr, written } = await realGitCase({ isGitRepo: true });
  assert.equal(code, 1);
  assert.equal(written, null);
  assert.match(stderr.text, /add `\.env` to \.gitignore/);
});

test('env set writes .env once .gitignore lists it', async () => {
  const { code, written } = await realGitCase({ isGitRepo: true, ignoreLine: '.env' });
  assert.equal(code, 0);
  assert.equal(written, 'API_KEY=made-up-value\n');
});

test('env set writes .env outside a git work tree, as before', async () => {
  const { code, written } = await realGitCase({ isGitRepo: false });
  assert.equal(code, 0);
  assert.equal(written, 'API_KEY=made-up-value\n');
});

test('env set treats a missing git as safe and any odd git result as not ignored', async () => {
  const run = async (exec) => {
    const fs = createFakeFs();
    const code = await envRun(['set', 'K', 'v'], baseDeps({ fs, exec }));
    return { code, wrote: fs.existsSync('/repo/.env') };
  };
  assert.deepEqual(await run(async () => ({ failed: true, code: 'ENOENT' })), { code: 0, wrote: true });
  assert.deepEqual(await run(async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }), { code: 0, wrote: true });
  assert.deepEqual(await run(async () => ({ exitCode: 3 })), { code: 1, wrote: false });
});

test('env set prompts with a masked password when no value is given', async () => {
  const fs = createFakeFs();
  const prompts = createFakePrompts({ passwordAnswer: 'typed-secret' });
  const deps = baseDeps({ fs, prompts });

  const code = await envRun(['set', 'SOME_TOKEN'], deps);

  assert.equal(code, 0);
  const text = fs.readFileSync('/repo/.env');
  assert.equal(text, 'SOME_TOKEN=typed-secret\n');
});

test('env set cancel exits 2 and writes nothing', async () => {
  const fs = createFakeFs();
  const prompts = createFakePrompts({ cancelOnCall: 1 });
  const deps = baseDeps({ fs, prompts });

  const code = await envRun(['set', 'SOME_TOKEN'], deps);

  assert.equal(code, 2);
  assert.equal(fs.existsSync('/repo/.env'), false);
});

test('env set with no name exits 2', async () => {
  const stderr = createSink();
  const deps = baseDeps({ stderr });
  const code = await envRun(['set'], deps);
  assert.equal(code, 2);
  assert.match(stderr.text, /usage: osstrich env set/);
});

test('an unknown env subcommand exits 2', async () => {
  const stderr = createSink();
  const deps = baseDeps({ stderr });
  const code = await envRun(['frob'], deps);
  assert.equal(code, 2);
  assert.match(stderr.text, /usage: osstrich env <list\|set>/);
});
