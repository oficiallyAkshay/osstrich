# Security

## Supported versions

The current `main` branch and the latest tag. Nothing older gets a fix.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository:
https://github.com/oficiallyAkshay/osstrich/security/advisories/new

Never open a public issue for a vulnerability. Expect an acknowledgement
within seven days.

## Scope

osstrich runs on your machine with your own credentials, and its whole
job is to open real pull requests against real third-party repositories.
That is a wider blast radius than a typical CLI, so it is worth stating
plainly what it does and does not do:

- ✅ shells out to `gh`, `gitleaks`, and whatever headless coding agent
  CLI you configured (`claude -p`, `codex exec`, ...), using whatever
  auth those tools already have on your machine
- ✅ reads your own repository (`discover`) and opens pull requests on
  upstream repositories you chose (`build`)
- ✅ runs `gitleaks` over every diff before it is proposed, to scrub
  secrets out of a patch before it leaves your machine
- ❌ does not read, store, or transmit your credentials itself — it
  never sees a token; it only invokes CLIs that already hold their own
  auth
- ❌ does not touch your own repository's settings, branches, or
  releases
- ❌ does not contact any service of its own; every network call is
  made by `gh` or the agent CLI you supplied
- ❌ does not add a dependency at runtime beyond what is declared in
  `package.json`

If you find a way for osstrich to leak a credential, act on a repo you
did not name, or open a PR you did not ask for, that is a vulnerability
report, not a bug report.
