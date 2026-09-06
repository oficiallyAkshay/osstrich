/**
 * osstrich-inventory/runner.mjs — unit tests for
 * shared/osstrich-inventory.mjs, osstrich's shape-based inventory reader.
 *
 * Every fixture is SYNTHETIC (invented package/repo names — "acme/*",
 * "example/*" — never a real name from this checkout) and built fresh
 * under `mkdtempSync` with real `fs` writes, never the actual checkout.
 * The module finds everything by SHAPE, so these fixtures exercise every
 * detector's shape directly rather than any particular file path:
 *   1. "full" — one instance of every detector shape, deliberately
 *      including a few malformed/missing corners (a manifest with no
 *      sibling lock at all, a manifest with invalid JSON, a `uses:` line
 *      with no version comment, a package declared with two different
 *      resolved versions across trees) so every gap path in the module
 *      fires at least once. A fake `fetch` and a fake `exec` supply
 *      canned registry/GitHub responses — one of each THROWS deliberately
 *      to prove the failure is a `gaps[]` entry, never an uncaught
 *      rejection.
 *   2. "sparse" — a completely empty repo root. Every detector legitimately
 *      finds nothing — that's not a failure for a shape-based reader (a
 *      repo with no Docker images is not "missing" its images) — so the
 *      module must degrade to zero rows and ZERO gaps, never throw, and
 *      never call `fetch`/`exec` at all (nothing has a repo to look up).
 *   3. "rate-limited" — one CI-action project (repo known without any
 *      network call), two sub-cases: `gh api rate_limit` throwing, and it
 *      succeeding with a budget below the floor. Both must skip the WHOLE
 *      GitHub queue with one gap, never attempt a per-row lookup.
 *   4. "markdown patch-list context fallback" — an item naming no repo of
 *      its own resolves against the NEAREST context in turn: the heading,
 *      then the paragraph nearest the list (proving "nearest", not
 *      "first mentioned", when an earlier decoy paragraph sits further
 *      away), then the file's own first H1 (via a known project's name,
 *      not a bare token, for matcher variety) — and a fourth item with no
 *      resolvable context anywhere keeps `repo: null`.
 *   5. "binary-pin test-path exclusion" — the same release-URL shape under
 *      a `tests/` directory (any depth) is ignored while an identical file
 *      under `scripts/` is still detected, and a `.test.mjs` filename is
 *      ignored even outside any test-named directory.
 *
 * A release-URL literal ("releases/download/…" / "releases/tag/…") is
 * deliberately never spelled out contiguously anywhere in THIS source
 * file — this file is itself a real `.mjs` file the shape-based binary-pin
 * detector would otherwise match against when it later runs over the real
 * checkout, so every such fixture string is assembled from split pieces at
 * runtime instead (see `REL` below).
 *
 * Every `fs` handed to `collectInventory` is a guarding wrapper around the
 * real `node:fs` that throws if asked to touch anything outside that
 * fixture's own temp root — proof the module never reaches into the real
 * checkout.
 *
 * Exits 0 on all-pass, 1 on any failure.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectInventory } from "../lib/inventory.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

function ok(name, cond, detail = "") {
	assert.ok(cond, detail ? `${name} — ${detail}` : name);
}

/** Split so this file's own source text never spells out the contiguous
 * "releases/download" / "releases/tag" substring the binary-pin detector
 * looks for — see the module doc above. */
const REL = "release" + "s";

/** A node:fs-shaped wrapper that throws if `readFileSync`/`readdirSync` is
 * ever asked to resolve a path outside `root` — the "real filesystem never
 * touched outside the temp dir" guarantee, enforced rather than assumed. */
function scopedFs(root) {
	function assertScoped(p) {
		const abs = path.resolve(String(p));
		if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
			throw new Error(`SCOPE VIOLATION: attempted to touch ${abs}, outside fixture root ${root}`);
		}
	}
	return {
		readFileSync: (p, enc) => {
			assertScoped(p);
			return readFileSync(p, enc);
		},
		readdirSync: (p, opts) => {
			assertScoped(p);
			return readdirSync(p, opts);
		},
	};
}

function find(projects, kind, name) {
	return projects.find((p) => p.kind === kind && p.name === name);
}


