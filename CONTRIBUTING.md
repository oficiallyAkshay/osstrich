# Contributing

Thank you. osstrich exists to make contributing easier, so contributing to it should be easy too.

## Before you start

- For anything bigger than a typo, open an issue first and say what you are seeing. Two sentences is enough.
- Check the open issues; someone may already be on it.

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
