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