const tmpRoot = mkdtempSync(path.join(tmpdir(), "osstrich-inventory-test-"));
after(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

test("collectInventory: the full fixture — every detector shape, every gap path", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "full-"));
		const w = (rel, content) => {
			const abs = path.join(repoRoot, rel);
			mkdirSync(path.dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		};

		// ── npm dependencies ──────────────────────────────────────────────
		// Root manifest: acme-pad resolves via the root lock, acme-chalk does
		// not (missing lockfile ENTRY — falls back to its manifest range).
		w("package.json", JSON.stringify({ dependencies: { "acme-pad": "^1.0.0", "acme-chalk": "^4.0.0" } }));
		w("package-lock.json", JSON.stringify({ packages: { "node_modules/acme-pad": { version: "1.3.0" } } }));

		// standalone/: a manifest with NO sibling lock file at all.
		w("standalone/package.json", JSON.stringify({ dependencies: { "acme-odd": "^3.0.0" } }));

		// bad/: a manifest that fails to parse at all.
		w("bad/package.json", "{ this is not valid json");

		// sub/: acme-lodash resolves cleanly; acme-chalk resolves to a
		// DIFFERENT version than the root's fallback — triggers the
		// version-drift gap when the two rows dedupe (root sorts first
		// alphabetically, so its fallback is the first-seen value).
		w("sub/package.json", JSON.stringify({ dependencies: { "acme-lodash": "^4.17.0", "acme-chalk": "^5.0.0" } }));
		w("sub/package-lock.json", JSON.stringify({ packages: { "node_modules/acme-lodash": { version: "4.17.21" }, "node_modules/acme-chalk": { version: "5.0.0" } } }));

		// sub/nested/deeper/: no sibling lock at all — proves lock resolution
		// walks UP past an intermediate lock-less directory.
		w(
			"sub/nested/deeper/package.json",
			JSON.stringify({ dependencies: { "acme-lodash": "^4.17.0", "acme-pad": "^1.0.0", "acme-unknown-pkg": "^9.9.9" } }),
		);

		// Built-in default skipDirs proof: a package.json under each
		// excluded directory, each declaring a dependency that must NEVER
		// surface below.
		w("node_modules/some-pkg/package.json", JSON.stringify({ dependencies: { "should-not-appear": "^1.0.0" } }));
		w("coverage/package.json", JSON.stringify({ dependencies: { "coverage-ghost": "^1.0.0" } }));
		w("dist/package.json", JSON.stringify({ dependencies: { "dist-ghost": "^1.0.0" } }));
		w(".git/package.json", JSON.stringify({ dependencies: { "git-ghost": "^1.0.0" } }));

		// A CUSTOM skipDirs entry (bare name AND relative prefix), passed
		// explicitly by this test (not part of the built-in default) —
		// proves the option itself is honored, not just the baked-in set.
		w("vendor-drop/package.json", JSON.stringify({ dependencies: { "custom-skip-ghost": "^1.0.0" } }));
		w("extra/skip-me/package.json", JSON.stringify({ dependencies: { "prefix-skip-ghost": "^1.0.0" } }));

		// ── binary pins ────────────────────────────────────────────────────
		// tool-a: interpolated ${TOOLA_VERSION} constant, declared far below
		// its own usage, in a `.mjs` file — proves whole-file nearest-const
		// search, not a fixed line window.
		w(
			"scripts/tool-installer.mjs",
			[
				...Array.from({ length: 20 }, (_, i) => `// filler line ${i + 1}, keeps the constant far from its own usage`),
				"const toolAUrl = `https://github.com/acme/tool-a/" + REL + '/download/v${TOOLA_VERSION}/tool-a.tar.gz`;',
				...Array.from({ length: 20 }, (_, i) => `// more filler ${i + 1}`),
				'export const TOOLA_VERSION = "1.2.3";',
				"",
			].join("\n"),
		);
		// tool-b: a literal (non-interpolated) version, in a `.sh` file, using
		// the "tag" form of the URL rather than "download".
		w("scripts/other/installer.sh", ["#!/bin/sh", "curl -LO https://github.com/acme/tool-b/" + REL + "/tag/v2.0.0/tool-b.tar.gz", ""].join("\n"));
		// tool-missing-const: interpolates a constant that is never declared
		// anywhere in the file — soft gap, never a throw.
		w("scripts/broken-installer.mjs", ["const url = `https://github.com/acme/tool-missing-const/" + REL + '/download/v${NEVER_DECLARED}/x.tar.gz`;', ""].join("\n"));
		// A `_VERSION`-shaped constant with NO release URL anywhere in the
		// file produces NO row at all — detection is URL-driven, not
		// const-driven, under the new shape rule.
		w("scripts/unrelated-const.mjs", ['export const UNUSED_VERSION = "9.9.9";', ""].join("\n"));

		// ── container images ─────────────────────────────────────────────
		w("docker/dev/docker-compose.yml", ["services:", "  db:", "    image: postgres:17", "  cache:", "    image: redis", ""].join("\n"));
		w("services/extra-compose.yaml", ["services:", "  app:", "    image: acme/widget-image:2.0", ""].join("\n"));

		// ── vendored copies ───────────────────────────────────────────────
		// Two files vendored from the SAME upstream project, in different
		// directories — must dedupe to ONE row (the correct count of
		// upstream projects vendored, not of local copies).
		w("tools/entry-points/tool-c-base.mjs", "// Vendored from github.com/acme/tool-c @ v1.0.0 (2026-01-01)\nexport const base = 1;\n");
		w("tools/entry-points/tool-c-review.mjs", "// Vendored from github.com/acme/tool-c @ v1.0.0 (2026-01-01)\nexport const review = 1;\n");
		// Header on line 3, not line 1 — proves "first 5 lines", not "line 1".
		w("lib/vendored-tool-d.mjs", ["// tool-d wrapper", "// local entry point", "// Vendored from github.com/acme/tool-d @ main (2026-02-02)", "export const x = 1;", ""].join("\n"));
		// Decoy: mentions "Vendored from" but not on the header shape, and a
		// plain file with nothing vendored at all.
		w("lib/decoy.mjs", ["// this file is not Vendored from anywhere", "export const y = 1;", ""].join("\n"));
		w("lib/plain.mjs", "export const z = 1;\n");

		// ── hand patches, shape (a): patch-package file ───────────────────
		w("patches/acme-widget+1.2.3.patch", "--- a/index.js\n+++ b/index.js\n");

		// ── hand patches, shape (b): pnpm patchedDependencies ─────────────
		w(
			"tools/package.json",
			JSON.stringify({ name: "tools-workspace", patchedDependencies: { "acme-gadget@2.0.0": "patches/acme-gadget.patch" } }),
		);

		// ── hand patches, shape (c): markdown patch lists ─────────────────
		// Decoy 1: heading contains "dispatch" (a substring of "patch") but
		// NOT the whole word — must never fire, even though a list follows
		// immediately.
		// Decoy 2: heading contains the whole word "Patches" but is followed
		// only by prose, never a list — heading matches, nothing is found,
		// no row and no gap (a detector that finds nothing adds nothing).
		// Real section: "### Patches we carry", with a preamble paragraph
		// before the list (must be skipped, not required to be immediately
		// adjacent), one item naming a bare owner/repo token directly, one
		// item naming an already-known project (not a token) whose own
		// `repo` is resolved via the fallback and whose second line is an
		// INDENTED CONTINUATION of the same item, one item naming no repo
		// at all, and trailing prose after the list that must never be
		// swept in as a fourth item.
		w(
			"docs/notes.md",
			[
				"# Notes",
				"",
				"## Two dispatch tracks worth noting",
				"",
				"- Track A does one thing",
				"- Track B does another",
				"",
				"## Patches applied here, described only in prose",
				"",
				"No list follows this heading, just an explanation of what happened over time.",
				"",
				"### Patches we carry",
				"",
				"Context sentence before the list starts, explaining why these exist at all.",
				"",
				"1. Case A -- see acme/toolc-fork for the umbrella project, filed upstream already.",
				"2. Case B -- the widget-host fork carries this fix locally, not yet upstreamed",
				"   in a continuation line that should join item 2's own text via indentation.",
				"3. Case D -- no repo mentioned anywhere in this line at all, a genuine gap.",
				"",
				"Trailing prose after the list must never be swept in as a fourth item, even",
				"though it mentions patches again right here with no list right after it.",
				"",
			].join("\n"),
		);

		// ── CI actions ────────────────────────────────────────────────────
		w(
			".github/workflows/ci.yml",
			[
				"name: CI",
				"jobs:",
				"  build:",
				"    steps:",
				"      - uses: acme/checkout-action@abcdef1234567890abcdef1234567890abcdef12  # v4.1.0",
				"      - uses: acme/cache-action@abcdef1234567890abcdef1234567890abcdef12",
				"",
			].join("\n"),
		);
		// A second workflow re-using the SAME action — proves the dedupe-by-
		// owner/repo path merges sources rather than double-counting.
		w(
			".github/workflows/release.yml",
			["name: Release", "jobs:", "  build:", "    steps:", "      - uses: acme/checkout-action@abcdef1234567890abcdef1234567890abcdef12  # v4.1.0", ""].join("\n"),
		);

		// ── host installs ─────────────────────────────────────────────────
		w(
			"host-installs.md",
			[
				"# Host installs (fixture)",
				"",
				"| name | upstream repo | how installed | where the version is read | notes |",
				"|---|---|---|---|---|",
				"| widget-host | acme/widget-host-fork | brew | `widget-host --version` | fixture note |",
				"| tool-runtime | acme/tool-runtime | npm on the host | `tool-runtime --version` | |",
				"",
			].join("\n"),
		);

		async function fakeFetch(url) {
			if (url.includes("registry.npmjs.org/acme-pad")) {
				return { ok: true, json: async () => ({ "dist-tags": { latest: "1.3.1" }, repository: { url: "git+https://github.com/acme/pad.git" } }) };
			}
			if (url.includes("api.npmjs.org/downloads/point/last-week/acme-pad")) return { ok: true, json: async () => ({ downloads: 5000000 }) };
			if (url.includes("registry.npmjs.org/acme-chalk")) throw new Error("simulated network failure");
			if (url.includes("api.npmjs.org/downloads/point/last-week/acme-chalk")) return { ok: false, status: 503 };
			if (url.includes("registry.npmjs.org/acme-lodash")) {
				return { ok: true, json: async () => ({ "dist-tags": { latest: "4.17.21" }, repository: "git://github.com/acme/lodash-mirror.git" }) };
			}
			if (url.includes("api.npmjs.org/downloads/point/last-week/acme-lodash")) return { ok: true, json: async () => ({ downloads: 30000000 }) };
			if (url.includes("registry.npmjs.org/acme-odd")) return { ok: true, json: async () => ({ "dist-tags": { latest: "3.0.0" } }) }; // no `repository` field
			if (url.includes("api.npmjs.org/downloads/point/last-week/acme-odd")) return { ok: true, json: async () => ({ downloads: 100 }) };
			if (url.includes("registry.npmjs.org/acme-unknown-pkg")) return { ok: true, json: async () => ({ "dist-tags": { latest: "9.9.9" } }) };
			if (url.includes("api.npmjs.org/downloads/point/last-week/acme-unknown-pkg")) return { ok: true, json: async () => ({ downloads: 0 }) };
			if (url.includes("registry.npmjs.org/acme-widget")) return { ok: true, json: async () => ({ repository: { url: "https://github.com/acme/widget" } }) };
			if (url.includes("registry.npmjs.org/acme-gadget")) return { ok: true, json: async () => ({ repository: "git+https://github.com/acme/gadget.git" }) };
			throw new Error(`unexpected fetch url in test: ${url}`);
		}

		async function fakeExec(cmd, args) {
			if (cmd !== "gh") throw new Error(`unexpected exec command in test: ${cmd}`);
			const target = args[1];
			if (target === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4000 } } }) };
			if (target === "repos/acme/pad") throw new Error("simulated gh api failure");
			const releaseMatch = target.match(/^repos\/(.+)\/releases\/latest$/);
			if (releaseMatch) return { stdout: JSON.stringify({ tag_name: `v9.9.9-${releaseMatch[1].split("/")[1]}` }) };
			const repoMatch = target.match(/^repos\/(.+)$/);
			if (repoMatch) return { stdout: JSON.stringify({ stargazers_count: 42, archived: false, owner: { type: "Organization" }, open_issues_count: 3 }) };
			throw new Error(`unhandled gh api target in test: ${target}`);
		}

		const fixedNow = () => Date.UTC(2026, 8, 6, 12, 0, 0);
		const result = await collectInventory({
			repoRoot,
			fs: scopedFs(repoRoot),
			exec: fakeExec,
			fetch: fakeFetch,
			now: fixedNow,
			concurrency: 3,
			hostsFile: "host-installs.md",
			skipDirs: ["node_modules", ".git", "coverage", "dist", "build", "vendor-drop", "extra/skip-me"],
		});

		ok("status is incomplete (gaps were recorded)", result.status === "incomplete", result.status);
		ok("generatedAt uses the injected clock", result.generatedAt === new Date(fixedNow()).toISOString(), result.generatedAt);
		ok(
			"skip-dir and custom-skipDirs packages never surface",
			!["should-not-appear", "coverage-ghost", "dist-ghost", "git-ghost", "custom-skip-ghost", "prefix-skip-ghost"].some((n) => find(result.projects, "npm", n)),
		);

		const acmePad = find(result.projects, "npm", "acme-pad");
		ok(
			"acme-pad: ours from lock, latest+repo+downloads from registry, stars from gh",
			acmePad?.ours === "1.3.0" && acmePad.latest === "1.3.1" && acmePad.repo === "acme/pad" && acmePad.weeklyDownloads === 5000000,
			JSON.stringify(acmePad),
		);

		const acmeChalk = find(result.projects, "npm", "acme-chalk");
		ok(
			"acme-chalk: kept first-seen fallback range, registry/downloads/stars all stayed null after failures",
			acmeChalk?.ours === "^4.0.0" && acmeChalk.latest === null && acmeChalk.repo === null && acmeChalk.weeklyDownloads === null,
			JSON.stringify(acmeChalk),
		);
		ok("acme-chalk carries sources from BOTH manifests (dedupe merges, doesn't drop)", acmeChalk?.sources.length === 2, JSON.stringify(acmeChalk?.sources));

		const acmeOdd = find(result.projects, "npm", "acme-odd");
		ok("acme-odd: no sibling lock at all -> range fallback; no repository field -> repo null", acmeOdd?.ours === "^3.0.0" && acmeOdd.repo === null, JSON.stringify(acmeOdd));

		const acmeLodash = find(result.projects, "npm", "acme-lodash");
		ok("acme-lodash: bare git:// repository URL still parses to owner/repo", acmeLodash?.repo === "acme/lodash-mirror", JSON.stringify(acmeLodash));
		ok(
			"acme-lodash carries a source from the lock-less deeper manifest too (resolved via the ancestor walk)",
			acmeLodash?.sources.some((s) => s.file === "sub/nested/deeper/package.json"),
		);

		const unknownPkg = find(result.projects, "npm", "acme-unknown-pkg");
		ok("acme-unknown-pkg: absent from every lock in the ancestor chain -> range fallback, still a row", unknownPkg?.ours === "^9.9.9", JSON.stringify(unknownPkg));

		const toolA = find(result.projects, "binary", "tool-a");
		ok(
			"tool-a: interpolated ${TOOLA_VERSION} resolved from a const declared far below its own usage, repo known straight from the URL",
			toolA?.ours === "1.2.3" && toolA.repo === "acme/tool-a",
			JSON.stringify(toolA),
		);
		const toolB = find(result.projects, "binary", "tool-b");
		ok("tool-b: literal version in a .sh file, using the tag form of the URL", toolB?.ours === "v2.0.0" && toolB.repo === "acme/tool-b", JSON.stringify(toolB));
		ok("tool-missing-const: no row is dropped, but its version stays null", find(result.projects, "binary", "tool-missing-const")?.ours === null);
		ok(
			"a bare *_VERSION constant with no release URL anywhere produces NO row at all (URL-driven, not const-driven)",
			!result.projects.some((p) => p.kind === "binary" && p.ours === "9.9.9"),
		);
		const postgres = find(result.projects, "image", "postgres");
		const redis = find(result.projects, "image", "redis");
		const widgetImage = find(result.projects, "image", "widget-image");
		ok("postgres image (nested compose file): tag captured, no repo", postgres?.ours === "17" && postgres.repo === null, JSON.stringify(postgres));
		ok("redis image: no tag on the line -> ours null", redis?.ours === null, JSON.stringify(redis));
		ok("widget-image (a *-compose.yaml basename, not literally docker-compose): also found", widgetImage?.ours === "2.0", JSON.stringify(widgetImage));

		const toolC = find(result.projects, "skill", "tool-c");
		ok(
			"tool-c: two files vendored from the SAME upstream collapse into ONE row with two sources",
			toolC?.ours === "v1.0.0" && toolC.repo === "acme/tool-c" && toolC.sources.length === 2,
			JSON.stringify(toolC),
		);
		const toolD = find(result.projects, "skill", "tool-d");
		ok("tool-d: vendoring header on line 3, not line 1 -- still found within the first 5 lines", toolD?.sources[0]?.line === 3, JSON.stringify(toolD));
		ok("decoy.mjs / plain.mjs never produced a vendored-copy row", !find(result.projects, "skill", "decoy") && !find(result.projects, "skill", "plain"));

		const patchA = find(result.projects, "patch", "acme/widget#patch-1");
		ok("patch-package shape (a): repo resolved via the npm registry, label is the patch filename", patchA?.repo === "acme/widget" && patchA.label === "acme-widget+1.2.3.patch", JSON.stringify(patchA));

		const patchB = find(result.projects, "patch", "acme/gadget#patch-1");
		ok("pnpm patchedDependencies shape (b): repo resolved the same way, label is the manifest key", patchB?.repo === "acme/gadget" && patchB.label === "acme-gadget@2.0.0", JSON.stringify(patchB));

		const patchCaseA = find(result.projects, "patch", "acme/toolc-fork#patch-1");
		ok("markdown list shape (c), item 1: repo from a bare owner/repo token in the item's own text", Boolean(patchCaseA), JSON.stringify(patchCaseA));

		const patchCaseB = find(result.projects, "patch", "acme/widget-host-fork#patch-2");
		ok(
			"markdown list shape (c), item 2: repo from the first already-known project mentioned by name (the widget-host row), continuation line joined",
			Boolean(patchCaseB) && patchCaseB.label.includes("continuation line"),
			JSON.stringify(patchCaseB),
		);

		const patchCaseD = find(result.projects, "patch", "patch-3");
		ok("markdown list shape (c), item 3: no repo anywhere -> bare patch-<n> name, repo null", Boolean(patchCaseD) && patchCaseD.repo === null, JSON.stringify(patchCaseD));

		ok(
			"the decoy headings never produced a patch row (word-boundary + list-required both hold)",
			result.projects.filter((p) => p.kind === "patch").length === 5,
			JSON.stringify(result.projects.filter((p) => p.kind === "patch").map((p) => p.name)),
		);

		const checkoutAction = find(result.projects, "action", "acme/checkout-action");
		const cacheAction = find(result.projects, "action", "acme/cache-action");
		ok("acme/checkout-action: ours from the version comment, repo from the uses: line, stars from gh", checkoutAction?.ours === "v4.1.0" && checkoutAction.stars === 42, JSON.stringify(checkoutAction));
		ok("acme/checkout-action: two workflows referencing it dedupe to ONE row with two sources", checkoutAction?.sources.length === 2, JSON.stringify(checkoutAction?.sources));
		ok("acme/cache-action: no version comment -> ours null, still a row", cacheAction?.ours === null, JSON.stringify(cacheAction));

		const widgetHost = find(result.projects, "host", "widget-host");
		const toolRuntime = find(result.projects, "host", "tool-runtime");
		ok("widget-host: repo from the table, stars from gh, latest resolved via releases", widgetHost?.repo === "acme/widget-host-fork" && widgetHost.stars === 42, JSON.stringify(widgetHost));
		ok("tool-runtime host row: repo from the table", toolRuntime?.repo === "acme/tool-runtime", JSON.stringify(toolRuntime));

		ok(
			"gaps: acme-chalk missing lock entry in root",
			result.gaps.some((g) => g.source === "npm-manifest" && g.file === "package.json" && /acme-chalk/.test(g.error)),
		);
		ok("gaps: bad/package.json parse failure", result.gaps.some((g) => g.source === "npm-manifest" && g.file === "bad/package.json" && /parse/i.test(g.error)));
		ok("gaps: acme-chalk version drift on dedupe", result.gaps.some((g) => g.source === "npm" && /drift/i.test(g.error)));
		ok("gaps: acme/cache-action missing version comment", result.gaps.some((g) => g.source === "ci-actions" && /version comment/.test(g.error)));
		ok("gaps: npm-registry throw on acme-chalk", result.gaps.some((g) => g.source === "npm-registry" && g.file === "acme-chalk"));
		ok("gaps: npm-downloads non-OK on acme-chalk", result.gaps.some((g) => g.source === "npm-downloads" && g.file === "acme-chalk"));
		ok("gaps: github-metadata throw on acme/pad", result.gaps.some((g) => g.source === "github-metadata" && g.file === "acme/pad"));
		ok(
			"gaps: no NEVER_DECLARED constant found for the interpolated release URL",
			result.gaps.some((g) => g.source === "binary-pins" && /NEVER_DECLARED/.test(g.error)),
		);
		ok("gaps: markdown patch item 3 names no recognizable upstream repo", result.gaps.some((g) => g.source === "hand-patches" && /patch 3/.test(g.error)));
	}
});

