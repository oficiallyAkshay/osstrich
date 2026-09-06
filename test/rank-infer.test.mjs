/**
 * test/rank-infer.test.mjs — unit tests for lib/rank.mjs and lib/infer.mjs,
 * the osstrich skill's D2 (rank) and D3-inferred (infer) phases. Ported
 * from the private core's own test suite (converted from a hand-rolled
 * `ok()`/exit-code harness to node:test). The rank suite is pure-function
 * (no I/O, no fixtures on disk).
 * The infer suite builds a REAL temp mini-repo via `mkdtempSync` and reads
 * it with real `node:fs` for the main-path assertions, then switches to a
 * hand-built fake `fs` for the failure-path / gaps[] assertions — mirroring
 * the real-fs-then-fake-fs split the knip suite uses for its own two
 * halves.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferNextSteps } from "../lib/infer.mjs";
import { rankProjects, renderRankMarkdown } from "../lib/rank.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

function ok(name, cond, detail = "") {
	assert.ok(cond, detail ? `${name} — ${detail}` : name);
}



test("osstrich-rank: rankProjects over a 6-row fixture", async () => {
{
	// stars:      alpha=10  beta=10  gamma=50  delta=200  epsilon=5  zeta=300
	// downloads:  alpha=null beta=1000 gamma=500 delta=100000 epsilon=50 zeta=200000
	const inventory = {
		projects: [
			{ name: "alpha", kind: "action", ours: "v1", latest: "v1", repo: "org/alpha", stars: 10, weeklyDownloads: null },
			{ name: "beta", kind: "npm", ours: "1.0.0", latest: "1.1.0", repo: "org/beta", stars: 10, weeklyDownloads: 1000 },
			{ name: "gamma", kind: "npm", ours: "2.0.0", latest: "2.0.0", repo: "org/gamma", stars: 50, weeklyDownloads: 500 },
			{ name: "delta", kind: "npm", ours: "3.0.0", latest: "4.0.0", repo: "org/delta", stars: 200, weeklyDownloads: 100000 },
			{ name: "epsilon", kind: "npm", ours: "0.1.0", latest: "0.1.0", repo: "org/epsilon", stars: 5, weeklyDownloads: 50 },
			{ name: "zeta", kind: "npm", ours: "5.0.0", latest: "5.5.0", repo: "org/zeta", stars: 300, weeklyDownloads: 200000 },
			// Unmeasurable rows: neither belongs in the ranked ordering at all —
			// they must never surface as fake "least popular" bottom entries.
			{ name: "redis-image", kind: "image", ours: "7.4.11", latest: null, repo: null, stars: null, weeklyDownloads: null },
			{ name: "mystery-binary", kind: "binary", ours: "1.0.0", latest: null, repo: null, stars: null, weeklyDownloads: null },
		],
		gaps: [],
	};
	const classification = [
		"| Project | Class | Reason | Override | Last verified |",
		"|---|---|---|---|---|",
		"| ORG/alpha | community | small utility | | 2026-09-01 |",
		"| org/beta | community | small utility | | 2026-09-01 |",
		"| org/delta | company | vendor SDK | | 2026-09-01 |",
		"| org/zeta | company | vendor SDK | | 2026-09-01 |",
		"| org/epsilon | company-adjacent | connector, but we carry a real patch | ship it anyway | 2026-09-01 |",
	].join("\n");

	const result = rankProjects(inventory, classification);
	const byName = Object.fromEntries(result.rows.map((r) => [r.name, r]));

	ok("stars ties share a rank (alpha === beta === 2)", byName.alpha.starsRank === 2 && byName.beta.starsRank === 2, JSON.stringify([byName.alpha.starsRank, byName.beta.starsRank]));
	ok("competition ranking skips past a tie (gamma=4 after two rank-2 entries)", byName.gamma.starsRank === 4, String(byName.gamma.starsRank));
	ok("stars rank ascends least → most popular (epsilon=1, zeta=6)", byName.epsilon.starsRank === 1 && byName.zeta.starsRank === 6, JSON.stringify([byName.epsilon.starsRank, byName.zeta.starsRank]));
	ok("null weeklyDownloads gets a null downloadsRank", byName.alpha.downloadsRank === null, String(byName.alpha.downloadsRank));
	ok("downloads ranked only over the present subset", byName.epsilon.downloadsRank === 1 && byName.zeta.downloadsRank === 5, JSON.stringify([byName.epsilon.downloadsRank, byName.zeta.downloadsRank]));
	ok("combined falls back to starsRank when downloads is null (alpha=2)", byName.alpha.combined === 2, String(byName.alpha.combined));
	ok("combined averages both ranks otherwise (beta=(2+3)/2=2.5)", byName.beta.combined === 2.5, String(byName.beta.combined));
	ok("combined for epsilon = (1+1)/2 = 1", byName.epsilon.combined === 1, String(byName.epsilon.combined));

	ok("classified rows carry their table class", byName.beta.class === "community" && byName.delta.class === "company", JSON.stringify([byName.beta.class, byName.delta.class]));
	ok("unmatched row is unclassified", byName.gamma.class === "unclassified", byName.gamma.class);
	ok("result.unclassified lists it by name", result.unclassified.includes("gamma") && result.unclassified.length === 1, JSON.stringify(result.unclassified));
	ok("company-adjacent row keeps its override text", byName.epsilon.override === "ship it anyway", byName.epsilon.override);
	ok("classification match is case-insensitive on repo (ORG/alpha → org/alpha row)", byName.alpha.class === "community", byName.alpha.class);

	const order = result.rows.map((r) => r.name);
	ok(
		"ordering: community/unclassified/override group (by combined asc) precedes company group",
		JSON.stringify(order) === JSON.stringify(["epsilon", "alpha", "beta", "gamma", "delta", "zeta"]),
		JSON.stringify(order),
	);

	const bottom3 = rankProjects(inventory, classification, { bottomN: 3 }).bottom;
	ok("bottom N takes the first N names of the ordering", JSON.stringify(bottom3) === JSON.stringify(["epsilon", "alpha", "beta"]), JSON.stringify(bottom3));
	ok("default bottomN (10) returns every RANKED row when fewer than 10 exist (the 2 unmeasurable rows are excluded, not counted)", rankProjects(inventory, classification).bottom.length === 6);

	ok(
		"an image row is excluded from rows/bottom entirely, never a fake least-popular bottom entry",
		!order.includes("redis-image") && !bottom3.includes("redis-image"),
		JSON.stringify(order),
	);
	ok(
		"a row with neither stars nor downloads is excluded the same way",
		!order.includes("mystery-binary") && !bottom3.includes("mystery-binary"),
		JSON.stringify(order),
	);
	ok(
		"both excluded rows land in result.unranked with the right reason, name-sorted",
		JSON.stringify(result.unranked) === JSON.stringify([
			{ name: "mystery-binary", reason: "no popularity data" },
			{ name: "redis-image", reason: "image" },
		]),
		JSON.stringify(result.unranked),
	);
	ok("excluded rows never enter classification (not counted in result.unclassified)", !result.unclassified.includes("redis-image") && !result.unclassified.includes("mystery-binary") && result.unclassified.length === 1, JSON.stringify(result.unclassified));

	const md = renderRankMarkdown(result);
	const mdLines = md.split("\n");
	ok("markdown starts with the documented header", mdLines[0] === "| Rank | Name | Kind | Ours → Latest | Stars | Downloads | Class | Override |", mdLines[0]);
	ok("markdown row order matches result.rows (epsilon first)", mdLines[2].includes("| epsilon |"), mdLines[2]);
	ok("markdown renders a null download as an em dash", mdLines.find((l) => l.includes("| alpha |"))?.includes("| — |"), md);
	ok("markdown renders a non-empty override verbatim", mdLines.find((l) => l.includes("| epsilon |"))?.includes("ship it anyway"), md);
	ok("markdown renders an empty override as an em dash", mdLines.find((l) => l.includes("| delta |"))?.trim().endsWith("— |"), md);
	ok(
		"markdown's main table never lists an unranked row",
		mdLines.slice(0, mdLines.indexOf("| Name | Reason |")).every((l) => !l.includes("| redis-image |") && !l.includes("| mystery-binary |")),
		md,
	);
	ok(
		"markdown appends a second table for the unranked rows, in result.unranked's own order",
		mdLines.includes("| Name | Reason |") &&
			mdLines[mdLines.indexOf("| Name | Reason |") + 2] === "| mystery-binary | no popularity data |" &&
			mdLines[mdLines.indexOf("| Name | Reason |") + 3] === "| redis-image | image |",
		md,
	);

	// A bare array of project rows is accepted the same as the wrapped object.
	const bareArrayResult = rankProjects(inventory.projects, classification);
	ok("bare-array inventory input produces the same ordering", JSON.stringify(bareArrayResult.rows.map((r) => r.name)) === JSON.stringify(order));
}
});

test("osstrich-rank: edge cases (missing table, missing repo, null stars, narrow header)", async () => {
{
	const projects = [
		{ name: "no-repo-project", kind: "host", ours: "1", latest: "1", repo: null, stars: 40, weeklyDownloads: null },
		{ name: "no-stars-project", kind: "host", ours: "1", latest: "1", repo: "org/none", stars: null, weeklyDownloads: 500 },
		{ name: "measured", kind: "npm", ours: "1", latest: "1", repo: "org/measured", stars: 100, weeklyDownloads: 100 },
		// Fully unmeasurable (both null) and an image WITH real metrics — both
		// must be pulled out of ranking, the image regardless of its numbers.
		{ name: "no-signal-binary", kind: "binary", ours: "1", latest: "1", repo: null, stars: null, weeklyDownloads: null },
		{ name: "img-with-metrics", kind: "image", ours: "1", latest: "1", repo: "org/img", stars: 999, weeklyDownloads: 999 },
	];

	const noTableResult = rankProjects(projects, undefined);
	ok("undefined classification markdown → everyone RANKED unclassified, no throw (excluded rows never enter classification)", noTableResult.unclassified.length === 3, JSON.stringify(noTableResult.unclassified));

	const emptyTableResult = rankProjects(projects, "");
	ok("empty-string classification markdown behaves the same as undefined", emptyTableResult.unclassified.length === 3);

	const nullStarsRow = noTableResult.rows.find((r) => r.name === "no-stars-project");
	ok("null stars with a REAL downloads figure keeps the row ranked, stars treated as least-popular (rank 1)", nullStarsRow.starsRank === 1, String(nullStarsRow.starsRank));

	const noRepoRow = noTableResult.rows.find((r) => r.name === "no-repo-project");
	ok("a project with no repo at all is unclassified, not a crash", noRepoRow.class === "unclassified");

	ok("a row with both stars and downloads null never reaches rows/bottom", !noTableResult.rows.some((r) => r.name === "no-signal-binary"));
	ok("an image row is pulled out even when it carries real stars/downloads", !noTableResult.rows.some((r) => r.name === "img-with-metrics"));
	ok(
		"both land in unranked with the right reason, name-sorted",
		JSON.stringify(noTableResult.unranked) === JSON.stringify([
			{ name: "img-with-metrics", reason: "image" },
			{ name: "no-signal-binary", reason: "no popularity data" },
		]),
		JSON.stringify(noTableResult.unranked),
	);

	// Header present but missing the Override / Last-verified columns entirely.
	const narrowTable = ["| Project | Class | Reason |", "|---|---|---|", "| org/measured | community | small |"].join("\n");
	const narrowResult = rankProjects(projects, narrowTable);
	const measuredRow = narrowResult.rows.find((r) => r.name === "measured");
	ok("a classification table missing Override/Last-verified still parses Class", measuredRow.class === "community", measuredRow.class);
	ok("a missing Override column defaults to an empty string, not a crash", measuredRow.override === "", JSON.stringify(measuredRow.override));

	// A line that isn't part of the table at all (no leading "|") is ignored,
	// and a table with no recognizable header produces zero matches.
	const junkTable = ["some prose that is not a table", "| not a header row either |"].join("\n");
	const junkResult = rankProjects(projects, junkTable);
	ok("a markdown blob with no Project/Class header classifies nothing", junkResult.unclassified.length === 3);
}
});

test("osstrich-rank: DEFECT A — a 404'd upstream repo lookup never ranks by downloads alone", async () => {
{
	// The exact battle-test row + gap: shellcheck's npm lookup succeeded
	// (downloads present) but its GitHub repo lookup 404'd — it must never
	// land in the ranked table, let alone rank #1 by downloads alone.
	const inventory = {
		projects: [
			{ name: "shellcheck", kind: "npm", repo: "gunar/shellcheck", stars: null, weeklyDownloads: 80385 },
			{ name: "safe-npm-pkg", kind: "npm", repo: "org/safe-npm-pkg", stars: null, weeklyDownloads: 500 },
			{ name: "also-404", kind: "npm", repo: "org/also-404", stars: null, weeklyDownloads: 42 },
		],
		gaps: [
			{ source: "github-metadata", file: "gunar/shellcheck", error: "gh api repos/gunar/shellcheck failed: ... HTTP 404" },
			// "Not Found" without the literal string "404" must also match.
			{ source: "github-metadata", file: "org/also-404", error: "gh api repos/org/also-404 failed: gh: Not Found" },
			// A non-github-metadata gap and a non-404 github-metadata gap must
			// never exclude a project — only the exact source+error shape does.
			{ source: "npm", file: "org/safe-npm-pkg", error: "version drift, unrelated" },
		],
	};

	const result = rankProjects(inventory, undefined);
	const rankedNames = result.rows.map((r) => r.name);

	ok("the 404'd project is excluded from rows entirely", !rankedNames.includes("shellcheck"), JSON.stringify(rankedNames));
	ok("the 404'd project is excluded from bottom entirely", !result.bottom.includes("shellcheck"), JSON.stringify(result.bottom));
	ok(
		"it lands in unranked with the new reason, not the generic 'no popularity data' one",
		result.unranked.some((u) => u.name === "shellcheck" && u.reason === "upstream repo not found"),
		JSON.stringify(result.unranked),
	);
	ok(
		"a 'Not Found' (no literal '404') error text also excludes the row",
		result.unranked.some((u) => u.name === "also-404" && u.reason === "upstream repo not found"),
		JSON.stringify(result.unranked),
	);
	ok(
		"a row with null stars but real downloads and NO 404 gap still ranks (existing behaviour, kept green)",
		rankedNames.includes("safe-npm-pkg"),
		JSON.stringify(rankedNames),
	);

	const md = renderRankMarkdown(result);
	const mdLines = md.split("\n");
	const unrankedHeaderIdx = mdLines.indexOf("| Name | Reason |");
	ok("rendered markdown never lists shellcheck in the main ranked table", mdLines.slice(0, unrankedHeaderIdx).every((l) => !l.includes("| shellcheck |")), md);
	ok("rendered markdown lists shellcheck in the unranked table with the new reason", md.includes("| shellcheck | upstream repo not found |"), md);
}

// ════════════════════════════════════════════════════════════════════════
console.log("\n── osstrich-rank: a hand-patch row (kind: \"patch\") never enters the ranking pool");
// ════════════════════════════════════════════════════════════════════════
{
	// A patch row shares its `repo` with the real project row it patches
	// (`shared/osstrich-inventory.mjs`'s hand-patch reader), but is its own
	// `name` (`<repo>#patch-N`) — it must never be ranked/bottomed as if it
	// were a project of its own, even when a GitHub lookup gave it real
	// stars (the same repo the underlying npm row already resolved).
	const inventory = {
		projects: [
			{ name: "acme-widget", kind: "npm", repo: "acme/widget", stars: 40, weeklyDownloads: 1000 },
			{ name: "acme/widget#patch-1", kind: "patch", repo: "acme/widget", stars: 40, weeklyDownloads: null },
			{ name: "other-pkg", kind: "npm", repo: "org/other", stars: 60, weeklyDownloads: 2000 },
		],
		gaps: [],
	};

	const result = rankProjects(inventory, undefined);
	const rankedNames = result.rows.map((r) => r.name);

	ok("the patch row is absent from rows", !rankedNames.includes("acme/widget#patch-1"), JSON.stringify(rankedNames));
	ok("the patch row is absent from bottom", !result.bottom.includes("acme/widget#patch-1"), JSON.stringify(result.bottom));
	ok("the underlying project row still ranks normally", rankedNames.includes("acme-widget"), JSON.stringify(rankedNames));
	ok(
		"the patch row lands in unranked with the hand-patch reason",
		result.unranked.some((u) => u.name === "acme/widget#patch-1" && u.reason === "hand patch (a need signal, not a project)"),
		JSON.stringify(result.unranked),
	);
}
});

test("osstrich-rank: a missing classification file records a gap, never silently unclassified with no signal", async () => {
{
	const inventory = {
		projects: [
			{ name: "alpha", kind: "npm", repo: "org/alpha", stars: 10, weeklyDownloads: 100 },
			{ name: "beta", kind: "npm", repo: "org/beta", stars: 20, weeklyDownloads: 200 },
		],
		gaps: [],
	};

	// classificationMissing: false (the default) — no gap, matching every
	// existing "no table" test above.
	const presentResult = rankProjects(inventory, undefined, { classificationMissing: false, classificationPath: "/repo/.osstrich/classification.md" });
	ok("gaps is an empty array when the file isn't reported missing", Array.isArray(presentResult.gaps) && presentResult.gaps.length === 0, JSON.stringify(presentResult.gaps));

	// classificationMissing: true — one gap, naming the path and the count
	// of projects that stayed unclassified as a result.
	const missingResult = rankProjects(inventory, "", { classificationMissing: true, classificationPath: "/repo/.osstrich/classification.md" });
	ok("result.gaps carries exactly one classification gap", Array.isArray(missingResult.gaps) && missingResult.gaps.length === 1, JSON.stringify(missingResult.gaps));
	ok(
		"the gap names the source, the configured path, and the unclassified count",
		missingResult.gaps[0]?.source === "classification" &&
			missingResult.gaps[0]?.file === "/repo/.osstrich/classification.md" &&
			missingResult.gaps[0]?.error === "classification file missing; 2 projects unclassified",
		JSON.stringify(missingResult.gaps),
	);
	ok("every project still ranks, just unclassified — a missing file never drops a project", missingResult.rows.length === 2 && missingResult.unclassified.length === 2);
}
});

test("osstrich-infer: real fixture repo — every signal, the cap, the skip list, decoys", async () => {
const tmpRoot = mkdtempSync(join(tmpdir(), "osstrich-infer-test-"));
try {
	// (a) patch-file — filename form, under patches/.
	mkdirSync(join(tmpRoot, "patches"), { recursive: true });
	writeFileSync(join(tmpRoot, "patches", "acme-pad+1.0.2.patch"), "--- a/index.js\n+++ b/index.js\n");

	// (a) patch-file — structured pnpm patchedDependencies form (scoped).
	// (b) override — overrides key.
	// (c) exact-pin — cross-env-clone pinned with no range operator;
	//     acme-pad left as a caret range on purpose (must NOT also fire
	//     exact-pin).
	writeFileSync(
		join(tmpRoot, "package.json"),
		JSON.stringify(
			{
				name: "fixture-repo",
				dependencies: { "cross-env-clone": "7.0.3", "acme-pad": "^1.0.2" },
				overrides: { "acme-minimist": "1.2.6" },
				patchedDependencies: { "@scope/widget@2.0.0": "patches/@scope+widget+2.0.0.patch" },
			},
			null,
			"\t",
		),
	);

	// (d) code-note — a TODO naming acme-pad, plus a plain-substring decoy
	// ("expression" must not fire the "express-clone" project) and a
	// hyphen-compound decoy ("acme-pad-cli" must not fire "acme-pad", and
	// "pad" must not fire inside "acme-pad").
	mkdirSync(join(tmpRoot, "shared"), { recursive: true });
	writeFileSync(
		join(tmpRoot, "shared", "foo.mjs"),
		[
			"// TODO: workaround for an acme-pad padding bug on empty strings",
			"// HACK: this expression evaluator has a real quirk we work around",
			"// acme-pad-cli is a different, unrelated tool",
			"export const x = 1;",
		].join("\n"),
	);

	// (e) doc-note — names acme-minimist alongside "unpin" and an issue
	// number. Doc notes now come from EVERY *.md file outside skipDirs/
	// ignore — no repo-specific restriction — so a plain top-level doc
	// directory works exactly the same as any other.
	mkdirSync(join(tmpRoot, "docs"), { recursive: true });
	writeFileSync(
		join(tmpRoot, "docs", "gotchas-foo.md"),
		["# Foo gotchas", "", "Retired the acme-minimist workaround; unpin once acme-minimist ships a fix (see #1234)."].join("\n"),
	);

	// Skip-list: a node_modules file that would otherwise fire code-note for
	// acme-minimist AND acme-pad must be invisible to the walk.
	mkdirSync(join(tmpRoot, "node_modules", "some-lib"), { recursive: true });
	writeFileSync(join(tmpRoot, "node_modules", "some-lib", "index.js"), "// TODO workaround for acme-minimist and acme-pad quirks\n");

	// Skip-list: `skipDirs` is a caller-supplied option (no repo-specific
	// default baked into this module) — a bare name AND a relative-path
	// prefix, passed explicitly by this test, must both be honored.
	mkdirSync(join(tmpRoot, "nested-checkout", "shared"), { recursive: true });
	writeFileSync(join(tmpRoot, "nested-checkout", "shared", "dup.mjs"), "// TODO workaround for acme-minimist quirk\n");
	mkdirSync(join(tmpRoot, "vendor", "dropped"), { recursive: true });
	writeFileSync(join(tmpRoot, "vendor", "dropped", "note.md"), "acme-minimist workaround pinned here, must stay invisible\n");

	// Skip-list: the built-in generic default (node_modules, .git, coverage,
	// dist, build) still applies with no options at all.
	mkdirSync(join(tmpRoot, "coverage"), { recursive: true });
	writeFileSync(join(tmpRoot, "coverage", "report.js"), "// TODO workaround for acme-minimist quirk\n");
	mkdirSync(join(tmpRoot, ".git"), { recursive: true });
	writeFileSync(join(tmpRoot, ".git", "hook.sh"), "# TODO workaround for acme-minimist quirk\n");

	// Cap test: 60 distinct code-note hits for one project, in TWO files
	// created in reverse-alphabetical order so the (file, line) sort is a
	// real assertion, not an accident of directory order.
	const capLines1 = Array.from({ length: 30 }, (_, i) => `// TODO capproj hit ${i} in zzz`);
	const capLines2 = Array.from({ length: 30 }, (_, i) => `// TODO capproj hit ${i} in aaa`);
	writeFileSync(join(tmpRoot, "zzz-file.mjs"), capLines1.join("\n"));
	writeFileSync(join(tmpRoot, "aaa-file.mjs"), capLines2.join("\n"));

	// (e) doc-note per-file cap: the 5-hits-per-(project,file) cap applies
	// to EVERY doc file alike now — no MANIFEST_HISTORY-shaped special
	// case — so an ordinary, non-special doc file still caps at 5 even
	// though 8 lines here would otherwise all fire for "historyproj".
	writeFileSync(join(tmpRoot, "docs", "changelog.md"), Array.from({ length: 8 }, (_, i) => `- retired the historyproj workaround, entry ${i}`).join("\n"));

	// (e) `ignore` option: a doc path a caller marks as its own generated
	// notes ABOUT upstream — excluded from doc-note scanning even though it
	// names a project alongside a watch-word. A doc file OUTSIDE the
	// ignored prefix, naming the SAME project the same way, still fires —
	// proving the option is scoped, not a blanket exclusion.
	mkdirSync(join(tmpRoot, "generated", "repos"), { recursive: true });
	writeFileSync(join(tmpRoot, "generated", "repos", "excludedproj.md"), "excludedproj workaround retired upstream\n");
	writeFileSync(join(tmpRoot, "docs", "excludedproj-elsewhere.md"), "excludedproj workaround retired upstream, tracked here instead\n");

	// (f) hand-patch: `kind: "patch"` rows (osstrich-inventory.mjs's
	// hand-patch reader) are named `<repo>#patch-<n>` and must never be
	// matched as a NAME — instead each becomes one hand-patch hit filed
	// under the project sharing its repo, using the row's OWN `sources[0]`
	// for file/line (never a hardcoded reference path).
	const acmePatchWithLine = {
		name: "acme/widget#patch-1",
		kind: "patch",
		repo: "acme/widget",
		label: "Carry a spawn-timeout fix ahead of upstream release",
		sources: [{ file: "docs/patches.md", line: 42 }],
	};
	const acmePatchSourceNoLine = {
		name: "acme/widget#patch-2",
		kind: "patch",
		repo: "acme/widget",
		label: "A second acme/widget patch whose source has no recorded line",
		sources: [{ file: "docs/patches.md" }],
	};
	const acmePatchNoSourcesAtAll = {
		name: "acme/widget#patch-3",
		kind: "patch",
		repo: "acme/widget",
		label: "A third patch with no sources array at all — produces no hit",
	};
	const orphanPatch = { name: "unknown-thing#patch-4", kind: "patch", repo: null, label: "A patch with no known repo must match nothing", sources: [{ file: "docs/patches.md", line: 1 }] };

	// Decoy: a doc line naming the patch row's own `<repo>#patch-<n>` string
	// alongside a watch-word must never attribute a hit to that NAME (only
	// the real "acme" project name inside it may legitimately fire).
	writeFileSync(join(tmpRoot, "docs", "patch-decoy.md"), "acme/widget#patch-1 workaround decoy — must never self-match\n");

	const projects = [
		{ name: "acme-pad", repo: "acme/pad" },
		{ name: "pad", repo: "example/pad" }, // decoy target for "acme-pad"
		{ name: "express-clone", repo: "example/express-clone" }, // decoy target for "expression"
		{ name: "cross-env-clone", repo: "example/cross-env-clone" },
		{ name: "acme-minimist", repo: "example/acme-minimist" },
		{ name: "@scope/widget", repo: "example/scoped-widget" },
		{ name: "capproj", repo: "example/capproj" },
		{ name: "historyproj", repo: "example/historyproj" },
		{ name: "excludedproj", repo: "example/excludedproj" },
		{ name: "acme", repo: "acme/widget" },
		{ name: "unrelated-repo", repo: "example/unrelated" },
		acmePatchWithLine,
		acmePatchSourceNoLine,
		acmePatchNoSourcesAtAll,
		orphanPatch,
	];

	const realFs = { readdirSync, readFileSync };
	const skipDirs = ["node_modules", ".git", "coverage", "dist", "build", "nested-checkout", "vendor/dropped"];
	const ignore = ["generated/repos"];
	const result = inferNextSteps({ repoRoot: tmpRoot, fs: realFs, projects, skipDirs, ignore });

	ok("(a) patch-file fires from a patches/ filename", (result.byProject["acme-pad"] || []).some((h) => h.signal === "patch-file" && h.file === "patches/acme-pad+1.0.2.patch"), JSON.stringify(result.byProject["acme-pad"]));
	ok(
		"(a) patch-file fires from a structured patchedDependencies key (scoped, version stripped)",
		(result.byProject["@scope/widget"] || []).some((h) => h.signal === "patch-file" && h.file === "package.json"),
		JSON.stringify(result.byProject["@scope/widget"]),
	);
	ok("(b) override fires for a package.json overrides key", (result.byProject["acme-minimist"] || []).some((h) => h.signal === "override" && h.file === "package.json"), JSON.stringify(result.byProject["acme-minimist"]));
	ok("(c) exact-pin fires for a no-range dependency version", (result.byProject["cross-env-clone"] || []).some((h) => h.signal === "exact-pin"), JSON.stringify(result.byProject["cross-env-clone"]));
	ok("(c) exact-pin does NOT fire for a caret-ranged dependency", !(result.byProject["acme-pad"] || []).some((h) => h.signal === "exact-pin"), JSON.stringify(result.byProject["acme-pad"]));
	ok("(d) code-note fires for a TODO naming a project", (result.byProject["acme-pad"] || []).some((h) => h.signal === "code-note" && h.file === "shared/foo.mjs"), JSON.stringify(result.byProject["acme-pad"]));
	ok("(e) doc-note fires for a plain doc file naming a project with a watch-word", (result.byProject["acme-minimist"] || []).some((h) => h.signal === "doc-note" && h.file === "docs/gotchas-foo.md"), JSON.stringify(result.byProject["acme-minimist"]));

	ok("decoy: 'pad' does not fire inside 'acme-pad' or 'acme-pad+1.0.2.patch'", !(result.byProject.pad || []).length, JSON.stringify(result.byProject.pad));
	ok("decoy: 'express-clone' does not fire inside 'expression'", !(result.byProject["express-clone"] || []).length, JSON.stringify(result.byProject["express-clone"]));
	ok(
		"code-note text does not conflate 'acme-pad-cli' with 'acme-pad' beyond the true hit",
		(result.byProject["acme-pad"] || []).filter((h) => h.signal === "code-note").length === 1,
		JSON.stringify(result.byProject["acme-pad"]),
	);

	ok("node_modules is invisible to every signal (built-in default)", !(result.byProject["acme-minimist"] || []).some((h) => h.file.includes("node_modules")), JSON.stringify(result.byProject["acme-minimist"]));
	ok("a custom skipDirs bare name (nested-checkout) is invisible", !(result.byProject["acme-minimist"] || []).some((h) => h.file.includes("nested-checkout")), JSON.stringify(result.byProject["acme-minimist"]));
	ok("a custom skipDirs relative prefix (vendor/dropped) is invisible", !(result.byProject["acme-minimist"] || []).some((h) => h.file.includes("vendor/dropped")), JSON.stringify(result.byProject["acme-minimist"]));
	ok("coverage/ is invisible to every signal (built-in default)", !(result.byProject["acme-minimist"] || []).some((h) => h.file.includes("coverage/")));
	ok(".git/ is invisible to every signal (built-in default)", !(result.byProject["acme-minimist"] || []).some((h) => h.file.includes(".git/")));
	ok("acme-minimist's only real hits are the override and the doc-note (2 total)", (result.byProject["acme-minimist"] || []).length === 2, JSON.stringify(result.byProject["acme-minimist"]));

	ok("cap: capproj is capped at 50 hits even though 60 exist", (result.byProject.capproj || []).length === 50, String((result.byProject.capproj || []).length));
	const capHits = result.byProject.capproj;
	ok("determinism: capped hits are sorted by file then line ('aaa-file.mjs' entirely before 'zzz-file.mjs')", capHits.every((h, i) => i === 0 || capHits[i - 1].file <= h.file), JSON.stringify(capHits.slice(0, 3)));
	ok("determinism: within a file, hits are line-ascending", capHits.filter((h) => h.file === "aaa-file.mjs").every((h, i, arr) => i === 0 || arr[i - 1].line <= h.line));

	ok("text is trimmed/capped and never includes a trailing newline", capHits.every((h) => !h.text.includes("\n") && h.text.length <= 200));

	ok(
		"(e) the per-(project,file) doc-note cap of 5 applies to ANY doc file, not just a special-cased one, even though 8 lines match",
		(result.byProject.historyproj || []).filter((h) => h.signal === "doc-note" && h.file === "docs/changelog.md").length === 5,
		JSON.stringify(result.byProject.historyproj),
	);
	ok(
		"(e) `ignore` excludes a caller-marked doc path from doc-note scanning",
		!(result.byProject.excludedproj || []).some((h) => h.file === "generated/repos/excludedproj.md"),
		JSON.stringify(result.byProject.excludedproj),
	);
	ok(
		"(e) the SAME project named the same way OUTSIDE the ignored prefix still fires — `ignore` is scoped, not a blanket exclusion",
		(result.byProject.excludedproj || []).some((h) => h.file === "docs/excludedproj-elsewhere.md"),
		JSON.stringify(result.byProject.excludedproj),
	);

	ok(
		"(f) hand-patch fires under the project sharing the patch row's repo, using the row's OWN sources[0] file/line — never a hardcoded path",
		(result.byProject.acme || []).some((h) => h.signal === "hand-patch" && h.file === "docs/patches.md" && h.line === 42 && h.text === acmePatchWithLine.label),
		JSON.stringify(result.byProject.acme),
	);
	ok(
		"(f) a patch row whose source has no recorded line defaults to line 1 (file still comes from sources[0])",
		(result.byProject.acme || []).some((h) => h.signal === "hand-patch" && h.file === "docs/patches.md" && h.line === 1 && h.text === acmePatchSourceNoLine.label),
		JSON.stringify(result.byProject.acme),
	);
	ok(
		"(f) a patch row with NO sources array at all produces no hit — never a fabricated location",
		!(result.byProject.acme || []).some((h) => h.text === acmePatchNoSourcesAtAll.label),
		JSON.stringify(result.byProject.acme),
	);
	ok(
		"(f) a patch row with no repo produces zero hits anywhere, never a crash",
		Object.values(result.byProject).every((hits) => !hits.some((h) => h.text === orphanPatch.label)),
	);
	ok(
		"(f) a patch row is never itself a byProject key — patch rows are excluded from name-matching entirely",
		!result.byProject[acmePatchWithLine.name] && !result.byProject[acmePatchSourceNoLine.name] && !result.byProject[acmePatchNoSourcesAtAll.name] && !result.byProject[orphanPatch.name],
		JSON.stringify(Object.keys(result.byProject)),
	);
	ok("(f) an unrelated project (a different repo) gets no hand-patch hit", !(result.byProject["unrelated-repo"] || []).some((h) => h.signal === "hand-patch"));

	const secondRun = inferNextSteps({ repoRoot: tmpRoot, fs: realFs, projects, skipDirs, ignore });
	ok("determinism: two runs over the same fixture produce identical output", JSON.stringify(secondRun) === JSON.stringify(result));

	ok("gaps is always an array, even on a clean run", Array.isArray(result.gaps));
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}
});

test("osstrich-infer: fail-soft paths via a fake fs (gaps[], never a throw)", async () => {
{
	const projects = [{ name: "widget", repo: "org/widget" }];

	// repoRoot itself is unreadable.
	const brokenRootFs = {
		readdirSync: () => {
			throw new Error("ENOENT: no such directory");
		},
		readFileSync: () => {
			throw new Error("should not be called");
		},
	};
	const brokenRootResult = inferNextSteps({ repoRoot: "/does/not/exist", fs: brokenRootFs, projects });
	ok("an unreadable repo root produces zero hits and a gap, never a throw", Object.keys(brokenRootResult.byProject).length === 0 && brokenRootResult.gaps.some((g) => g.reason.includes("repo root not found")), JSON.stringify(brokenRootResult.gaps));

	// One directory readable (root), files inside it throw on read.
	const unreadableFileFs = {
		readdirSync: (dir) => {
			if (dir === "/fake-repo") return [{ name: "package.json", isDirectory: () => false, isFile: () => true }];
			return [];
		},
		readFileSync: () => {
			throw new Error("EACCES: permission denied");
		},
	};
	const unreadableFileResult = inferNextSteps({ repoRoot: "/fake-repo", fs: unreadableFileFs, projects });
	ok(
		"an unreadable manifest is recorded as a gap, not a crash",
		unreadableFileResult.gaps.some((g) => g.source === "package.json" && g.reason.includes("failed to read manifest")),
		JSON.stringify(unreadableFileResult.gaps),
	);

	// A package.json that exists and reads but is not valid JSON.
	const badJsonFs = {
		readdirSync: (dir) => (dir === "/fake-repo-2" ? [{ name: "package.json", isDirectory: () => false, isFile: () => true }] : []),
		readFileSync: () => "{ not valid json ",
	};
	const badJsonResult = inferNextSteps({ repoRoot: "/fake-repo-2", fs: badJsonFs, projects });
	ok(
		"malformed package.json JSON is recorded as a gap, not a crash",
		badJsonResult.gaps.some((g) => g.source === "package.json" && g.reason.includes("failed to parse manifest JSON")),
		JSON.stringify(badJsonResult.gaps),
	);

	// A code/doc file that exists per readdirSync but throws on readFileSync
	// (races, permissions) is a gap too, and the walk keeps going.
	const flakyFileFs = {
		readdirSync: (dir) => {
			if (dir === "/fake-repo-3") return [{ name: "shared", isDirectory: () => true, isFile: () => false }];
			if (dir === "/fake-repo-3/shared") return [{ name: "broken.mjs", isDirectory: () => false, isFile: () => true }];
			return [];
		},
		readFileSync: () => {
			throw new Error("EIO");
		},
	};
	const flakyResult = inferNextSteps({ repoRoot: "/fake-repo-3", fs: flakyFileFs, projects });
	ok(
		"an unreadable code file is recorded as a gap under signal (d)/(e) scanning",
		flakyResult.gaps.some((g) => g.source === "shared/broken.mjs" && g.reason === "failed to read file"),
		JSON.stringify(flakyResult.gaps),
	);
}
});
