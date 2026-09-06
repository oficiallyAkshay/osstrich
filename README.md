# osstrich

The bird that takes its head out of the sand.

You depend on a few hundred open-source projects. Some are tiny, tired, and one bug away from ruining your week. osstrich reads *your* repo, finds the libraries where your next step and their open issue are the same thing, and helps you fix it upstream the way the maintainer would have.

Two moves:

- **`osstrich discover`** — inventory every project you run, rank the least popular first (community before company), cross your backlog and your workarounds against their open issues, and hand you one table: fund, defer, skip.
- **`osstrich build <repo | issue | patch>`** — scout the repo's real norms, write the failing test first, ship the smallest fix, in their voice, with your name on it.

A gate in between asks the question most people skip: *is there a way to use the library that makes the fix optional?* Often there is, and then the fix becomes a gift instead of a chore.

What it is: a runbook for an AI coding agent, plus a few deterministic scripts for the parts that should never need judgment (the inventory, the ranking, the scrub, the "did that upstream fix ship yet" check).

What it is not: a bot that spams maintainers. Every outward action waits for a human "go".

**Why the name.** OSS + ostrich. Also OSS-t-rich: give back until the commons is rich.

**Status.** Extracted from a private repo where it has shipped three upstream pull requests. Being sanitized for public use; expect rough edges and a moving phase map.

## How it thinks

Each box carries a tag: `code` runs the same way twice with no model in it; `AI` is a judgment; `human` is the only one who posts anything.

### 1. Discover — "what should we contribute?"

```
   ┌────────────────────────────────────────────────────────┐
   │ YOUR REPO → THE LIBRARY LIST                    [code] │
   │ Q: what do we run?  7 readers at once: locks, pins,    │
   │    actions, images, host installs, skills, patches     │
   └─────────┬───────────────────┬───────────────────┬──────┘
             │  three branches at once, none waits   │
             ▼                   ▼                   ▼
 ┌────────────────────┐ ┌─────────────────────┐ ┌────────────────────┐
 │ POPULARITY  [code] │ │ OUR NEEDS    [code] │ │ THEIR ITEMS [code] │
 │ Q: how far behind, │ │ Q: what is our next │ │ Q: what are they   │
 │    how loved, who  │ │    step with it?    │ │    stuck on?       │
 │    owns it?        │ │                     │ │ A: open issues and │
 │ A: registry ‖      │ │  explicit ‖ inferred│ │    PRs, one worker │
 │    GitHub lookups  │ │  ┌────────┐┌──────┐ │ │    per library,    │
 │    for every row   │ │  │ board  ││ pins,│ │ │    every library;  │
 │         │          │ │  │ items, ││patch-│ │ │    budget checked  │
 │         ▼          │ │  │ if you ││ es,  │ │ │    per batch       │
 │ RANK               │ │  │ have a ││TODOs,│ │ │                    │
 │ Q: who will nobody │ │  │ board  ││retire│ │ │                    │
 │    else fix?       │ │  │        ││ notes│ │ │                    │
 │ A: stars+downloads │ │  └────────┘└──────┘ │ │                    │
 │    averaged, comm- │ │  no board → still   │ │                    │
 │    unity first →   │ │  works, inferred    │ │                    │
 │    bottom N        │ │  alone              │ │                    │
 └─────────┬──────────┘ └──────────┬──────────┘ └─────────┬──────────┘
           └──────────────────────┬┴─────────────────────┘
                                  ▼ join
   ┌────────────────────────────────────────────────────────┐
   │ OVERLAP                                          [AI]  │
   │ Q: is this need of ours really this item of theirs,   │
   │    or a bug we found they were never told about?      │
   │ order and depth from RANK: bottom N read in full,     │
   │ the rest keyword-only                                 │
   │ A: candidates, one need to one item each              │
   └───────────────────────────┬────────────────────────────┘
                               ▼ candidates judged in parallel
   ┌────────────────────────────────────────────────────────┐
   │ VERDICT                                          [AI]  │
   │ fund = overlap + evidence   defer = no evidence yet   │
   │ skip = no overlap           gift = only if none fund  │
   └───────────────────────────┬────────────────────────────┘
                               ▼ one gate per funded item, at once
   ╔════════════════════════════════════════════════════════╗
   ║ GATE                                             [AI]  ║
   ║ Q: another way to use the library that makes the      ║
   ║    upstream fix optional?                             ║
   ║ yes → fix our side; the item becomes a gift           ║
   ║ no  → upstream is the fix                             ║
   ╚═══════════════════════════╤════════════════════════════╝
                               ▼
                    the table, written to disk         [code]
                    ┌──────────┴──────────┐
                    ▼                     ▼
          human "go"  [human]      persist and stop
          → BUILD on the top       (a later `build`
            funded item, one       picks any row up)
            worker per target
```