test("collectInventory: maxFileBytes skips an oversized content-scan target, with a gap", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "maxbytes-"));
		const w = (rel, content) => {
			const abs = path.join(repoRoot, rel);
			mkdirSync(path.dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		};
		// A small binary-pin file, comfortably under the cap, still resolves.
		w("scripts/small.mjs", "const url = `https://github.com/acme/tool-small/" + REL + "/tag/v1.0.0`;\n");
		// A file over the (tiny, test-only) cap — never read, skipped with a gap.
		w("scripts/huge.mjs", "const url = `https://github.com/acme/tool-huge/" + REL + "/tag/v1.0.0`; // " + "x".repeat(300) + "\n");

		const neverCalled = async () => {
			throw new Error("should never be called — neither row carries a repo lookup that needs it");
		};
		const result = await collectInventory({
			repoRoot,
			fs: scopedFs(repoRoot),
			exec: neverCalled,
			fetch: neverCalled,
			now: () => 0,
			maxFileBytes: 120,
		});

		ok("the small file, under the cap, still produces a row", Boolean(find(result.projects, "binary", "tool-small")));
		ok("the oversized file is skipped, never scanned", !find(result.projects, "binary", "tool-huge"));
		ok(
			"the skip is a gap, not silent — never a dropped shape with no trace",
			result.gaps.some((g) => g.source === "binary-pins" && g.file === "scripts/huge.mjs" && /maxFileBytes/.test(g.error)),
			JSON.stringify(result.gaps),
		);
	}
});

