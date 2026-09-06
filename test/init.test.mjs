import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run as initRun } from '../lib/commands/init.mjs';
import { createFakeFs } from './helpers/fake-fs.mjs';
import { createSink, createFakePrompts } from './helpers/fake-io.mjs';

const repoRoot = '/repo';
const homedir = '/home/tester';

function makeExec(found) {
  return async (name) => {
    if (found.has(name)) return { exitCode: 0 };
    const err = new Error(`ENOENT: ${name}`);
    err.code = 'ENOENT';
    throw err;
  };
}

function baseDeps(overrides = {}) {
  return {
    fs: createFakeFs(),
    env: {},
    stdout: createSink(),
    stderr: createSink(),
    prompts: createFakePrompts(),
    homedir,
    cwd: repoRoot,
    exec: makeExec(new Set()),
    ...overrides,
  };
}

test('init --yes with every tool found writes the detected agent command', async () => {
  const stdout = createSink();
  const deps = baseDeps({
    exec: makeExec(new Set(['gh', 'gitleaks', 'dotenvx', 'claude'])),
    stdout,
  });

  const code = await initRun(['--yes'], deps);

  assert.equal(code, 0);
  assert.match(stdout.text, /gh: found/);
  assert.match(stdout.text, /gitleaks: found/);
  assert.match(stdout.text, /dotenvx: found/);
  assert.match(stdout.text, /agent: claude \(claude -p\)/);

  const saved = JSON.parse(deps.fs.readFileSync('/repo/.osstrich.json'));
  assert.equal(saved.agent.command, 'claude -p');
  assert.equal(saved.agent.model, undefined);

  // dotenvx itself was found on PATH, so the hint uses `dotenvx set`.
  assert.match(stdout.text, /OSSTRICH_MODEL unset: dotenvx set OSSTRICH_MODEL value/);
  assert.match(stdout.text, /ANTHROPIC_API_KEY unset: dotenvx set ANTHROPIC_API_KEY value/);
});

test('init hints "add NAME= to .env" when dotenvx itself is not on PATH', async () => {
  const stdout = createSink();
  const deps = baseDeps({
    exec: makeExec(new Set(['gh', 'gitleaks', 'claude'])),
    stdout,
  });

  const code = await initRun(['--yes'], deps);

  assert.equal(code, 0);
  assert.match(stdout.text, /dotenvx: not found/);
  assert.match(stdout.text, /OSSTRICH_MODEL unset: add OSSTRICH_MODEL= to \.env/);
  assert.match(stdout.text, /ANTHROPIC_API_KEY unset: add ANTHROPIC_API_KEY= to \.env/);
});

test('init --yes with nothing found writes no agent block and reports every tool missing', async () => {
  const stdout = createSink();
  const deps = baseDeps({ stdout });

  const code = await initRun(['--yes'], deps);

  assert.equal(code, 0);
  assert.match(stdout.text, /gh: not found/);
  assert.match(stdout.text, /gitleaks: not found/);
  assert.match(stdout.text, /dotenvx: not found/);
  assert.match(stdout.text, /agent: not found/);

  const saved = JSON.parse(deps.fs.readFileSync('/repo/.osstrich.json'));
  assert.equal(saved.agent, undefined);
  // No agent tool means no provider variable to report on.
  assert.doesNotMatch(stdout.text, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(stdout.text, /OPENAI_API_KEY/);
});

test('init detects an already-encrypted .env and uses the dotenvx hint form', async () => {
  const fs = createFakeFs({
    '/repo/.env.keys': 'DOTENV_PRIVATE_KEY=xxx\n',
  });
  const stdout = createSink();
  const deps = baseDeps({
    fs,
    stdout,
    exec: makeExec(new Set(['dotenvx', 'codex'])),
  });

  const code = await initRun(['--yes'], deps);

  assert.equal(code, 0);
  assert.match(stdout.text, /dotenvx: found \(encrypted \.env detected\)/);
  assert.match(stdout.text, /agent: codex \(codex exec\)/);
  assert.match(stdout.text, /OPENAI_API_KEY unset: dotenvx set OPENAI_API_KEY value/);
});

test('init never prints or writes an env value, only names of missing vars', async () => {
  const stdout = createSink();
  const deps = baseDeps({
    stdout,
    env: { ANTHROPIC_API_KEY: 'sk-super-secret', OSSTRICH_MODEL: 'sonnet' },
    exec: makeExec(new Set(['claude'])),
  });

  const code = await initRun(['--yes'], deps);

  assert.equal(code, 0);
  assert.doesNotMatch(stdout.text, /sk-super-secret/);
  assert.doesNotMatch(stdout.text, /unset/); // both are set, so no hints at all
});

test('init interactive cancel exits 2 and writes nothing', async () => {
  const fs = createFakeFs();
  const deps = baseDeps({
    fs,
    prompts: createFakePrompts({ cancelOnCall: 1 }),
  });

  const code = await initRun([], deps);

  assert.equal(code, 2);
  assert.equal(fs.existsSync('/repo/.osstrich.json'), false);
});

test('init interactive cancel on the second question (model) also exits 2 and writes nothing', async () => {
  const fs = createFakeFs();
  const deps = baseDeps({
    fs,
    exec: makeExec(new Set(['claude'])),
    prompts: createFakePrompts({ cancelOnCall: 2 }),
  });

  const code = await initRun([], deps);

  assert.equal(code, 2);
  assert.equal(fs.existsSync('/repo/.osstrich.json'), false);
});

test('init interactive accepts typed answers over the detected defaults', async () => {
  const fs = createFakeFs();
  const deps = baseDeps({
    fs,
    exec: makeExec(new Set(['claude'])),
    prompts: createFakePrompts({ textAnswers: ['aider', 'gpt-5'] }),
  });

  const code = await initRun([], deps);

  assert.equal(code, 0);
  const saved = JSON.parse(fs.readFileSync('/repo/.osstrich.json'));
  assert.equal(saved.agent.command, 'aider');
  assert.equal(saved.agent.model, 'gpt-5');
});
