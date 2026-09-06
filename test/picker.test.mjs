import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCandidates, orderCandidates, isFunded } from '../lib/picker.mjs';
import { createSink, createFakePrompts } from './helpers/fake-io.mjs';

const rows = [
  { name: 'lib-a', ruling: 'fund', evidence: 2, combinedRank: 5 },
  { name: 'lib-b', ruling: 'fund', evidence: 3, combinedRank: 9 },
  { name: 'lib-c', ruling: 'fund', evidence: 3, combinedRank: 1 },
  { name: 'lib-d', ruling: 'defer', evidence: 5, combinedRank: 1 },
];

test('orderCandidates sorts by evidence desc, then combinedRank asc (funding is not its job)', () => {
  // lib-d has the most evidence of all four rows, funded or not — ordering
  // is purely evidence/rank; pickCandidates is what filters to funded rows.
  const ordered = orderCandidates(rows);
  assert.deepEqual(
    ordered.map((r) => r.name),
    ['lib-d', 'lib-c', 'lib-b', 'lib-a'],
  );

  const fundedOnly = orderCandidates(rows.filter(isFunded));
  assert.deepEqual(
    fundedOnly.map((r) => r.name),
    ['lib-c', 'lib-b', 'lib-a'],
  );
});

test('isFunded is true only for "fund" rulings', () => {
  assert.equal(isFunded(rows[0]), true);
  assert.equal(isFunded(rows[3]), false);
});

test('headless picks the single best funded row', async () => {
  const stdout = createSink();
  const chosen = await pickCandidates({ rows, headless: true, prompts: createFakePrompts(), stdout });
  assert.deepEqual(
    chosen.map((r) => r.name),
    ['lib-c'],
  );
});

test('headless with nothing funded returns [] and prints the reason', async () => {
  const stdout = createSink();
  const chosen = await pickCandidates({
    rows: [{ name: 'lib-d', ruling: 'defer', evidence: 5, combinedRank: 1 }],
    headless: true,
    prompts: createFakePrompts(),
    stdout,
  });
  assert.deepEqual(chosen, []);
  assert.match(stdout.text, /no funded candidate/);
});

test('interactive renders the table and returns the multiselect result', async () => {
  const stdout = createSink();
  const prompts = createFakePrompts({ multiselectAnswer: ['lib-a', 'lib-b'] });
  const chosen = await pickCandidates({ rows, headless: false, prompts, stdout });

  assert.match(stdout.text, /lib-a/);
  assert.match(stdout.text, /combinedRank|rank/); // header present in some form
  assert.deepEqual(
    chosen.map((r) => r.name).sort(),
    ['lib-a', 'lib-b'],
  );
});

test('interactive cancel returns []', async () => {
  const stdout = createSink();
  const prompts = createFakePrompts({ cancelOnCall: 1 });
  const chosen = await pickCandidates({ rows, headless: false, prompts, stdout });
  assert.deepEqual(chosen, []);
});

test('interactive with nothing funded skips the prompt and reports it', async () => {
  const stdout = createSink();
  const prompts = createFakePrompts();
  const chosen = await pickCandidates({
    rows: [{ name: 'lib-d', ruling: 'defer', evidence: 5, combinedRank: 1 }],
    headless: false,
    prompts,
    stdout,
  });
  assert.deepEqual(chosen, []);
  assert.match(stdout.text, /no funded candidate/);
});