test("collectInventory: the sparse fixture — a shape found nowhere is not a failure", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "sparse-"));
		const neverCalled = async () => {
			throw new Error("should never be called — no project in this fixture can have a repo");
		};

		const result = await collectInventory({
			repoRoot,
			fs: scopedFs(repoRoot),
			exec: neverCalled,
			fetch: neverCalled,
			now: () => 0,
		});

		ok("no throw on a totally empty repo", true);
		ok("zero projects", result.projects.length === 0, String(result.projects.length));
		ok("status is complete -- a shape found nowhere is not a gap for a repo that legitimately has none of it", result.status === "complete", JSON.stringify(result.gaps));
		ok("zero gaps", result.gaps.length === 0, JSON.stringify(result.gaps, null, 2));

		// hostsFile defaults to null: no host rows, and specifically no gap
		// (the module hasn't been told where to look, which isn't a failure).
		ok("no host-installs gap when hostsFile is left at its null default", !result.gaps.some((g) => g.source === "host-installs"));
	}
});

test("collectInventory: hostsFile given but unreadable IS a gap", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "missing-hosts-"));
		mkdirSync(repoRoot, { recursive: true });
		const neverCalled = async () => {
			throw new Error("should never be called");
		};
		const result = await collectInventory({
			repoRoot,
			fs: scopedFs(repoRoot),
			exec: neverCalled,
			fetch: neverCalled,
			now: () => 0,
			hostsFile: "does-not-exist.md",
		});
		ok("zero host rows", !result.projects.some((p) => p.kind === "host"));
		ok("a hostsFile that was given but doesn't exist IS a gap", result.gaps.some((g) => g.source === "host-installs"), JSON.stringify(result.gaps));
	}
});

