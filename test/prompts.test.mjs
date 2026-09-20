// lib/prompts.mjs is otherwise only exercised indirectly, through
// lib/cli-core.mjs's own discover/build test flows (always with an
// `owner/repo#n`-shaped target string) — this file unit-tests slugFor's
// other input shapes directly: a bare GitHub issue/PR URL (never hit
// through the CLI tests, which never pass one), a plain free-text target,
// the object-target shape a picked verdict row takes, and the two prompt
// builders' own template shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugFor, overlapVerdictGate, build } from '../lib/prompts.mjs';

test('slugFor: owner/repo#n form', () => {
  assert.equal(slugFor('acme/widget#42'), 'acme-widget-42');
});

test('slugFor: a bare GitHub issue/PR URL is parsed into the same owner-repo-number shape', () => {
  assert.equal(slugFor('https://github.com/acme/widget/issues/42'), 'acme-widget-42');
  assert.equal(slugFor('https://github.com/acme/widget/pull/7'), 'acme-widget-7');
});

test('slugFor: free text that matches neither pattern falls back to a plain slugified string', () => {
  assert.equal(slugFor('Fix the Frobnicator!!'), 'fix-the-frobnicator');
});

test('slugFor: nullish/empty input falls back to the literal "target"', () => {
  assert.equal(slugFor(), 'target');
  assert.equal(slugFor(null), 'target');
  assert.equal(slugFor(''), 'target');
  assert.equal(slugFor('###'), 'target');
});

test('slugFor: an object target (a picked verdict row) prefers .name, then .repo, then "target"', () => {
  assert.equal(slugFor({ name: 'Alpha Widget' }), 'alpha-widget');
  assert.equal(slugFor({ repo: 'acme/widget' }), 'acme-widget');
  assert.equal(slugFor({}), 'target');
});

test('slugFor: an object target whose .name is symbols-only slugifies to empty and falls back to "target"', () => {
  // Unlike the regex-matched forms (owner/repo#n, a github.com URL), an
  // object's .name/.repo carry no guaranteed alnum character — a
  // symbols-only name is the one input shape that actually reaches this
  // module's outer `|| 'target'` fallback.
  assert.equal(slugFor({ name: '###' }), 'target');
});

test('slugFor: every result is capped at 64 characters', () => {
  const long = 'x'.repeat(200);
  assert.equal(slugFor(long).length, 64);
  assert.equal(slugFor({ name: long }).length, 64);
});

test('overlapVerdictGate: names every phase partial and every output file under the given run/skill dirs', () => {
  const prompt = overlapVerdictGate({ runDir: '/runs/r1', skillDir: '/skill' });
  for (const path of ['/runs/r1/inventory.json', '/runs/r1/rank.md', '/runs/r1/inferred.json', '/runs/r1/shortlist.json', '/runs/r1/verdict.json', '/runs/r1/verdict.md']) {
    assert.ok(prompt.includes(path), `expected prompt to mention ${path}`);
  }
  assert.match(prompt, /SKILL\.md/);
  assert.match(prompt, /fund"\|"defer"\|"skip"\|"give-back"/);
});

test('build: a string target (osstrich build <target>) is described literally, no object fields', () => {
  const prompt = build({ runDir: '/runs/r1', skillDir: '/skill', target: 'acme/widget#42' });
  assert.match(prompt, /Target: acme\/widget#42/);
  assert.match(prompt, /Opened with osstrich · run r1/);
  assert.match(prompt, /build-acme-widget-42\.md/);
  assert.match(prompt, /prs_opened: N/);
});

test('build: an object target (a picked verdict row) is described field-by-field, with defaults for a missing evidence/gate', () => {
  const prompt = build({
    runDir: '/runs/r1',
    skillDir: '/skill',
    target: { name: 'alpha', repo: 'o/alpha', item: 'upstream issue #1', need: 'our workaround' },
  });
  assert.match(prompt, /name: alpha/);
  assert.match(prompt, /repo: o\/alpha/);
  assert.match(prompt, /item: upstream issue #1/);
  assert.match(prompt, /need: our workaround/);
  assert.match(prompt, /evidence: \[\]/);
  assert.match(prompt, /gate: none/);
  assert.match(prompt, /build-alpha\.md/);
});

test('build: an object target carrying real evidence/gate values prints them instead of the defaults', () => {
  const prompt = build({
    runDir: '/runs/r1',
    skillDir: '/skill',
    target: { name: 'alpha', repo: 'o/alpha', item: 'x', need: 'y', evidence: ['reproduction', 'patch'], gate: 'upstream' },
  });
  assert.match(prompt, /evidence: \["reproduction","patch"\]/);
  assert.match(prompt, /gate: upstream/);
});
