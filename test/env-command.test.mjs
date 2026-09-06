import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.doesNotMatch(stdout.text, /=/);
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