test("collectInventory: hostsFile accepts an already-absolute path too", async () => {
	{
		// A config loader that resolves its other optional reference paths to
		// absolute ones (consistently) may hand this module an absolute
		// `hostsFile` too, not only one relative to `repoRoot` — both must work.
		const repoRoot = mkdtempSync(path.join(tmpRoot, "abs-hosts-"));
		const hostsAbsPath = path.join(repoRoot, "config", "hosts.md");
		mkdirSync(path.dirname(hostsAbsPath), { recursive: true });
		writeFileSync(
			hostsAbsPath,
			["| name | upstream repo | how installed | where the version is read | notes |", "|---|---|---|---|---|", "| widget-host | acme/widget-host-fork | brew | `widget-host --version` | |", ""].join(
				"\n",
			),
		);
		const neverCalled = async () => {
			throw new Error("should never be called");
		};
		const result = await collectInventory({
			repoRoot,
			fs: scopedFs(repoRoot),
			exec: neverCalled,
			fetch: neverCalled,
			now: () => 0,
			hostsFile: hostsAbsPath,
		});
		ok("an absolute hostsFile path is read directly, not double-joined with repoRoot", Boolean(find(result.projects, "host", "widget-host")), JSON.stringify(result.projects));
	}
});

test("collectInventory: the GitHub rate-limit budget gate", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "ratelimit-"));
		mkdirSync(path.join(repoRoot, ".github/workflows"), { recursive: true });
		writeFileSync(
			path.join(repoRoot, ".github/workflows/ci.yml"),
			"jobs:\n  build:\n    steps:\n      - uses: acme/setup-tool@1234567890abcdef1234567890abcdef12345678  # v4.0.0\n",
		);

		const neverCalled = async () => {
			throw new Error("fetch should never be called — no npm packages in this fixture");
		};

		async function throwingRateLimit(_cmd, args) {
			if (args[1] === "rate_limit") throw new Error("gh: not authenticated");
			throw new Error(`unexpected exec in rate-limit test: ${args[1]}`);
		}
		const throwResult = await collectInventory({ repoRoot, fs: scopedFs(repoRoot), exec: throwingRateLimit, fetch: neverCalled, now: () => 0 });
		const throwAction = find(throwResult.projects, "action", "acme/setup-tool");
		ok("action row still exists (repo known from the uses: line alone)", Boolean(throwAction), JSON.stringify(throwResult.projects));
		ok("stars stays null — the whole queue was skipped, not attempted per-row", throwAction?.stars === null);
		ok(
			"gap explains the skip as unverifiable",
			throwResult.gaps.some((g) => g.source === "github-metadata" && /unverifiable/.test(g.error)),
			JSON.stringify(throwResult.gaps),
		);

		async function lowBudget(_cmd, args) {
			if (args[1] === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 50 } } }) };
			throw new Error(`unexpected exec in rate-limit test: ${args[1]}`);
		}
		const lowResult = await collectInventory({ repoRoot, fs: scopedFs(repoRoot), exec: lowBudget, fetch: neverCalled, now: () => 0 });
		const lowAction = find(lowResult.projects, "action", "acme/setup-tool");
		ok("stars stays null under a verified-but-insufficient budget too", lowAction?.stars === null);
		ok(
			"gap names the actual remaining count",
			lowResult.gaps.some((g) => g.source === "github-metadata" && /50 remaining/.test(g.error)),
			JSON.stringify(lowResult.gaps),
		);
	}
});

