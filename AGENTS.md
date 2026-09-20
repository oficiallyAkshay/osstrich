# AGENTS.md

Skill path: `skill/SKILL.md`. Install with the skills CLI or copy the folder; it teaches an agent the `discover` and `build` arcs and when to run each.

Reference: [CONTRIBUTING.md](CONTRIBUTING.md) holds commands, requirements, the release process and how the pieces fit. [skill/references/how-it-thinks.md](skill/references/how-it-thinks.md) draws both arcs end to end, read in full alongside this file.

Commands: `osstrich init`, `config get|set`, `env list|set`, `status [--run <id>]`, `discover [--headless|--table]`, `build [<owner/repo#n|url>]`, `scrub`, `recheck`. Exit 0 is done, exit 2 is a usage error; a thrown `OsstrichError` maps to its own code in `lib/errors.mjs`.

Order of work: `discover` runs inventory, rank, overlap, verdict, then the gate, then a human "go" before `build` starts on the top funded item. `build` runs Phases 0-2 (`skill/references/investigate.md`), then 3-5 (`skill/references/build-and-test.md`, `skill/references/pr-etiquette.md`), then Phase 6 / `capture` (`skill/references/self-learning.md`). The full phase index is in `skill/SKILL.md`. Started at a stage, assume earlier stages already ran.

Operating rules, in full, live in `skill/SKILL.md`: no code before the green light, the gate runs before every build, fund only on overlap, every run writes a run record, classification is read from `skill/references/classification.md` never re-judged, and every PR body, commit and branch name is scrubbed before anything external sees it.

Requirements: `gh`, `gitleaks`, and one headless coding agent CLI (`claude -p`, `codex exec`, ...) on PATH, plus Node 22 or newer.
