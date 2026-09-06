# Capture — Phase 6

Phase 6 folds a just-finished contribution's learnings back in. If you keep a general-purpose learning pass elsewhere in your own setup, this is an optional adapter into it — dispatch it once, as its own fresh-context pass, handing over the run record, and apply what it returns. It is never a prerequisite: without one, do Phase 6 by hand using the same shape below.

What gets handed over (to a learning pass, or worked through by hand): the run record (the verdict row if one exists, the scout findings, the reproduction, the diff, the PR and its review threads, every outward message) and the noticed candidates. Two kinds of destination:

- **A repo-agnostic technique or failure mode** goes into this skill's own `SKILL.md` / `references/*.md`.
- **A fact about one external repo** goes into `references/repos/<repo>.md`.

Everything else worth keeping — a stale claim in your own docs, a rule for your own conventions, a backlog item, a follow-up note — takes whatever route you'd normally use for that.

Two things to re-check on every run here: every "retire once X ships / tracked upstream / opened as a PR" claim the run touched, against the real PR, issue, or release list (see Keep the tracking claims honest below); and whether a candidate resolved on your side at the gate, so the repo note records it and the next `discover` does not re-fund it.

## What the repo note holds

This closes the loop Phase 1 opened: Phase 1 read `references/repos/<repo>.md` last, to reconcile against the scouts' fresh findings, never as a starting point; Phase 6 writes the reconciled result back, so the next visit's reconciliation starts from what this one actually confirmed rather than from what an earlier visit assumed. After a PR is opened, a fork patch is confirmed retired, or a candidate resolves on your side at the gate, `references/repos/<repo>.md` is updated. If the file doesn't exist yet, it is created with this shape:

Name the file after the real upstream repo, always — never the fork, even when every scout's work actually happened against a fork checkout. If you vendor a fork, its one mention is the opening line naming it as the fork; everything else in the file describes upstream.

```markdown
# <org>/<repo>   ← the real upstream repo — never name this file after your fork

## Conventions found
- Written guide: <CONTRIBUTING.md / AGENTS.md / PR template found, or "none — inferred from maintainer history">
- Commit style: <e.g. conventional commits, scope required, issue number referenced>
- Contribution policy: <CLA/DCO required? stated position on AI-assisted contributions, or "none stated">
- Changelog convention: <contributor adds their own entry, or maintainer adds one on merge>
- CI shape: <jobs, platforms, what's mocked vs. real, the most-specific job worth running locally>
- Test placement: <where tests for a given area live; whether new files are normal or unusual here>

## Maintainer patterns (only if no written guide exists)
- What they routinely ask for that isn't already provided
- What they've rejected, and why
- Tone on a clean merge vs. a requested-changes review
- Bot reviewers in the loop, if any, and how to tell them apart from the human maintainer

## Our history here
- <date> — <PR link>, <one line: what it fixed, merged/open/status>
- Fork provenance, if any: <fork repo>, patch(es) carried, retire condition, last verified <date>

## Open threads
- <anything still pending — a competing PR to watch, a fork patch waiting on this merging>
```

Keep it as short as the template implies. This is a cache for the next visit, not a narrative. Every line that states upstream state — a PR open or merged, a release shipped, a maintainer's stance, a policy found — carries its last-verified date in parentheses; a line without one is a claim nobody can age.

## Keep the tracking claims honest

A "tracked for upstream merge" or "opened as an upstream PR" line is a claim about *external* state — it goes stale the moment someone doesn't check back. This already happened once: a repo note asserted three patches were "each also opened as an upstream PR against the source repo," and when checked directly against the real PR list, that was false for at least one of them — nothing had caught the drift because nothing had re-verified it.

So: every time Phase 0 finds an existing repo-notes file (or an existing fork-provenance note anywhere in your own docs) claiming something is "open," "merged," or "tracked," re-verify it against the actual PR/issue list before repeating it in a plan or a status update. If it's stale, correct the source file as part of this run's own capture step, not as a someday cleanup.

## Growing the general rules

Most of what a run learns is repo-specific and belongs only in `references/repos/<repo>.md`. Something belongs in this skill's own `SKILL.md` or other `references/*.md` files instead only when it would have applied identically at a *different* repo — a genuinely repo-agnostic technique or failure mode, not a fact about this one project. Before adding one, check whether it's already covered; a rule that only restates something already stated elsewhere in this skill is noise, not a discovery.

## Parallelism in Phase 6

One capture pass per session close, whatever the number of contributions — it (or you, working through it by hand) sees every repo's record at once, which is what lets it consolidate. Applying the resulting edits (several repo-notes files, a rule line) is independent per file and runs in parallel.

## Parallelism and subagent technique, generally

- **The Phase 1 scout wave is the default shape for investigation, not a special case.** Three independent questions (repo conventions, discussion history, maintainer patterns) have no dependency on each other — dispatch them together, fresh and blind. Reconciling against your own prior notes is a separate, later step, done once after they join, not a fourth parallel stream. Serial scouting needs a stated reason.
- **A subagent's finding is a claim, not a fact, until you verify it yourself.** This applies as much to a scout summarizing "this maintainer always asks for X" as it does to a builder claiming tests pass — check the cited PR/comment yourself before it goes into a plan or a PR body.
- **Reserve a full multi-agent build swarm for genuinely large contributions** — a fix touching several files across an unfamiliar codebase, or several independent contributions in one sitting. A single-file, well-scoped fix (the common case) doesn't need more than the Phase 1 scout wave plus a normal build-and-verify pass; matching swarm size to the actual size of the problem is itself part of doing this well, not a shortcut.