test("collectInventory: the GitHub rate-limit budget is re-checked before every batch, not once for the whole queue", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "ratelimit-perbatch-"));
		mkdirSync(path.join(repoRoot, ".github/workflows"), { recursive: true });
		writeFileSync(
			path.join(repoRoot, ".github/workflows/ci.yml"),
			[
				"jobs:",
				"  build:",
				"    steps:",
				"      - uses: acme/first-tool@1234567890abcdef1234567890abcdef12345678  # v1.0.0",
				"      - uses: acme/second-tool@abcdef1234567890abcdef1234567890abcdef12  # v2.0.0",
				"",
			].join("\n"),
		);
		const neverCalled = async () => {
			throw new Error("fetch should never be called — no npm packages in this fixture");
		};

		let rateLimitCalls = 0;
		async function droppingBudget(_cmd, args) {
			if (args[1] === "rate_limit") {
				rateLimitCalls += 1;
				// First batch: healthy budget. Second batch: below the floor.
				const remaining = rateLimitCalls === 1 ? 4000 : 50;
				return { stdout: JSON.stringify({ resources: { core: { remaining } } }) };
			}
			if (args[1] === "repos/acme/first-tool") return { stdout: JSON.stringify({ stargazers_count: 7 }) };
			if (args[1] === "repos/acme/first-tool/releases/latest") return { stdout: JSON.stringify({ tag_name: "v1.2.3" }) };
			throw new Error(`unexpected exec call once the budget should have stopped the queue: ${args[1]}`);
		}
		// concurrency: 1 forces each project into its own batch, so the SECOND
		// project's batch is the one that must see the dropped budget.
		const result = await collectInventory({ repoRoot, fs: scopedFs(repoRoot), exec: droppingBudget, fetch: neverCalled, now: () => 0, concurrency: 1 });

		ok("rate_limit was checked twice — once per batch, not once for the whole queue", rateLimitCalls === 2, String(rateLimitCalls));
		const firstTool = find(result.projects, "action", "acme/first-tool");
		const secondTool = find(result.projects, "action", "acme/second-tool");
		ok("the first batch's project got its real GitHub metadata (budget was healthy)", firstTool?.stars === 7, JSON.stringify(firstTool));
		ok("the second batch's project never got a lookup at all — the queue stopped before reaching it", secondTool?.stars === null, JSON.stringify(secondTool));
		ok(
			"the gap names the second project among the skipped repos, with the actual dropped remaining count",
			result.gaps.some((g) => g.source === "github-metadata" && /50 remaining/.test(g.error) && g.error.includes("acme/second-tool")),
			JSON.stringify(result.gaps),
		);
	}
});

