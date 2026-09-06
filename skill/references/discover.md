# Discover — Phases D1–D4 and the gate

`osstrich discover` answers "what should we contribute?" by reading THIS repo, not by browsing upstream trackers. Everything upstream is looked up only to match against something you already need. Started bare, `discover` runs through the gate and then continues into the build arc for each funded target after the usual green light; started as `osstrich discover` alone, it stops at the verdict table.

The repo is context for both modes, not just this one. `build` reads it too — to know whether a target retires one of your fork patches, which of your conditions reproduce the bug, and which of your own tests must stay green (`references/investigate.md` → Phase 0).

## Run directory — every phase writes its partial to disk

Before D1, create `<state dir>/osstrich/<YYYY-MM-DD>-<slug>-attempt-<N>/` (never inside the repo; a directory that already exists belongs to an earlier attempt — increment N). The state dir defaults to `~/.osstrich` and is overridden by `OSSTRICH_STATE_DIR`. `osstrich discover`'s four phases are the CLI verbs `inventory`, `rank`, `infer`, `upstream`, run in that order (D1 → D2 → the D3 "our side"/"their side" split across `infer`+`upstream`), and each writes its result there the moment it finishes: `inventory.json`; `rank.json` plus a rendered `rank.md`; `inferred.json`; `shortlist.json`; then a `verdict-template.md` (D4's blank table, names filled in, everything else for a session to complete) — the judgment stage that fills that table in later writes its own `verdict.json` and `verdict.md`, distinct files from the template. A killed session resumes from the newest partial instead of re-deriving; the verdict table you're shown is a copy of the file, not the only copy.

This needs no new dependency. The partials are plain files; the run's one-line record (fields below) is appended to `run-record.jsonl` in the same directory. If you keep a run ledger or similar record elsewhere, an adapter can also write a row there so a periodic audit can see that a run happened — the ledger row only marks that a run happened and when; the counts live in `run-record.jsonl` in the run directory — that's an optional integration, never a prerequisite of this skill: it is a runbook a session follows, not a daemon.

Run-record fields: `run_id`, `projects_inventoried`, `bottom_n`, `candidates`, `funded`, `deferred`, `give_back_only`, `gate_migrated`, `gate_upstream`, `prs_opened`, `review_rounds`, `fork_patches_retired`, `hand_patches_retired`, `started_at`, `finished_at`. Merge outcomes (`merged_at`, `days_to_merge`) are filled by the next run that visits the same repo note.

## D1 · Inventory — every project you run, from every source

One row per open-source project, with the version you run and upstream's latest. A package manifest is one source among many; the ones a manifest-only scan misses are exactly the ones that carry hand patches and forks. Read all of these:

| Source | What it holds | Where to look |
|---|---|---|
| Lock files | The version actually installed, per tree | every lock file in the repo — `npm ls` (or your package manager's equivalent) per tree resolves the truth, not the caret range in the manifest |
| Vendored binaries | Pinned release constants | your install/postinstall scripts |
| CI actions | SHA-pinned `uses:` lines with a version comment | `.github/workflows/**` |
| Container images | Exact image tags | your compose / infra files |
| Host installs | brew / `uv` / pinned-commit installs and their pins | your own install scripts and notes, wherever you keep them |
| Vendored skills | A vendored-from line with a date | skill file headers, if you use skills |
| Hand patches | Edits applied to `node_modules` (or the equivalent) after install | your own architecture notes, or any note that says "patched" |

Latest versions come from the registry (`https://registry.npmjs.org/<pkg>` dist-tags, `https://api.npmjs.org/downloads/point/last-week/<pkg>`) and GitHub (`gh api repos/<o>/<r>` for stars, pushed date, archived flag, owner type, open-issue count; `releases/latest` for non-npm tools). Record the GitHub repo per package from the registry's `repository` field; an archived upstream is a fact for D2, not a stop. Check the API allowance first (`gh api rate_limit`); the search endpoint allows 30 calls a minute and exhausts fast — use list endpoints, never search, for anything repeated per project.

Exclude infrastructure you run but never call (a database image, a cache image) with one line saying so; do not rank it.

## D2 · Rank — combined stars and downloads, community first

Two ranks per project, ascending (least popular first): one by GitHub stars, one by weekly downloads. The combined rank is their average. A project with no download figure (a binary, an action, an image) keeps its star rank alone. Downloads alone mislead — a helper pulled in transitively by popular build tools shows millions of weekly fetches at a hundred stars — which is why neither number ranks on its own.

Then classify every project:

| Class | Definition | Bias |
|---|---|---|
| community | Neither of the two below | Ranked as is |
| company | Authored by a for-profit company | Moves behind every community project |
| company-adjacent | Authored by the community to make a for-profit company's product more accessible — an MCP server, an API wrapper, a client SDK, a subscription or account tool for a vendor's product | Moves behind every community project |

Deferred, never removed. The default signal is the GitHub owner (an organization that is a company, a vendor's own org) and the project's purpose (does it exist to reach a vendor's product); the ruling per project lives in `references/classification.md` with its reason, and that file is read BEFORE classifying so two runs cannot rank the same project differently. Overrides live in the same file: a company-adjacent project you've ruled worth keeping ("helps users more than the company") stays eligible, with the ruling and date recorded on its row. A project not yet in the file gets a row this run, with its reason.

The bottom N of that ordering is where the effort goes. N is a count, stated ("the 10 smallest"), and is fixed per run (`--bottom`); a run that funds nothing is re-run with a larger N.

## D3 · Overlap — your next steps × their open items

Two inputs from your side, two from theirs. Both of yours run every time; only one of yours needs a backlog.

**Your next steps**
- **Explicit (optional).** A backlog if one exists: your tracker's open and parked items, a backlog file, a roadmap. If you don't keep a backlog, skip this box and lose nothing below.
- **Inferred (always).** Read from the repo itself, ecosystem-standard signals first so the inference works in any repo: a `patches/` folder (patch-package, pnpm `patchedDependencies`); `overrides` / `resolutions` in a manifest; an exact-pinned version with a comment beside it; a vendored copy of a library; TODO / FIXME / HACK / workaround lines that name a package; a test that pins a library quirk; a `// @ts-ignore` or `eslint-disable` next to a library call. Then your own notes: any doc entries that name a library's defect, "retire once X ships" notes, hand-patch lists. Grep for each library's name across the code and your notes, then filter to lines that say workaround, pin, patch, upstream, quirk, hang, race, silently, or cite an issue number. Every hit is an inferred next step whether or not anyone wrote a ticket for it.

**Their side**
- Their open issues and open PRs. For the bottom N, list titles, last-updated dates, and comment counts (one list call per repo, paginated); deep-read only the items that match a keyword from your next steps, plus the 10 most recently active. Past N, do not read titles at all: take your inferred next steps first, then look up only the upstream items that match them.
- **Cases you found that they have not been told.** A defect you verified against their source, a hand patch that fixes a live upstream issue, a workaround you carry for something with no upstream report. These are contributions even when no issue exists yet; the contribution may be the issue itself.

Cross-reference the two sides. An overlap is a specific upstream item (or a specific discovered case) that a specific next step of yours depends on. "We use this library" is not an overlap.

## D4 · Verdict — one table, fund only on overlap

One row per candidate: what it fixes for you, what it gives back, cost, who does it. Then the ruling:

| Ruling | Condition |
|---|---|
| Fund | Overlap exists AND at least one evidence box below is ticked |
| Defer | Overlap exists, no evidence box ticked, or the fix is out of proportion (finishing someone else's stalled multi-thousand-line PR) |
| Skip | No overlap |
| Give-back-only | Offered as candidates ONLY when nothing funds — a small fix you can make with no gain to you is a legitimate suggestion then, never a substitute for an overlapping one |

Evidence you hold, four boxes, ticked per candidate and shown in the table: **reproduction** (a failing test or a live repro against unpatched upstream), **patch** (a fix that exists, in a fork or a hand patch), **production run** (the fix has run in your own production for a stated period), **measurement** (a number that settles an open upstream debate).

Before assigning any funded item, check your own in-flight work on that repo (`gh api repos/<o>/<r>/pulls?state=all` filtered to your login) — a candidate you're already working elsewhere is not assignable. Verify every count and claim in the table against a primary source; a note that says "opened upstream" is a claim (`references/self-learning.md` → Keep the tracking claims honest).

Present the table. It is the one rulable thing; the arc waits on "go".

## The gate — is upstream the fix at all?

For every funded item, before entering the build arc, ask: **is there a different way of using the library, one that does not break your system, that makes the upstream fix optional?** The library may already have a hardened door you are not using, a supported option that avoids the defect, or a newer version with the fix.

Method, so the answer is a finding and not a guess: locate the library's public entry points in its source (the exported functions, the CLI commands), read the option handling at each one, and cite file and line for the option that avoids the defect — or for its absence. Documentation and an identifier's name are not evidence (a class called `Session` proved to make no network call). Then check what switching costs you: which of your own tests must stay green, which contract (precedence, hydration tracking, timeouts) the other door must still honor.

- **Yes** — the deliverable becomes your own migration (a PR in your own repo). The upstream item drops to give-back-only and stays on the table with that label; the repo note records the resolution so the next `discover` does not re-fund it.
- **No** — upstream is the fix; enter `references/investigate.md` at Phase 0 with the target named.

`build` mode passes through the same gate on its way in. Phase 2 can also send a target back here when live reproduction shows the defect is avoidable by a different use of the library.

Undo for everything above: discover writes only into its run directory; the table is the output.
