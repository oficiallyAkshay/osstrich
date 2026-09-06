# PR etiquette — Phase 5, and every outward-facing action

## Where etiquette runs — three checkpoints, not a background lane

| When | What etiquette does there |
|---|---|
| Phase 1, scouting | Learns their norms: contributing file if any, how the maintainer writes and reviews, what merged fast and what sat, which bots review, who else is working the same bug |
| Phase 5, writing | Writes in those norms: their commit style, their changelog rule, symptom before cause, competing PRs named fairly, thanks only if earned, everything scrubbed. Then the green light, then open |
| After opening, until merge | Handles the conversation: a bot review is fixed then confirmed, a maintainer's question answered in their shape, a competing PR that wins gets a graceful defer |

Nothing etiquette-shaped happens during Phases 0, 2, 3, or 4 — those are private work in your own fork.

## Writing style — brevity and structure over prose

- **Symptom, then root cause, then divergence, then scope, then testing.** A reader (the maintainer) should understand what breaks before they read why — don't open with the mechanism.
- **Cut on every pass, not once.** A first draft is allowed to be long; a body shown for review should already be shorter than the first draft, and a body shown a second time (after feedback) should be shorter still. If a section restates something the previous section already established, delete it rather than rephrasing it.
- **One clearly-labeled thank-you, if one is earned — and it has to actually say thank you.** Describing what makes a project valuable is not gratitude; "thank you for X" (or an unambiguous equivalent) naming a specific, real thing is. A note that only describes value, however well-observed, is not a thank-you note and will read as one more feature pitch. When genuinely thanking a maintainer, keep it short and specific: what effort are you grateful for, and what did it save you — not a design critique with "thanks" bolted to the front.
- **No connective throat-clearing.** "I wanted to explain my reasoning before diving in" is throat-clearing; just state the reasoning where it belongs.
- **Tables for parallel comparisons, prose for a single line of argument.** A "here's their approach vs. ours" comparison is a table's shape; a root-cause explanation is prose. Don't force one into the other's structure.

## Inventory the maintainer's usual asks, and answer them explicitly

Phase 1's maintainer-pattern scout built a checklist of what this specific maintainer routinely asks for — and, if a review bot is active on the repo, a second checklist of what it routinely flags. Before finishing the PR body, check the draft against BOTH directly — not from memory — and make sure each item is either satisfied and stated, or explicitly not applicable and said so. A maintainer who has a known pattern of asking "did you verify this live?" should read a body that already answers that question, not one that waits for them to ask; a bot that always flags a missing test class should meet a diff that already has one, not a diff that gets fixed after the bot says so.

## Competing approaches

When another open PR targets the same issue:

- Read it and, where feasible, test it — not just its diff. State plainly why your approach differs, using verified behavior, not a stylistic preference.
- Name the concrete failure mode of the competing approach if one exists, without editorializing about the other contributor. "This routes through X, which needs interactive authorization in condition Y" is a finding; "this is the wrong way to do it" is not.
- Offer to defer if the maintainer is already leaning toward the other PR. The goal is the bug getting fixed well, not authorship.

## Scrubbing — every draft, before it's shown or pushed

Check every one of these, every time, not just when something seems sensitive:

- **Your own internal system names** (your product/agent names, internal file paths, internal tooling) — grep the actual diff and PR body text for them; don't rely on having "kept them out" by intention alone.
- **The contributor's own specific use case or infrastructure**, unless it's explicitly fine to include. A generic, tool-scoped reason for hitting the bug is fine; describing the private system it's embedded in is not, even if it feels like helpful color.
- **Personal contact information** — none belongs in a PR body, ever.
- **AI attribution stays.** The `Co-Authored-By` trailer on commits and the generated-with footer on the PR body are kept, not scrubbed, unless Phase 1's repo-conventions scout found a stated policy on AI-assisted contributions — then that policy wins, either way (ruled 2026-09-06).
- **The PR body ends with one marker line: `Opened with osstrich · run <run id>`**, where the run id is the run directory's name (for example `2026-09-06-battle2-attempt-1`). It sits beside the generated-with footer and is never removed. It is the only way contributions made with this skill can be counted later across every repo with a single search, so a PR without it is not finished.
- **Commit author/committer identity.** After every commit or amend meant to represent an external GitHub identity, verify the actual resulting `%an <%ae>` — a machine's own global git config can silently substitute its own identity (including a hostname) during an amend. Fix it explicitly with `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` if it's wrong; don't assume `--reset-author` alone corrected it without checking.

## What needs a green light and what doesn't

- **Needs an explicit go, every time:** opening the pull request, pushing a branch to a fork where it becomes visible attached to an open PR, posting any comment, requesting a review.
- **Doesn't need a fresh go, once the plan and PR body have been shown and approved:** rebasing onto a newer upstream, running the test suite, tightening prose, fixing something the maintainer's own review flags after the PR is open (unless the fix changes the plan materially — then check back in).
- **Pushing a branch to a fork with no PR attached yet** is lower-stakes than opening the PR itself (it's not linked, not notified, not visible in the repo's PR list) — reasonable to do as prep once a plan is approved, but the PR-open step itself still waits for its own explicit go.

## A bot reviewer's comment is feedback to address, not a thread to close on its own

A PR may pick up an automated review bot (Greptile, CodeRabbit, or similar — see `references/investigate.md`'s maintainer-pattern scout for telling one apart from the human maintainer). Treat its findings the same as any reviewer's: fix whatever's actually valid in the code, and re-run the real tests to prove it. That part doesn't need a fresh go — it's the same "fixing something a review flags" case above.

**Marking the bot's thread resolved, replying to it, or issuing its own re-review/re-check command (e.g. `@botname re-review`) is still posting a comment** — same green light as any other comment, no exception for a bot on the other end. Don't auto-resolve a bot thread just because the underlying code got fixed; say what changed and let the maintainer of this run decide whether and how to close the loop with it.