test("collectInventory: a registry fetch failure is retried once, after 500ms, then succeeds", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "fetch-retry-"));
		writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ dependencies: { "acme-retry-pkg": "^1.0.0" } }));
		writeFileSync(path.join(repoRoot, "package-lock.json"), JSON.stringify({ packages: { "node_modules/acme-retry-pkg": { version: "1.0.0" } } }));

		let registryCalls = 0;
		async function flakyThenOkFetch(url) {
			if (url.includes("registry.npmjs.org/acme-retry-pkg")) {
				registryCalls += 1;
				if (registryCalls === 1) throw new Error("simulated transient network failure");
				return { ok: true, json: async () => ({ "dist-tags": { latest: "1.2.0" }, repository: { url: "git+https://github.com/acme/retry-pkg.git" } }) };
			}
			if (url.includes("api.npmjs.org/downloads")) return { ok: true, json: async () => ({ downloads: 10 }) };
			throw new Error(`unexpected fetch url: ${url}`);
		}
		// The registry retry is the only thing under test here — give the
		// GitHub queue (triggered once the registry resolves a repo) a plain
		// working fake so it never adds unrelated gaps to muddy the assertions.
		async function fakeExec(_cmd, args) {
			if (args[1] === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4000 } } }) };
			if (args[1] === "repos/acme/retry-pkg") return { stdout: JSON.stringify({ stargazers_count: 1 }) };
			throw new Error(`unexpected exec target: ${args[1]}`);
		}

		const result = await collectInventory({ repoRoot, fs: scopedFs(repoRoot), exec: fakeExec, fetch: flakyThenOkFetch, now: () => 0, concurrency: 1 });
		const row = find(result.projects, "npm", "acme-retry-pkg");

		ok("exactly two registry calls were made — the failing first attempt plus one retry", registryCalls === 2, String(registryCalls));
		ok("the retried call's value is used once it succeeds — no gap, real latest/repo", row?.latest === "1.2.0" && row?.repo === "acme/retry-pkg", JSON.stringify(row));
		ok("no npm-registry gap is recorded once the retry succeeds", !result.gaps.some((g) => g.source === "npm-registry"), JSON.stringify(result.gaps));
	}
});

test("collectInventory: a 4xx registry response is never retried", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "fetch-4xx-"));
		writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ dependencies: { "acme-404-pkg": "^1.0.0" } }));
		writeFileSync(path.join(repoRoot, "package-lock.json"), JSON.stringify({ packages: { "node_modules/acme-404-pkg": { version: "1.0.0" } } }));

		let registryCalls = 0;
		async function notFoundFetch(url) {
			if (url.includes("registry.npmjs.org/acme-404-pkg")) {
				registryCalls += 1;
				return { ok: false, status: 404 };
			}
			if (url.includes("api.npmjs.org/downloads")) return { ok: false, status: 404 };
			throw new Error(`unexpected fetch url: ${url}`);
		}
		async function fakeExec() {
			throw new Error("no repo was ever resolved, so no gh call should happen");
		}

		const result = await collectInventory({ repoRoot, fs: scopedFs(repoRoot), exec: fakeExec, fetch: notFoundFetch, now: () => 0, concurrency: 1 });
		const row = find(result.projects, "npm", "acme-404-pkg");

		ok("exactly one registry call was made — a 4xx never retries", registryCalls === 1, String(registryCalls));
		ok("the row's registry fields stay null", row?.latest == null && row?.repo == null, JSON.stringify(row));
		ok("a npm-registry gap is recorded for the 4xx", result.gaps.some((g) => g.source === "npm-registry" && g.file === "acme-404-pkg"), JSON.stringify(result.gaps));
	}
});

test("collectInventory: a corrupt (unparseable) lock file is its own gap, not silently 'no lockfile entry'", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "corrupt-lock-"));
		writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ dependencies: { "acme-corrupt-dep": "^2.0.0" } }));
		writeFileSync(path.join(repoRoot, "package-lock.json"), "{ this is not valid json at all");

		// The corrupt lock file is what's under test — the registry/GitHub
		// lookups are irrelevant to it and simply fail soft (no repo ever
		// resolves), which is fine: this fixture asserts only on the
		// lockfile/npm-manifest gaps and the row's manifest-range fallback.
		const failingLookup = async () => {
			throw new Error("simulated lookup failure — unrelated to the lockfile assertions below");
		};
		const result = await collectInventory({ repoRoot, fs: scopedFs(repoRoot), exec: failingLookup, fetch: failingLookup, now: () => 0 });

		const lockGaps = result.gaps.filter((g) => g.source === "lockfile");
		ok("exactly one lockfile gap is recorded, naming the corrupt file", lockGaps.length === 1 && lockGaps[0].file === "package-lock.json", JSON.stringify(lockGaps));
		ok("the lockfile gap carries the real JSON.parse error message", typeof lockGaps[0]?.error === "string" && lockGaps[0].error.length > 0, JSON.stringify(lockGaps));

		const manifestGap = result.gaps.find((g) => g.source === "npm-manifest" && g.file === "package.json");
		ok("the per-dependency gap says the lockfile is unreadable, not that the entry is missing", /lockfile unreadable for "acme-corrupt-dep"/.test(manifestGap?.error || ""), JSON.stringify(manifestGap));
		ok('the per-dependency gap never uses the "no lockfile entry" wording when the lock itself is corrupt', !/no lockfile entry/.test(manifestGap?.error || ""), JSON.stringify(manifestGap));

		const row = find(result.projects, "npm", "acme-corrupt-dep");
		ok("the dependency still gets a row, falling back to its manifest range", row?.ours === "^2.0.0", JSON.stringify(row));
	}
});

