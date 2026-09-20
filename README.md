<h1 align="center">🦤 osstrich</h1>

<p align="center">
  <b>Finds the dependency that owes you a fix, and ships it as a pull request.</b>
</p>

<p align="center"><img alt="osstrich reads your repo's dependencies, ranks them, finds the overlap with their open issues, and ships a pull request in the maintainer's own voice" src="assets/readme/hero.svg" width="900"></p>

<p align="center">
  <a href="https://codecov.io/gh/oficiallyAkshay/osstrich"><img alt="coverage" src="https://img.shields.io/codecov/c/github/oficiallyAkshay/osstrich?logo=codecov&logoColor=white"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/license-MIT-2f6f4e?logo=opensourceinitiative&logoColor=white"></a>
  <a href="https://github.com/oficiallyAkshay/osstrich/releases/latest"><img alt="installs, from the release tarball" src="https://img.shields.io/github/downloads/oficiallyAkshay/osstrich/total?label=installs&color=2f6f4e&logo=github&logoColor=white"></a>
  <a href="https://github.com/oficiallyAkshay/clonometer"><img alt="clones of this repository, last seven days and all time" src="https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/oficiallyAkshay/osstrich/badges/clones.json&query=$.badge&label=clones&logo=github&logoColor=white"></a>
  <a href="https://www.bestpractices.dev/projects/14724"><img alt="OpenSSF Best Practices, passing" src="https://www.bestpractices.dev/projects/14724/badge"></a>
</p>

<p align="center">Works with<br>
  <a href="https://github.com/anthropics/claude-code"><img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-1e1b4b?logo=claude&logoColor=white"></a>
</p>

## Features

osstrich reads what your repo actually depends on and turns the one dependency costing you time into a merged pull request.

<p align="center">🎯<br><b>Funds the real cost</b><br>Your own next step matched against their open issue, not a browsed backlog.</p>

<p align="center">🌱<br><b>Community first</b><br>Company-backed projects rank behind the ones nobody else will fix.</p>

<p align="center">🚪<br><b>Gated before it builds</b><br>Skips the pull request when a different way of using the library fixes it for you instead.</p>

<p align="center">🗣️<br><b>Ships in their voice</b><br>Their tests first, their style, their commit format, your name on it.</p>

<p align="center">🔒<br><b>Scrubbed before it's public</b><br>Every diff runs through gitleaks before a branch or a pull request goes anywhere external.</p>

<p align="center">📒<br><b>Counted, not narrated</b><br>One run record: candidates, funded, gate outcomes, pull requests opened, patches retired.</p>

## Fit

Use it when:

- Your repo depends on more open source projects than you can watch, and you want the one whose problem is also yours found automatically.
- You already know which library and issue to fix, and want the pull request written and posted in the maintainer's own voice.
- You want contribution effort to go to the smallest, most under-resourced project first, not the loudest one.

Look elsewhere when:

- You want dependency version bumps, not code fixes: that is Dependabot's job.
- You want a general coding agent for your own repo's work: that is OpenHands's job.
- You want to browse curated issues yourself rather than have your own dependency tree read and ranked.

Install it from the tarball GitHub attaches to each release; the exact command is in CONTRIBUTING.

## How it compares

| | [oficiallyAkshay/osstrich](https://github.com/oficiallyAkshay/osstrich) | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | [dependabot/dependabot-core](https://github.com/dependabot/dependabot-core) | [cutenode/good-first-issue](https://github.com/cutenode/good-first-issue) |
| --- | --- | --- | --- | --- |
| Reads your dependencies | ✅ | ❌ | ✅ | ❌ |
| Ranks by need | ✅ | ❌ | ❌ | ❌ |
| Finds the overlap | ✅ | ❌ | ❌ | ❌ |
| Gates the fix | ✅ | ❌ | ❌ | ❌ |
| Ships a code fix | ✅ | ✅ | Version bumps | ❌ |
| Installation | Tarball | npm | Library | npm |

## Security and limits

No credential of its own. On PATH: `gh`, `gitleaks`, one headless coding agent CLI. Each already holds its own auth, so osstrich never sees a token.

- ❌ reads, stores or transmits your credentials itself
- ❌ touches your own repository's settings, branches or releases
- ❌ contacts any service of its own
- ❌ adds a runtime dependency beyond what package.json declares
- ❌ updates itself
- ❌ leaves personal information or your own internal names in a diff, commit or pull request body it sends externally

By default every diff is scrubbed for secrets before it is proposed, and nothing opens, pushes or comments without your explicit go. It needs Node 22 or newer.
