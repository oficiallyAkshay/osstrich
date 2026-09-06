import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOLS, PROVIDER_VAR, headlessCommandFor, toolForCommand } from '../lib/agent-registry.mjs';

test('claude and codex get their headless flags, others are bare', () => {
  assert.equal(headlessCommandFor('claude'), 'claude -p');
  assert.equal(headlessCommandFor('codex'), 'codex exec');
  assert.equal(headlessCommandFor('openhands'), 'openhands');
  assert.equal(headlessCommandFor('aider'), 'aider');
});

test('toolForCommand recovers the tool name from a resolved command', () => {
  assert.equal(toolForCommand('claude -p'), 'claude');
  assert.equal(toolForCommand('codex exec'), 'codex');
  assert.equal(toolForCommand('aider'), 'aider');
  assert.equal(toolForCommand('some-unknown-thing --flag'), null);
  assert.equal(toolForCommand(null), null);
});

test('every agent tool with a provider variable is a known tool', () => {
  for (const tool of Object.keys(PROVIDER_VAR)) {
    assert.ok(AGENT_TOOLS.includes(tool));
  }
});