### 2. Build — "contribute this one"

```
   ┌────────────────────────────────────────────────────────┐
   │ THE TARGET                                        [AI] │
   │ Q: which repo, what breaks, for whom? a patch we carry?│
   └────┬─────────────┬─────────────┬──────────────┬────────┘
        │             │             │              │   four at once
        ▼             ▼             ▼              ▼
   ┌─────────┐  ┌───────────┐ ┌───────────┐ ┌────────────────┐
   │ rules   │  │ discussion│ │ maintainer│ │ STILL BROKEN?  │
   │  [AI]   │  │  [AI]     │ │  [AI]     │ │  [code]        │
   │ guide,  │  │ tried     │ │ asks,     │ │ run their tests│
   │ CI, lint│  │ before?   │ │ rejects,  │ │ on latest;     │
   │         │  │ rival PR? │ │ merges?   │ │ no → stop      │
   └────┬────┘  └─────┬─────┘ └─────┬─────┘ └───────┬────────┘
        └─────────────┴──────┬──────┴───────────────┘
                             ▼ join; live beats our old notes
   ┌────────────────────────────────────────────────────────┐
   │ HOW THEY WORK  +  a 4th scout for what 3 missed   [AI] │
   └───────────────────────────┬────────────────────────────┘
                               ▼ serial by design
   ┌────────────────────────────────────────────────────────┐
   │ FAILING TEST                              [AI writes, │
   │ in their shape; run: red on their code    code runs]  │
   └───────────────────────────┬────────────────────────────┘
                               ▼ only once it is red
   ┌────────────────────────────────────────────────────────┐
   │ FIX: smallest change that removes the cause       [AI] │
   └────────┬──────────────────┬───────────────────┬────────┘
            │                  │                   │   three proofs at once
            ▼                  ▼                   ▼
   ┌──────────────┐  ┌──────────────────┐  ┌───────────────┐
   │ full suite   │  │ strictest CI job │  │ SCRUB  [code] │
   │   [code]     │  │   [code]         │  │ anything      │
   │ all green?   │  │ green there?     │  │ private?      │
   └──────┬───────┘  └────────┬─────────┘  └───────┬───────┘
          └───────────────────┼────────────────────┘
                              ▼ join: counts, clean  (PR body drafts meanwhile)
   ┌────────────────────────────────────────────────────────┐
   │ THE PR                                            [AI] │
   │ Q: would the maintainer have written it this way?     │
   └───────────────────────────┬────────────────────────────┘
                               ▼
              human "go" ──▶ opened ──▶ reviews answered    [human]
```

### 3. Capture — "what should next time know?"

```
   ┌────────────────────────────────────────────────────────┐
   │ after the PR is open, or the fix landed on our side    │
   └────────────────┬──────────────────────┬────────────────┘
                    │      two at once     │
                    ▼                      ▼
   ┌──────────────────────────┐ ┌──────────────────────────┐
   │ RUN RECORD        [code] │ │ LEARNING PASS      [AI]  │
   │ Q: what happened, in     │ │ Q: what did this teach   │
   │    numbers?              │ │    that a rule should    │
   │ A: candidates, funded,   │ │    carry?                │
   │    gate outcomes, PRs    │ │ A: notes on this repo,   │
   │    opened, review rounds,│ │    dated; any rule that  │
   │    patches retired       │ │    changed; every        │
   │                          │ │    "retire once X ships" │
   │                          │ │    claim re-checked      │
   └──────────────────────────┘ └──────────────────────────┘
                    └──────────┬───────────┘
                               ▼
                   the next run starts smarter
```

Two things stay serial on purpose: the branches wait for the library list (a local read, seconds), and the fix waits for a red test.
