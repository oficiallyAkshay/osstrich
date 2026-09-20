# Contributing

Thank you. osstrich exists to make contributing easier, so contributing to it should be easy too.

## Before you start

- For anything bigger than a typo, open an issue first and say what you are seeing. Two sentences is enough.
- Check the open issues; someone may already be on it.
- The agent block is [AGENTS.md](AGENTS.md) at the repo root; read it before wiring osstrich into a CI job or another agent.

## Install and run

Install the package from the tarball GitHub attaches to each release:

```sh
npm install https://github.com/oficiallyAkshay/osstrich/releases/latest/download/osstrich.tgz
```

`gh`, `gitleaks`, and any headless coding agent CLI (for example `claude -p` or `codex exec`) must be on PATH for the judgment phases, along with Node 22 or newer.

```sh
osstrich init
osstrich discover
osstrich discover --headless
osstrich build owner/repo#123
osstrich status
```

`osstrich --help` prints the full command table (`init`, `config`, `env`, `status`, `discover`, `build`, `scrub`, `recheck`) with its flags.

## How it thinks

Two flow diagrams walk `discover` and `build` step by step, marking which parts are deterministic, which are judgment calls, and where a human green light is required: [skill/references/how-it-thinks.md](skill/references/how-it-thinks.md).

## The bar, which is the skill's own bar

- **Write the failing test first**, run it against the unpatched code, then fix. The test is the reproduction.
- **Smallest diff that fixes the root cause.** Not the smallest diff that plausibly helps.
- **Match the file you are in.** Its comment density, its shape, its naming. Consistency beats an abstract standard.
- **Tests go where tests for that area already live.** New files only when the existing convention uses them.
- **Say what ran, with counts.** "Tests pass" is not a claim; "41 passed, 0 failed" is.
- **No internal names, private paths, or personal details** in commits, PR bodies, or examples.

## AI-assisted contributions

Welcome. Keep the attribution trailer on the commit (`Co-Authored-By: <model> <noreply@...>`) so readers know how the change was made. You are still the author; you still read the diff.

## Licensing

No contributor agreement. By opening a pull request you agree your contribution is licensed under this repository's license.

## Pull request shape

Symptom, then root cause, then what changed, then what ran. Short beats thorough. If it relates to an existing PR or issue, say so and be kind about it.

## Releases

A merge never cuts a release. A release is cut on purpose, by pushing a version tag (`git tag -a v0.0.N && git push origin v0.0.N`); the tag-triggered workflow runs the tests, packs the package, and attaches it to the release. Versions stay in the 0.0.x series until the maintainer says otherwise.

## What CI runs

| Check | Runs on | Blocks merge |
| --- | --- | --- |
| test suite with coverage | `test`, on Node 22 and 24 | yes |
| coverage upload | `test`, Node 24 only | no |
| pre-commit hooks (eslint, actionlint, zizmor, gitleaks) and pinact | `lint` | yes |
| secrets scan over the whole history (gitleaks-action, not a pre-commit hook here since it needs history a hook never sees) | `lint` | yes |
| gate | `ci` | yes |
| README, CONTRIBUTING and docs check, every count badge run and verified | `readme check`, every push, pull request and weekly | no |
| dependency review of manifest changes | `dependency-review`, pull requests only | no |
| dependency audit (`npm audit`) | `audit`, weekly and on a pull request touching `package-lock.json` | no |
| dependabot auto-merge | pull requests from Dependabot | no, it only arms auto-merge; the checks above still gate the merge itself |
| codeql | push, pull request and weekly | no, results in the Security tab |
| scorecard | push to main and weekly | no |
| clonometer clone/view counter | daily schedule | no |