test("collectInventory: markdown patch-list repo fallback — heading, nearest paragraph, no context", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "patch-fallback-"));
		const w = (rel, content) => {
			const abs = path.join(repoRoot, rel);
			mkdirSync(path.dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		};

		w(
			"docs/context-fallback.md",
			[
				"# Notes",
				"",
				"## Patches resolved from the heading: acme/heading-fork",
				"",
				"Filler prose that mentions no owner/repo pattern and no known project",
				"name at all, purely descriptive background with nothing to latch onto.",
				"",
				"1. Case A -- fixes a startup race, no repo token anywhere in this line.",
				"",
				"## Patches resolved from the nearest paragraph",
				"",
				"An earlier decoy paragraph mentions example/decoy-repo, which must never",
				"be picked since a later paragraph sits closer to the list below.",
				"",
				"The umbrella project tracked here is acme/intro-fork, the one these",
				"patches actually belong to.",
				"",
				"1. Case B -- also no repo mentioned in the item's own text.",
				"",
				"## Patches with no resolvable context anywhere",
				"",
				"This preamble paragraph is purely descriptive background with no owner,",
				"repo, or project name mentioned in it whatsoever.",
				"",
				"1. Case D -- no repo anywhere in the item, the heading, the paragraph, or this file's own first heading.",
				"",
			].join("\n"),
		);

		const neverCalled = async () => {
			throw new Error("should never be called — no npm/CI/host row in this fixture needs a lookup");
		};
		const result = await collectInventory({ repoRoot, fs: scopedFs(repoRoot), exec: neverCalled, fetch: neverCalled, now: () => 0 });

		const caseA = find(result.projects, "patch", "acme/heading-fork#patch-1");
		ok("item resolves via the HEADING when its own text names no repo", Boolean(caseA), JSON.stringify(result.projects.map((p) => p.name)));

		const caseB = find(result.projects, "patch", "acme/intro-fork#patch-1");
		ok(
			"item resolves via the NEAREST paragraph, not an earlier decoy paragraph further from the list",
			Boolean(caseB),
			JSON.stringify(result.projects.map((p) => p.name)),
		);
		ok("the decoy repo mentioned in the earlier, farther paragraph never wins", !result.projects.some((p) => p.repo === "example/decoy-repo"));

		const caseD = find(result.projects, "patch", "patch-1");
		ok(
			"item with no resolvable context anywhere (heading, paragraph, or this file's own H1) keeps repo null",
			Boolean(caseD) && caseD.repo === null,
			JSON.stringify(caseD),
		);
		ok("gap recorded for the no-context item", result.gaps.some((g) => g.source === "hand-patches" && /names no recognizable upstream repo/.test(g.error)));
	}
});

test("collectInventory: markdown patch-list repo fallback — the file's first H1, via a known project's name", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "patch-fallback-h1-"));
		const w = (rel, content) => {
			const abs = path.join(repoRoot, rel);
			mkdirSync(path.dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		};

		w(
			"docs/context-h1.md",
			[
				"# Tools we run: acme-h1-tool",
				"",
				"## Patches we carry for stability",
				"",
				"This preamble paragraph gives no owner, repo, or project name clue at",
				"all, purely describing why the patches below exist.",
				"",
				"1. Case C -- no repo mentioned in the item's own text or this section's heading or paragraph.",
				"",
			].join("\n"),
		);
		w(
			"hosts.md",
			[
				"| name | upstream repo | how installed | where the version is read | notes |",
				"|---|---|---|---|---|",
				"| acme-h1-tool | acme/h1-tool-upstream | brew | `acme-h1-tool --version` | fixture |",
				"",
			].join("\n"),
		);

		const neverCalled = async () => {
			throw new Error("should never be called — the host row's repo comes straight from the table");
		};
		const result = await collectInventory({ repoRoot, fs: scopedFs(repoRoot), exec: neverCalled, fetch: neverCalled, now: () => 0, hostsFile: "hosts.md" });

		const caseC = find(result.projects, "patch", "acme/h1-tool-upstream#patch-1");
		ok(
			"item with no repo in the item, heading, or nearest paragraph falls back to the file's first H1, matched by a known project's NAME (not a bare token)",
			Boolean(caseC),
			JSON.stringify(result.projects.map((p) => p.name)),
		);
	}
});

test("collectInventory: binary-pin reader ignores test paths", async () => {
	{
		const repoRoot = mkdtempSync(path.join(tmpRoot, "binary-test-paths-"));
		const w = (rel, content) => {
			const abs = path.join(repoRoot, rel);
			mkdirSync(path.dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		};

		// The identical release URL under scripts/ (detected) and under a
		// `tests/` directory nested several levels deep (ignored entirely —
		// not merely deduped, since the row below must carry exactly one
		// source, and it must be the scripts/ one).
		w("scripts/tool-e-installer.mjs", "const url = `https://github.com/acme/tool-e/" + REL + "/tag/v1.0.0`;\n");
		w("src/nested/tests/tool-e-installer.mjs", "const url = `https://github.com/acme/tool-e/" + REL + "/tag/v1.0.0`;\n");

		// A `.test.` filename is ignored even sitting directly in scripts/,
		// a directory the reader otherwise scans.
		w("scripts/tool-f-installer.test.mjs", "const url = `https://github.com/acme/tool-f/" + REL + "/tag/v1.0.0`;\n");

		const neverCalled = async () => {
			throw new Error("should never be called — no npm/CI/host row in this fixture needs a lookup");
		};
		const result = await collectInventory({ repoRoot, fs: scopedFs(repoRoot), exec: neverCalled, fetch: neverCalled, now: () => 0 });

		const toolE = find(result.projects, "binary", "tool-e");
		ok("scripts/ copy is still detected", Boolean(toolE), JSON.stringify(result.projects));
		ok(
			"the tests/ copy (any depth) was never scanned — exactly one source, from scripts/ alone",
			toolE?.sources.length === 1 && toolE.sources[0].file === "scripts/tool-e-installer.mjs",
			JSON.stringify(toolE?.sources),
		);
		ok("a .test.mjs filename is ignored even outside a test-named directory", !find(result.projects, "binary", "tool-f"));
	}
});
