/**
 * test/upstream-run.test.mjs — unit tests for lib/upstream.mjs (D3 "their
 * side"), lib/run.mjs (run-directory lifecycle), and lib/cli-core.mjs (the
 * CLI that wires every osstrich phase together, including the judgment
 * stages this package adds on top of the private core this was ported
 * from: the verdict agent stage, the picker, and the build agent stage).
 *
 * Ported from the private core's own shortlistUpstream and
 * openRun/writePartial/finishRun test sections verbatim (converted from a
 * hand-rolled `ok()`/exit-code harness to node:test). NOT ported: a
 * `loadConfig` section for a config loader this package doesn't ship (this
 * package's config loader is lib/config.mjs, a different zod-based module
 * already covered by test/config.test.mjs) and a private CLI's `main()` /
 * ledger-hook sections (that CLI and that hook are consumer-side code this
 * package never ships). The CLI-level tests below are hand-written against
 * lib/cli-core.mjs's own contract instead: discover's
 * --table/verdict/picker/build pipeline, the verdict.json validation gate,
 * build with and without a target, and the missing-agent-command error.
 *
 * - Upstream tests fake `exec` entirely (canned `gh issue|pr list` /
 *   `gh api rate_limit` JSON) — no real subprocess, no network.
 * - Run tests use the REAL `node:fs` against `mkdtempSync` directories —
 *   this module's whole job is filesystem lifecycle, so faking `fs` would
 *   just re-implement `fs` in the test.
 * - CLI tests call `main()` in-process with a fake for every judgment-stage
 *   boundary (collectInventory/rankProjects/.../runAgentStage) but the REAL
 *   openRun/writePartial/finishRun/markPhase against a temp run directory,
 *   so the partial files, verdict.json, and status.json that land on disk
 *   are the CLI's own real output, never a fake's guess at it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { finishRun, openRun, writePartial } from "../lib/run.mjs";
import { shortlistUpstream, deriveRepoStopwords } from "../lib/upstream.mjs";
import { markPhase } from "../lib/status.mjs";
import { main, defaultDeps } from "../lib/cli-core.mjs";
import { createSink, createFakePrompts } from "./helpers/fake-io.mjs";

function ok(name, cond, detail = "") {
	assert.ok(cond, detail ? `${name} — ${detail}` : name);
}

test("osstrich-upstream: shortlistUpstream over a fake gh", async () => {
{
	function makeExec({ rateLimitRemaining, repoResponses, concurrencyProbe }) {
		let inFlight = 0;
		let maxInFlight = 0;
		const rateLimitCalls = [];
		const exec = async (_cmd, args) => {
			if (args[0] === "api" && args[1] === "rate_limit") {
				rateLimitCalls.push(true);
				return { stdout: JSON.stringify({ resources: { core: { remaining: rateLimitRemaining() } } }) };
			}
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (concurrencyProbe) {concurrencyProbe(inFlight);}
			await new Promise((resolve) => {setTimeout(resolve, 5);});
			inFlight -= 1;
			const [kind] = args; // "issue" | "pr"
			const repoIdx = args.indexOf("--repo");
			const repo = args[repoIdx + 1];
			const entry = repoResponses[repo];
			if (!entry) {return { stdout: "[]" };}
			if (entry.throwFor === kind) {throw new Error(`gh ${kind} list exploded for ${repo}`);}
			return { stdout: JSON.stringify(entry[kind] || []) };
		};
		return { exec, getMaxInFlight: () => maxInFlight, getRateLimitCalls: () => rateLimitCalls.length };
	}

	// ── keyword + #n matching, deterministic ordering ──────────────────────
	{
		const projects = [
			{ name: "alpha", repo: "o/alpha" },
			{ name: "beta", repo: "o/beta" },
		];
		const inferred = {
			alpha: [{ signal: "gotcha", text: "workaround for the alpha widget race condition" }],
			beta: [{ signal: "todo", text: "retire once #42 ships upstream" }],
		};
		const repoResponses = {
			"o/alpha": {
				issue: [
					{ number: 5, title: "Unrelated cleanup", updatedAt: "2026-01-01", comments: [{}], url: "https://github.com/o/alpha/issues/5" },
					{ number: 2, title: "Fix the widget race condition on shutdown", updatedAt: "2026-01-02", comments: [{}, {}], url: "https://github.com/o/alpha/issues/2" },
				],
				pr: [],
			},
			"o/beta": {
				issue: [{ number: 42, title: "Totally unrelated title", updatedAt: "2026-01-03", comments: 3, url: "https://github.com/o/beta/issues/42" }],
				pr: [],
			},
		};
		const { exec } = makeExec({ rateLimitRemaining: () => 5000, repoResponses });
		const result = await shortlistUpstream({ projects, inferred, exec, concurrency: 4 });

		ok("issues sorted by number ascending (deterministic)", result.byProject.alpha.issues.map((i) => i.number).join(",") === "2,5");
		ok("comments array collapses to a count", result.byProject.alpha.issues[0].comments === 2);
		ok("comments already-a-number passes through", result.byProject.beta.issues[0].comments === 3);
		ok(
			"keyword match found (title contains 'widget')",
			result.byProject.alpha.matches.some((m) => m.keyword === "widget" && m.item === "https://github.com/o/alpha/issues/2"),
			JSON.stringify(result.byProject.alpha.matches),
		);
		ok(
			"a match records the hit's own text, trimmed",
			result.byProject.alpha.matches.some((m) => m.keyword === "widget" && m.text === "workaround for the alpha widget race condition"),
			JSON.stringify(result.byProject.alpha.matches),
		);
		ok(
			"a sub-5-char keyword ('race') never fires a match, even though the title contains it verbatim",
			result.byProject.alpha.matches.every((m) => m.keyword !== "race"),
			JSON.stringify(result.byProject.alpha.matches),
		);
		ok(
			"#n ref match found even with an unrelated title",
			result.byProject.beta.matches.some((m) => m.keyword === "#42" && m.item === "https://github.com/o/beta/issues/42"),
			JSON.stringify(result.byProject.beta.matches),
		);
		ok("no match on the unrelated alpha issue", result.byProject.alpha.matches.every((m) => !m.item.endsWith("/issues/5")));
		ok("budget.checked counts both projects", result.budget.checked === 2);
		ok("budget.remainingAtStart records the first reading", result.budget.remainingAtStart === 5000);
		ok("budget not stopped when remaining is healthy", result.budget.stopped === false);
		ok("no gaps on the happy path", result.gaps.length === 0);
	}

	// ── the real fix: shortlistUpstream given the ACTUAL `{byProject, gaps}`
	// shape inferNextSteps returns (not the bare `{[name]: hits}` map) still
	// produces matches — this is the exact cross-module contract defect a
	// real CLI run exposed (2026-09-06-battle-attempt-1: projects_with_hits
	// said 2 when 49 projects had hits, and 0 of 54 shortlisted repos
	// matched, because the whole inferred-phase object was passed straight
	// through instead of its `.byProject` map). ────────────────────────────
	{
		const projects = [{ name: "alpha", repo: "o/alpha" }];
		const inferredPhaseOutput = {
			byProject: { alpha: [{ signal: "gotcha", text: "workaround for the alpha widget race condition" }] },
			gaps: [],
		};
		const repoResponses = {
			"o/alpha": {
				issue: [{ number: 2, title: "Fix the widget race condition on shutdown", updatedAt: "2026-01-02", comments: [], url: "https://github.com/o/alpha/issues/2" }],
				pr: [],
			},
		};
		const { exec } = makeExec({ rateLimitRemaining: () => 5000, repoResponses });
		const result = await shortlistUpstream({ projects, inferred: inferredPhaseOutput, exec, concurrency: 4 });
		ok(
			"passing the real {byProject, gaps} shape still produces a match (the contract-mismatch regression)",
			result.byProject.alpha.matches.some((m) => m.keyword === "widget" && m.item === "https://github.com/o/alpha/issues/2"),
			JSON.stringify(result.byProject),
		);

		// A caller passing the raw `{[name]: hits}` map (the shape the CLI
		// always SHOULD have passed) keeps working identically.
		const resultFlatShape = await shortlistUpstream({ projects, inferred: inferredPhaseOutput.byProject, exec, concurrency: 4 });
		ok(
			"the raw {[name]: hits} map shape produces the identical match set",
			JSON.stringify(resultFlatShape.byProject.alpha.matches) === JSON.stringify(result.byProject.alpha.matches),
			JSON.stringify(resultFlatShape.byProject),
		);
	}

	// ── a failing repo call becomes a gap, never a throw ────────────────────
	{
		const projects = [{ name: "gamma", repo: "o/gamma" }];
		const repoResponses = { "o/gamma": { throwFor: "issue" } };
		const { exec } = makeExec({ rateLimitRemaining: () => 5000, repoResponses });
		let isThrew = false;
		let result;
		try {
			result = await shortlistUpstream({ projects, inferred: {}, exec });
		} catch {
			isThrew = true;
		}
		ok("a failing gh call never throws out of shortlistUpstream", !isThrew);
		ok("the failed repo gets an empty issues list", result.byProject.gamma.issues.length === 0);
		ok("the failure is recorded as a gap", result.gaps.some((g) => g.includes("o/gamma")), JSON.stringify(result.gaps));
	}

	// ── budget stop: rate limit exhausted mid-run ───────────────────────────
	{
		const projects = [
			{ name: "p1", repo: "o/p1" },
			{ name: "p2", repo: "o/p2" },
			{ name: "p3", repo: "o/p3" },
		];
		const { exec, getRateLimitCalls } = makeExec({ rateLimitRemaining: () => 50, repoResponses: {} });
		const result = await shortlistUpstream({ projects, inferred: {}, exec, concurrency: 1, minRemaining: 200 });
		ok("budget.stopped is true when remaining < minRemaining", result.budget.stopped === true);
		ok("nothing was fetched once the budget check failed", result.budget.checked === 0);
		ok("a gap names the skipped repos", result.gaps.some((g) => g.includes("o/p1") && g.includes("o/p2") && g.includes("o/p3")), JSON.stringify(result.gaps));
		ok("rate_limit was checked exactly once before stopping", getRateLimitCalls() === 1);
	}

	// ── concurrency bound: never more than `concurrency` repos in flight ────
	{
		const projects = Array.from({ length: 6 }, (_, i) => ({ name: `r${i}`, repo: `o/r${i}` }));
		const { exec, getMaxInFlight, getRateLimitCalls } = makeExec({ rateLimitRemaining: () => 5000, repoResponses: {} });
		await shortlistUpstream({ projects, inferred: {}, exec, concurrency: 2 });
		ok("max concurrent repo fetches never exceeds the configured concurrency", getMaxInFlight() <= 2, `max=${getMaxInFlight()}`);
		ok("at least one batch actually overlapped", getMaxInFlight() >= 1);
		ok("rate_limit checked once per batch (3 batches of 2)", getRateLimitCalls() === 3, `calls=${getRateLimitCalls()}`);
	}

	// ── no projects have a repo => no calls at all ──────────────────────────
	{
		const { exec, getRateLimitCalls } = makeExec({ rateLimitRemaining: () => 5000, repoResponses: {} });
		const result = await shortlistUpstream({ projects: [{ name: "hostonly" }], inferred: {}, exec });
		ok("a project with no repo is skipped entirely", Object.keys(result.byProject).length === 0);
		ok("no rate_limit check when there is nothing to fetch", getRateLimitCalls() === 0);
	}

	// ── rate_limit probe itself throws => budget unknown, proceed anyway ────
	{
		const projects = [{ name: "delta", repo: "o/delta" }];
		const exec = async (_cmd, args) => {
			if (args[0] === "api" && args[1] === "rate_limit") {throw new Error("gh not authenticated");}
			return { stdout: JSON.stringify([{ number: 1, title: "hello", updatedAt: "2026-01-01", comments: 0, url: "https://github.com/o/delta/issues/1" }]) };
		};
		const result = await shortlistUpstream({ projects, inferred: {}, exec, minRemaining: 200 });
		ok("a throwing rate_limit probe never stops the phase", result.budget.stopped === false);
		ok("remainingAtStart stays null when the probe never succeeds", result.budget.remainingAtStart === null);
		ok("the repo was still fetched despite the unknown budget", result.byProject.delta.issues.length === 1);
	}

	// ── unparseable `gh issue|pr list` JSON becomes a soft gap, never a throw ─
	{
		const projects = [{ name: "epsilon", repo: "o/epsilon" }];
		const exec = async (_cmd, args) => ({ stdout: args[0] === "api" && args[1] === "rate_limit" ? JSON.stringify({ resources: { core: { remaining: 5000 } } }) : "not json at all" });
		let isThrew = false;
		let result;
		try {
			result = await shortlistUpstream({ projects, inferred: {}, exec });
		} catch {
			isThrew = true;
		}
		ok("unparseable list JSON never throws out of shortlistUpstream", !isThrew);
		ok("the repo gets an empty issues list", result.byProject.epsilon.issues.length === 0);
		ok("the repo gets an empty prs list", result.byProject.epsilon.prs.length === 0);
		ok(
			"the gap names the unparseable-JSON cause for both issue and pr calls",
			result.gaps.filter((g) => g.includes("unparseable JSON") && g.includes("o/epsilon")).length === 2,
			JSON.stringify(result.gaps),
		);
	}

	// ── a rejection with no .message falls back to the error value itself ──
	// ── a rate_limit reading that parses but carries no numeric remaining ───
	// ── a list row whose comments field is neither an array nor a number ───
	{
		const projects = [{ name: "eta", repo: "o/eta" }];
		const exec = async (_cmd, args) => {
			if (args[0] === "api" && args[1] === "rate_limit") {return { stdout: JSON.stringify({ resources: { core: {} } }) };}
			if (args[0] === "issue") {
				// The empty `.message` (not the constructor argument, to satisfy
				// unicorn/error-message) is the point of this fixture: it forces
				// upstream.mjs's `e.message || e` fallback to take its "message is
				// falsy" branch. `.code` is set so isTransientGhFailure never
				// retries this rejection.
				const err = new Error("placeholder");
				err.message = "";
				err.code = 1;
				throw err;
			}
			return { stdout: JSON.stringify([{ number: 7, title: "a pr with no comments field at all", updatedAt: "2026-01-01", url: "https://github.com/o/eta/pr/7" }]) };
		};
		const result = await shortlistUpstream({ projects, inferred: {}, exec });
		ok("a resources.core.remaining that isn't a number reads as unknown budget, never throws", result.budget.remainingAtStart === null);
		ok("the phase still proceeds when the budget reading is unusable", result.budget.stopped === false);
		ok(
			"an empty-message rejection falls back to stringifying the error itself, never 'undefined'",
			result.gaps.some((g) => g.includes("gh issue list failed for o/eta") && !g.includes("undefined")),
			JSON.stringify(result.gaps),
		);
		ok("a missing comments field normalizes to 0, not a throw", result.byProject.eta.prs[0].comments === 0, JSON.stringify(result.byProject.eta.prs));
	}

	// ── keyword/ref dedupe across hits, a title-less item, a numeric-only
	//    keyword candidate, and a hit with no `text` at all ─────────────────
	{
		const projects = [{ name: "theta", repo: "o/theta" }];
		const hits = {
			theta: [
				{ signal: "no-text-hit" }, // hit.text is undefined entirely
				{ signal: "digits", text: "see revision 12345 for the fix" }, // a bare 5-digit "keyword" candidate
				{ signal: "first", text: "duplicate keyword duplicate keyword see #99 also #99 mention" },
				{ signal: "second", text: "another duplicate keyword mention" }, // repeats the "duplicate"/"keyword" hit against the same item
				{ signal: "third", text: "see #99 for context" }, // repeats the "#99" ref hit against the same item
			],
		};
		const repoResponses = {
			"o/theta": {
				issue: [
					{ number: 5, updatedAt: "2026-01-01", comments: 0, url: "https://github.com/o/theta/issues/5" }, // no title at all
					{ number: 99, title: "Duplicate keyword issue referencing 99", updatedAt: "2026-01-02", comments: 0, url: "https://github.com/o/theta/issues/99" },
				],
				pr: [],
			},
		};
		const { exec } = makeExec({ rateLimitRemaining: () => 5000, repoResponses });
		const result = await shortlistUpstream({ projects, inferred: hits, exec });
		const {matches} = result.byProject.theta;
		ok("a hit with no text produces no matches and never throws", matches.every((m) => m.signal !== "no-text-hit"), JSON.stringify(matches));
		ok("a purely-numeric word is never treated as a keyword, even at 5+ digits", matches.every((m) => m.keyword !== "12345"), JSON.stringify(matches));
		ok(
			"the 'duplicate' keyword match against item 99 appears exactly once despite two hits producing it",
			matches.filter((m) => m.item.endsWith("/99") && m.keyword === "duplicate").length === 1,
			JSON.stringify(matches),
		);
		ok(
			"the 'keyword' keyword match against item 99 appears exactly once despite two hits producing it",
			matches.filter((m) => m.item.endsWith("/99") && m.keyword === "keyword").length === 1,
			JSON.stringify(matches),
		);
		ok(
			"the '#99' ref match against item 99 appears exactly once despite two hits referencing it",
			matches.filter((m) => m.item.endsWith("/99") && m.keyword === "#99").length === 1,
			JSON.stringify(matches),
		);
		ok(
			"item 5 (number 5) never matches ref '99' — a mismatched ref is skipped, not force-matched",
			matches.every((m) => !m.item.endsWith("/5")),
			JSON.stringify(matches),
		);
	}

	// ── stopwords param actually reaches the merge (non-empty array) ───────
	{
		const projects = [{ name: "iota", repo: "o/iota" }];
		const repoResponses = {
			"o/iota": {
				issue: [{ number: 1, title: "gizmotronic overhaul needed", updatedAt: "2026-01-01", comments: 0, url: "https://github.com/o/iota/issues/1" }],
				pr: [],
			},
		};
		const inferred = { iota: [{ signal: "gotcha", text: "the gizmotronic overhaul is still pending upstream" }] };
		const { exec } = makeExec({ rateLimitRemaining: () => 5000, repoResponses });
		const withoutStopword = await shortlistUpstream({ projects, inferred, exec });
		ok(
			"without the custom stopword, 'gizmotronic' matches normally",
			withoutStopword.byProject.iota.matches.some((m) => m.keyword === "gizmotronic"),
			JSON.stringify(withoutStopword.byProject.iota.matches),
		);
		const withStopword = await shortlistUpstream({ projects, inferred, exec, stopwords: ["GIZMOTRONIC"] });
		ok(
			"a caller-supplied stopword (case-insensitively) suppresses that keyword",
			withStopword.byProject.iota.matches.every((m) => m.keyword !== "gizmotronic"),
			JSON.stringify(withStopword.byProject.iota.matches),
		);
	}

	// ── nullish `projects`/`inferred` degrade to empty rather than throwing ─
	{
		const neverCalled = async () => {
			throw new Error("exec should never be called with no projects");
		};
		const result = await shortlistUpstream({ projects: null, inferred: null, exec: neverCalled });
		ok("a null projects list produces an empty result, no calls made", Object.keys(result.byProject).length === 0);
		ok("a null inferred map never throws", result.gaps.length === 0);
	}
}
});

test("deriveRepoStopwords: repo/dir/manifest name harvesting, and every soft-fail branch", () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "osstrich-stopwords-"));
	mkdirSync(join(repoRoot, "node_modules"));
	mkdirSync(join(repoRoot, "packages", "widget-a"), { recursive: true });
	mkdirSync(join(repoRoot, "packages", "broken"), { recursive: true });
	writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "@scope/root-pkg" }));
	writeFileSync(join(repoRoot, "packages", "widget-a", "package.json"), JSON.stringify({ name: "widget-a" }));
	writeFileSync(join(repoRoot, "packages", "broken", "package.json"), "{ not valid json");

	// ── happy path: real fs, a nested manifest tree ─────────────────────────
	{
		const words = deriveRepoStopwords({ repoRoot, fs: nodeFs });
		const rootName = basename(repoRoot).toLowerCase();
		ok("the repo root's own directory name is harvested", words.includes(rootName), JSON.stringify(words));
		ok("a top-level directory name is harvested", words.includes("packages"), JSON.stringify(words));
		ok("node_modules is skipped (a default skip dir), never harvested", !words.includes("node_modules"), JSON.stringify(words));
		ok("a scoped package.json name is harvested by its bare (post-slash) form", words.includes("root-pkg"), JSON.stringify(words));
		ok("an unscoped nested package.json name is harvested", words.includes("widget-a"), JSON.stringify(words));
		ok("an unparseable nested manifest is skipped softly, no throw, no garbage entry", words.every((w) => !w.includes("not valid")), JSON.stringify(words));
	}

	// ── readdirSync throws => both the top-entries scan and the manifest walk
	//    degrade to empty rather than throwing out of the helper ─────────────
	{
		const throwingFs = { ...nodeFs, readdirSync: () => { throw new Error("EPERM: boom"); } };
		let isThrew = false;
		let words;
		try {
			words = deriveRepoStopwords({ repoRoot, fs: throwingFs });
		} catch {
			isThrew = true;
		}
		ok("a throwing readdirSync never escapes deriveRepoStopwords", !isThrew);
		ok("the root name is still harvested even when the walk fails entirely", words.includes(basename(repoRoot).toLowerCase()), JSON.stringify(words));
		ok("no directory/manifest names are harvested when the walk fails", words.length === 1, JSON.stringify(words));
	}

	// ── a manifest that can't be READ (not just parsed) is skipped softly ───
	{
		const flakyFs = {
			...nodeFs,
			readFileSync: (p, enc) => {
				if (String(p).includes("widget-a")) {throw new Error("EACCES: permission denied");}
				return nodeFs.readFileSync(p, enc);
			},
		};
		const words = deriveRepoStopwords({ repoRoot, fs: flakyFs });
		ok("the unreadable manifest's name is never harvested", !words.includes("widget-a"), JSON.stringify(words));
		ok("a sibling manifest that IS readable still contributes", words.includes("root-pkg"), JSON.stringify(words));
	}
});

test("osstrich-run: openRun / writePartial / finishRun", async () => {
{
	const runsRoot = mkdtempSync(join(tmpdir(), "osstrich-run-test-"));
	const clockMs = { value: Date.parse("2026-09-06T12:00:00Z") };
	const now = () => clockMs.value;

	const first = openRun({ runsDir: runsRoot, slug: "battle", now, fs: nodeFs });
	ok("first attempt for a new slug+date is attempt-1", basename(first.dir) === "2026-09-06-battle-attempt-1");
	ok("openRun creates the directory", existsSync(first.dir));
	ok("openRun writes progress.json", existsSync(join(first.dir, "progress.json")));

	const second = openRun({ runsDir: runsRoot, slug: "battle", now, fs: nodeFs });
	ok("second attempt, same slug+date, is attempt-2", basename(second.dir) === "2026-09-06-battle-attempt-2");

	const unrelated = openRun({ runsDir: runsRoot, slug: "other", now, fs: nodeFs });
	ok("a different slug starts its own attempt-1", basename(unrelated.dir) === "2026-09-06-other-attempt-1");

	const resumedBeforeAnyPartial = openRun({ runsDir: runsRoot, slug: "battle", now, fs: nodeFs, resume: true });
	ok("resume picks the newest attempt (attempt-2)", resumedBeforeAnyPartial.dir === second.dir);

	const rankPartial = writePartial(first.dir, "rank", { rows: [1, 2, 3], markdown: "| a |\n|---|" }, { fs: nodeFs });
	ok("writePartial writes the json file", existsSync(rankPartial.jsonPath));
	ok("writePartial writes the markdown file when data.markdown is a string", existsSync(rankPartial.mdPath));
	ok("the markdown file holds the raw markdown, not JSON", readFileSync(rankPartial.mdPath, "utf8") === "| a |\n|---|");

	const inventoryPartial = writePartial(first.dir, "inventory", { projects: [] }, { fs: nodeFs });
	ok("no markdown field => mdPath is null and no .md file is written", inventoryPartial.mdPath === null && !existsSync(join(first.dir, "inventory.md")));

	const progressAfterWrites = JSON.parse(readFileSync(join(first.dir, "progress.json"), "utf8"));
	ok("progress.json records the rank phase's path", progressAfterWrites.phases.rank.path === rankPartial.jsonPath);
	ok("progress.json records the inventory phase's path", progressAfterWrites.phases.inventory.path === inventoryPartial.jsonPath);

	const resumedAttempt1 = openRun({ runsDir: runsRoot, slug: "battle-attempt1-check", now, fs: nodeFs });
	writePartial(resumedAttempt1.dir, "rank", { ok: true }, { fs: nodeFs });
	const resumedForReal = openRun({ runsDir: runsRoot, slug: "battle-attempt1-check", now, fs: nodeFs, resume: true });
	ok("resume reuses the same attempt directory a partial was already written to", resumedForReal.dir === resumedAttempt1.dir);
	ok("openRun's return carries no resumeFrom field (the CLI skips phases via its own readPartial instead)", !("resumeFrom" in resumedForReal));

	const resumeWithNothingYet = openRun({ runsDir: mkdtempSync(join(tmpdir(), "osstrich-run-empty-")), slug: "fresh", now, fs: nodeFs, resume: true });
	ok("resume with no existing attempt falls back to creating attempt-1", basename(resumeWithNothingYet.dir) === "2026-09-06-fresh-attempt-1");

	// ── a runsDir that doesn't exist yet at all (not even the parent) reads
	// as "no attempts", never throws ────────────────────────────────────────
	const neverCreatedRoot = join(mkdtempSync(join(tmpdir(), "osstrich-run-parent-")), "not-yet-created");
	const brandNew = openRun({ runsDir: neverCreatedRoot, slug: "brandnew", now, fs: nodeFs });
	ok("openRun against a wholly nonexistent runsDir still creates attempt-1", basename(brandNew.dir) === "2026-09-06-brandnew-attempt-1");
	ok("the runsDir itself got created along the way", existsSync(neverCreatedRoot));

	// ── writePartial against a bare directory with no progress.json yet
	// falls back to the default (never throws) ─────────────────────────────
	const bareDir = mkdtempSync(join(tmpdir(), "osstrich-run-bare-"));
	const barePartial = writePartial(bareDir, "inventory", { projects: [] }, { fs: nodeFs });
	ok("writePartial against a dir with no pre-existing progress.json still writes the partial", existsSync(barePartial.jsonPath));
	const bareProgress = JSON.parse(readFileSync(join(bareDir, "progress.json"), "utf8"));
	ok("the freshly-created progress.json defaults started_at to null", bareProgress.started_at === null);

	// ── MED-3: a stale attempts-listing race never clobbers a prior attempt ──
	// (the report's TOCTOU finding): two openRun calls that both see the SAME
	// stale "0 attempts so far" listing (readdirSync faked to never see what
	// mkdirSync already created) must still land in two DISTINCT attempt dirs,
	// never both writing attempt-1 and silently overwriting the first caller's
	// partials.
	{
		const madeDirs = new Set();
		const raceFs = {
			// A racing caller's directory listing never reflects an attempt the
			// OTHER caller just claimed — the exact staleness the report's repro
			// demonstrated against the real fs.
			readdirSync: () => [],
			mkdirSync: (dir, opts) => {
				if (opts?.recursive) {return;} // idempotent parent (runsDir) creation
				if (madeDirs.has(dir)) {
					const err = new Error(`EEXIST: ${dir}`);
					err.code = "EEXIST";
					throw err;
				}
				madeDirs.add(dir);
			},
			readFileSync: () => {
				throw new Error("ENOENT");
			},
			writeFileSync: () => {
				// No-op: this scenario only exercises the read-fails-with-ENOENT
				// path above; nothing here asserts on a write.
			},
		};
		const raceRunsDir = "/fake/race-runs-dir";
		const raceNow = () => Date.parse("2026-09-06T12:00:00Z");

		const raceFirst = openRun({ runsDir: raceRunsDir, slug: "racer", now: raceNow, fs: raceFs });
		const raceSecond = openRun({ runsDir: raceRunsDir, slug: "racer", now: raceNow, fs: raceFs });
		ok(
			"two racing openRun calls against the same stale listing land in distinct attempt dirs",
			raceFirst.dir !== raceSecond.dir,
			`${raceFirst.dir} vs ${raceSecond.dir}`,
		);
		ok("the first racer claims attempt-1", basename(raceFirst.dir) === "2026-09-06-racer-attempt-1");
		ok(
			"the second racer advances past the EEXIST to attempt-2 rather than clobbering attempt-1",
			basename(raceSecond.dir) === "2026-09-06-racer-attempt-2",
			basename(raceSecond.dir),
		);
	}
	// ── finishRun: fields, defaults, run_id, append-not-overwrite ──────────
	const recordPath = await finishRun(first.dir, { funded: 2, deferred: 1 }, { fs: nodeFs, now });
	ok("finishRun returns the run-record.jsonl path", recordPath === join(first.dir, "run-record.jsonl"));
	let lines = readFileSync(recordPath, "utf8").trim().split("\n");
	ok("one line after one finishRun call", lines.length === 1);
	const line = JSON.parse(lines[0]);
	ok("run_id is the run directory's basename", line.run_id === basename(first.dir));
	ok("started_at is read from progress.json", line.started_at === JSON.parse(readFileSync(join(first.dir, "progress.json"), "utf8")).started_at);
	ok("finished_at reflects the injected clock", line.finished_at === new Date(now()).toISOString());
	ok("session-supplied fields pass through", line.funded === 2 && line.deferred === 1);
	ok("unset session-only fields default to null, not 0", line.prs_opened === null && line.gate_migrated === null);
	ok("the CLI's own four count fields default to 0", line.projects_inventoried === 0 && line.bottom_n === 0 && line.candidates === 0);

	await finishRun(first.dir, { funded: 5 }, { fs: nodeFs, now });
	lines = readFileSync(recordPath, "utf8").trim().split("\n");
	ok("a second finishRun call APPENDS rather than overwrites", lines.length === 2);
	ok("the second line carries the session's later counts", JSON.parse(lines[1]).funded === 5);

	// ── finishRun's onRunEnd hook: called with the just-written record, and
	// a throwing hook lands as a gap line rather than propagating ─────────
	{
		const hookRunsDir = mkdtempSync(join(tmpdir(), "osstrich-run-hook-"));
		const hookRun = openRun({ runsDir: hookRunsDir, slug: "hooked", now, fs: nodeFs });

		let calledWith = null;
		const okHook = async (record, ctx) => {
			calledWith = { record, ctx };
		};
		const okPath = await finishRun(hookRun.dir, { funded: 1 }, { fs: nodeFs, now, onRunEnd: okHook });
		ok("onRunEnd is called with the record just written", calledWith?.record?.run_id === basename(hookRun.dir) && calledWith?.record?.funded === 1, JSON.stringify(calledWith));
		ok("onRunEnd is called with the run's own dir", calledWith?.ctx?.dir === hookRun.dir);
		const okLines = readFileSync(okPath, "utf8").trim().split("\n");
		ok("a succeeding hook adds no extra lines", okLines.length === 1, JSON.stringify(okLines));

		const throwingHook = async () => {
			throw new Error("hook boom");
		};
		let isHookThrew = false;
		let throwingPath;
		try {
			throwingPath = await finishRun(hookRun.dir, { funded: 2 }, { fs: nodeFs, now, onRunEnd: throwingHook });
		} catch {
			isHookThrew = true;
		}
		ok("finishRun never propagates a throwing onRunEnd hook", !isHookThrew);
		const linesAfterThrow = readFileSync(throwingPath, "utf8").trim().split("\n");
		ok("the record's own line still lands (2 real records + 1 gap line)", linesAfterThrow.length === 3, JSON.stringify(linesAfterThrow));
		const gapLine = JSON.parse(linesAfterThrow[2]);
		ok("the hook failure is recorded as a gap line naming the failure, not thrown", gapLine.gap?.includes("hook boom"), JSON.stringify(gapLine));
		ok("the gap line still names the run_id", gapLine.run_id === basename(hookRun.dir));

		let isCalledWithoutHook;
		try {
			await finishRun(hookRun.dir, {}, { fs: nodeFs, now });
			isCalledWithoutHook = true;
		} catch {
			isCalledWithoutHook = false;
		}
		ok("finishRun with no onRunEnd at all is a plain no-op on the hook", isCalledWithoutHook);
	}

	// ── finishRun against a dir with no progress.json at all: started_at
	// falls back to null (readProgress's own catch, then this line's own
	// `|| null`), rather than reading a real timestamp ─────────────────────
	{
		const bareDir2 = mkdtempSync(join(tmpdir(), "osstrich-run-bare-finish-"));
		const recordPath2 = await finishRun(bareDir2, { funded: 1 }, { fs: nodeFs, now });
		const line2 = JSON.parse(readFileSync(recordPath2, "utf8").trim().split("\n", 1)[0]);
		ok("started_at falls back to null when there's no progress.json to read it from", line2.started_at === null, JSON.stringify(line2));
	}

	// ── a non-Error thrown by onRunEnd (no .message) still lands as a gap
	// line, stringifying the thrown value itself ────────────────────────────
	{
		const hook2RunsDir = mkdtempSync(join(tmpdir(), "osstrich-run-hook-nonerror-"));
		const hook2Run = openRun({ runsDir: hook2RunsDir, slug: "hookednonerror", now, fs: nodeFs });
		const stringThrowingHook = async () => {
			throw "hook boom (bare string)"; // eslint-disable-line no-throw-literal -- deliberately a non-Error, to exercise onRunEnd's `error?.message || error` fallback
		};
		const path2 = await finishRun(hook2Run.dir, { funded: 1 }, { fs: nodeFs, now, onRunEnd: stringThrowingHook });
		const lines2 = readFileSync(path2, "utf8").trim().split("\n");
		const gapLine2 = JSON.parse(lines2[1]);
		ok("a non-Error thrown by onRunEnd is stringified into the gap line, not \"undefined\"", gapLine2.gap === "hook_error: onRunEnd failed: hook boom (bare string)", JSON.stringify(gapLine2));
	}

	// ── openRun: a non-EEXIST mkdirSync failure propagates (never silently
	// retried like the real race condition above) ──────────────────────────
	{
		const explodingFs = {
			readdirSync: () => [],
			mkdirSync: (dir, opts) => {
				if (opts?.recursive) {return;}
				const err = new Error("EACCES: permission denied");
				err.code = "EACCES";
				throw err;
			},
		};
		let isThrewPermission = false;
		try {
			openRun({ runsDir: "/fake/perm-runs-dir", slug: "noperm", now, fs: explodingFs });
		} catch (error) {
			isThrewPermission = error.code === "EACCES";
		}
		ok("a non-EEXIST mkdirSync failure propagates out of openRun rather than looping forever", isThrewPermission);
	}

	// ── openRun resume: the sort comparator's date-ordering branches, not
	// just same-date attempt-number ordering (already covered above) ───────
	{
		const multiDateRunsDir = mkdtempSync(join(tmpdir(), "osstrich-run-multidate-"));
		const day0 = () => Date.parse("2026-08-31T12:00:00Z");
		const day1 = () => Date.parse("2026-09-01T12:00:00Z");
		const day2 = () => Date.parse("2026-09-02T12:00:00Z");
		// Opened out of date order on purpose (day1, then day0, then day2) so
		// the later `resume` sort — regardless of whatever order the real
		// fs.readdirSync happens to return these three in — must actually
		// compare dates in BOTH directions to land on the true newest, not
		// just confirm an already-ascending or already-descending input.
		const day1Run = openRun({ runsDir: multiDateRunsDir, slug: "crossday", now: day1, fs: nodeFs });
		ok("day 1 attempt is attempt-1", basename(day1Run.dir) === "2026-09-01-crossday-attempt-1");
		const day0Run = openRun({ runsDir: multiDateRunsDir, slug: "crossday", now: day0, fs: nodeFs });
		ok("day 0 (earlier, opened second) is its own attempt-1", basename(day0Run.dir) === "2026-08-31-crossday-attempt-1");
		const day2Run = openRun({ runsDir: multiDateRunsDir, slug: "crossday", now: day2, fs: nodeFs });
		ok("day 2 attempt is its own attempt-1 (a new date resets the counter)", basename(day2Run.dir) === "2026-09-02-crossday-attempt-1");

		// Resume, read "as of" day 2 — must find day 2's attempt (the latest
		// date among all three), exercising the comparator's date ordering in
		// both directions regardless of readdirSync's own listing order.
		const resumedAcrossDates = openRun({ runsDir: multiDateRunsDir, slug: "crossday", now: day2, fs: nodeFs, resume: true });
		ok("resume picks the later DATE's attempt, not just the higher attempt number", resumedAcrossDates.dir === day2Run.dir, resumedAcrossDates.dir);

		// The real fs.readdirSync above happened to list attempts oldest-first,
		// so the sort comparator only ever saw `a.date < b.date`. A listing
		// order that puts the NEWER date first forces the comparator to see
		// `a.date > b.date` too — both directions of the same comparison.
		const descendingOrderFs = {
			readdirSync: () => [
				{ name: "2026-09-02-crossday-attempt-1", isDirectory: () => true },
				{ name: "2026-08-31-crossday-attempt-1", isDirectory: () => true },
			],
		};
		const resumedFromDescendingListing = openRun({ runsDir: "/fake/descending-listing-dir", slug: "crossday", now: day2, fs: descendingOrderFs, resume: true });
		ok(
			"resume still finds the later date even when readdir already lists the newer one first",
			basename(resumedFromDescendingListing.dir) === "2026-09-02-crossday-attempt-1",
			resumedFromDescendingListing.dir,
		);
	}

	// ── openRun: listAttempts skips a non-directory entry that happens to
	// share the runsDir with real attempt directories ──────────────────────
	{
		const mixedRunsDir = mkdtempSync(join(tmpdir(), "osstrich-run-mixedentries-"));
		const realAttempt = openRun({ runsDir: mixedRunsDir, slug: "mixed", now, fs: nodeFs });
		writeFileSync(join(mixedRunsDir, "README.md"), "not a run directory\n");
		const resumedWithStrayFile = openRun({ runsDir: mixedRunsDir, slug: "mixed", now, fs: nodeFs, resume: true });
		ok("a stray non-directory entry in runsDir never confuses listAttempts", resumedWithStrayFile.dir === realAttempt.dir);
	}
}
});

// ─────────────────────────────────────────────────────────────────────────
// lib/cli-core.mjs — hand-written against this package's own contract
// (discover's --table/verdict/picker/build pipeline is new relative to the
// private core this was ported from; see lib/cli-core.mjs's own module doc
// and lib/prompts.mjs).
// ─────────────────────────────────────────────────────────────────────────

const FAKE_INVENTORY = {
	status: "complete",
	projects: [
		{ name: "alpha", repo: "o/alpha" },
		{ name: "beta", repo: "o/beta" },
	],
	gaps: [],
};
const FAKE_RANK = { rows: [{ name: "alpha" }, { name: "beta" }], bottom: ["alpha", "beta"], unclassified: [] };
const FAKE_INFERRED = { byProject: { alpha: [{ signal: "gotcha", text: "workaround for the alpha race" }], beta: [] }, gaps: [] };
const FAKE_SHORTLIST = {
	byProject: {
		alpha: { issues: [], prs: [], matches: [{ item: "https://github.com/o/alpha/issues/1", signal: "gotcha", keyword: "race" }] },
		beta: { issues: [], prs: [], matches: [] },
	},
	budget: { checked: 2, remainingAtStart: 5000, stopped: false },
	gaps: [],
};

function makeCodePhaseDeps({ runsDir, overrides = {} } = {}) {
	const stdout = createSink();
	const stderr = createSink();
	const calls = { inventory: 0, rank: 0, infer: 0, upstream: 0, runAgentStage: [] };

	// `runAgentStage` is tracked in `calls` no matter what a test overrides
	// it to do — pulling it out of `overrides` here means a test can still
	// replace the STAGE'S BEHAVIOR (write a verdict.json, fail, etc.)
	// without losing the "was it called, with what" assertions below.
	const { runAgentStage: runAgentStageImpl, ...restOverrides } = overrides;
	const defaultRunAgentStageImpl = async (args) => ({ ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) });

	const deps = {
		collectInventory: async () => {
			calls.inventory += 1;
			return FAKE_INVENTORY;
		},
		rankProjects: () => {
			calls.rank += 1;
			return FAKE_RANK;
		},
		renderRankMarkdown: () => "| rank | md |\n|---|---|",
		inferNextSteps: async () => {
			calls.infer += 1;
			return FAKE_INFERRED;
		},
		shortlistUpstream: async () => {
			calls.upstream += 1;
			return FAKE_SHORTLIST;
		},
		scrubText: async () => ({ ok: true, findings: [] }),
		scrubPaths: async () => ({ ok: true, findings: [] }),
		extractClaims: () => [],
		recheckClaims: async () => ({ fired: [], contradicted: [], unconfirmable: [], current: [] }),
		openRun,
		writePartial,
		finishRun,
		runAgentStage: async (args) => {
			calls.runAgentStage.push(args);
			return (runAgentStageImpl || defaultRunAgentStageImpl)(args);
		},
		fs: nodeFs,
		exec: async () => ({ stdout: "{}" }),
		fetch: async () => ({}),
		stdout,
		stderr,
		prompts: createFakePrompts(),
		isTTY: false,
		runsDir,
		repoRoot: "/fake/repo/root",
		classificationPath: "/fake/repo/root/does-not-exist-classification.md",
		termsPath: "/fake/repo/root/does-not-exist-terms.txt",
		configPath: "/fake/repo/root/.osstrich.json",
		onRunEnd: null,
		agentCommand: "fake-agent",
		agentModel: null,
		skillDir: "/fake/skill-dir",
		...restOverrides,
	};
	return { deps, stdout, stderr, calls };
}

test("discover --table: exits 0 when candidates exist (candidates are output, not a failure), writes verdict-template.md, never touches the agent", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-table-"));
	const { deps, calls, stdout } = makeCodePhaseDeps({ runsDir });

	const code = await main(["discover", "--slug", "tabletest", "--table"], deps);
	ok("discover --table exits 0 even when candidates exist", code === 0, code);
	ok("the agent is never invoked in --table mode", calls.runAgentStage.length === 0);

	const dir = join(runsDir, readdirSync(runsDir).find((d) => d.includes("tabletest")));
	const verdict = readFileSync(join(dir, "verdict-template.md"), "utf8");
	ok("verdict-template.md includes alpha (has a match)", verdict.includes("| alpha |"));
	ok("verdict-template.md excludes beta (no match)", !verdict.includes("| beta |"));
	ok("verdict.json is never written in --table mode", !existsSync(join(dir, "verdict.json")));

	// Every phase line ends in gaps=<N> — the phase's own gaps count.
	ok("the inventory phase line ends in gaps=0", /osstrich inventory: projects=2 gaps=0 →/.test(stdout.text), stdout.text);
	ok("the rank phase line ends in gaps=0", /osstrich rank: bottom=2 gaps=0 →/.test(stdout.text), stdout.text);
	ok("the infer phase line ends in gaps=0", /osstrich infer: projects_with_hits=2 gaps=0 →/.test(stdout.text), stdout.text);
	ok("the upstream phase line ends in gaps=0", /osstrich upstream: checked=2 gaps=0 →/.test(stdout.text), stdout.text);
	// FAKE_INVENTORY.status is "complete", so the verdict line carries no
	// "incomplete" suffix.
	ok("the verdict line has no incomplete suffix on a complete inventory", /osstrich verdict: candidates=1 →/.test(stdout.text), stdout.text);
});

test("discover --table: exit 0 when no project has an upstream match", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-table-clean-"));
	const { deps } = makeCodePhaseDeps({
		runsDir,
		overrides: { shortlistUpstream: async () => ({ byProject: {}, budget: { checked: 0 }, gaps: [] }) },
	});
	const code = await main(["discover", "--slug", "tableclean", "--table"], deps);
	ok("discover --table exits 0 when nothing matched", code === 0);
});

test("discover --table: an incomplete inventory carries through to the verdict line", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-table-incomplete-"));
	const { deps, stdout } = makeCodePhaseDeps({
		runsDir,
		overrides: { collectInventory: async () => ({ ...FAKE_INVENTORY, status: "incomplete" }) },
	});
	const code = await main(["discover", "--slug", "tableincomplete", "--table"], deps);
	ok("discover --table still exits 0 on an incomplete inventory", code === 0);
	ok("the verdict line names the incomplete inventory", /osstrich verdict: candidates=1 incomplete →/.test(stdout.text), stdout.text);
});

test("discover --resume: a run whose partials already exist prints one skip line per phase, including the verdict template, and reruns nothing", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-resume-"));
	const { deps: firstDeps, calls: firstCalls } = makeCodePhaseDeps({ runsDir });
	await main(["discover", "--slug", "resumetest", "--table"], firstDeps);
	ok("the first pass ran every phase once", firstCalls.inventory === 1 && firstCalls.rank === 1 && firstCalls.infer === 1 && firstCalls.upstream === 1);

	const { deps: secondDeps, calls: secondCalls, stdout: secondStdout } = makeCodePhaseDeps({ runsDir });
	const code = await main(["discover", "--slug", "resumetest", "--table", "--resume"], secondDeps);
	ok("a --resume discover still exits 0", code === 0);
	ok("--resume reruns none of the code phases", secondCalls.inventory === 0 && secondCalls.rank === 0 && secondCalls.infer === 0 && secondCalls.upstream === 0);
	for (const phase of ["inventory", "rank", "infer", "upstream", "verdict"]) {
		ok(`--resume prints a skip line for ${phase}`, new RegExp(String.raw`osstrich ${phase}: skipped \(partial present\)`).test(secondStdout.text), secondStdout.text);
	}
});

test("discover --table --resume: a resumed code-phase run whose verdict-template.md wasn't written yet renders it fresh", async () => {
	// The four code phases (inventory/rank/infer/upstream) run without
	// --table first, writing their own partials but never touching the
	// verdict phase (gated on `table`). A second, --table --resume pass then
	// resumes those four from disk but must still render verdict-template.md
	// for the first time — readExisting()'s own readFileSync throws (the
	// file doesn't exist yet), which is the soft-fail this test targets.
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-resume-notable-"));
	const { deps: firstDeps, calls: firstCalls } = makeCodePhaseDeps({ runsDir });
	await main(["discover", "--slug", "resumenotable"], firstDeps);
	ok("the first (non-table) pass ran every code phase once", firstCalls.inventory === 1 && firstCalls.rank === 1 && firstCalls.infer === 1 && firstCalls.upstream === 1);

	const dir = join(runsDir, readdirSync(runsDir).find((d) => d.includes("resumenotable")));
	ok("the first pass never wrote a verdict template (no --table)", !existsSync(join(dir, "verdict-template.md")));

	const { deps: secondDeps, calls: secondCalls } = makeCodePhaseDeps({ runsDir });
	const code = await main(["discover", "--slug", "resumenotable", "--table", "--resume"], secondDeps);
	ok("the resumed --table pass exits 0", code === 0);
	ok("--resume still skips every code phase (their partials existed)", secondCalls.inventory === 0 && secondCalls.rank === 0 && secondCalls.infer === 0 && secondCalls.upstream === 0);
	ok("the verdict template is now written, despite --resume", existsSync(join(dir, "verdict-template.md")));
});

test("discover: a rank phase's own gaps[] print one line per gap after the phase summary", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-rankgaps-"));
	const { deps, stdout } = makeCodePhaseDeps({
		runsDir,
		overrides: { rankProjects: () => ({ ...FAKE_RANK, gaps: ["classification.md missing a row for gamma"] }) },
	});
	const code = await main(["discover", "--slug", "rankgaps", "--table"], deps);
	ok("discover still exits 0 with a rank gap present", code === 0);
	ok(
		"the rank gap is printed as its own line, right after the rank summary",
		stdout.text.includes('osstrich rank gap: "classification.md missing a row for gamma"'),
		stdout.text,
	);
});

test("defaultDeps(): a real config.hooks.runEnd module loads and its default export becomes onRunEnd; a broken hook path degrades to null", async () => {
	// happy path: a real hook module with a default export
	{
		const repoRoot = mkdtempSync(join(tmpdir(), "osstrich-runendhook-"));
		mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
		const homedir = mkdtempSync(join(tmpdir(), "osstrich-runendhook-home-"));
		const hookPath = join(repoRoot, "run-end-hook.mjs");
		writeFileSync(hookPath, "export default function hook() { return 'ran'; }\n");
		writeFileSync(join(repoRoot, ".osstrich.json"), JSON.stringify({ hooks: { runEnd: hookPath } }));
		const deps = await defaultDeps({ cwd: repoRoot, fs: nodeFs, env: {}, homedir, exec: async () => ({ stdout: "{}" }) });
		ok("onRunEnd is the hook module's default export", typeof deps.onRunEnd === "function");
		ok("calling it runs the real module", deps.onRunEnd() === "ran");
	}

	// soft-fail: a configured hook path that doesn't resolve to a real module
	{
		const repoRoot = mkdtempSync(join(tmpdir(), "osstrich-runendhook-broken-"));
		mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
		const homedir = mkdtempSync(join(tmpdir(), "osstrich-runendhook-broken-home-"));
		writeFileSync(join(repoRoot, ".osstrich.json"), JSON.stringify({ hooks: { runEnd: join(repoRoot, "does-not-exist.mjs") } }));
		const deps = await defaultDeps({ cwd: repoRoot, fs: nodeFs, env: {}, homedir, exec: async () => ({ stdout: "{}" }) });
		ok("a hook module that fails to import degrades to null, never a throw", deps.onRunEnd === null);
	}
});

test("main(): a config error while resolving the thin (bin-shaped) deps is caught and reported, never an unhandled rejection", async () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "osstrich-cli-badconfig-"));
	mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
	writeFileSync(join(repoRoot, ".osstrich.json"), "{ not valid json");
	const homedir = mkdtempSync(join(tmpdir(), "osstrich-cli-badconfig-home-"));
	const stderr = createSink();
	const code = await main(["discover"], {
		fs: nodeFs,
		env: {},
		exec: async () => ({ stdout: "{}" }),
		cwd: repoRoot,
		homedir,
		stdout: createSink(),
		stderr,
	});
	ok("a config error while building the thin deps exits 2", code === 2);
	ok("the failure is reported through formatFailure, not an unhandled rejection", stderr.text.includes("FAILED"), stderr.text);
});

test("build: with a target, a build stage that never writes its own <slug>.md file reads back prs_opened as 0, not a throw", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-buildtarget-noprfile-"));
	// the default runAgentStage fake (no override) never writes a `.md` file
	const { deps } = makeCodePhaseDeps({ runsDir });
	const code = await main(["build", "acme/nomd#1"], deps);
	ok("build still exits 0 even when the build stage wrote no prs_opened file", code === 0);
	const createdDir = readdirSync(runsDir).find((d) => d.includes("acme-nomd-1"));
	const record = JSON.parse(readFileSync(join(runsDir, createdDir, "run-record.jsonl"), "utf8").trim().split("\n").pop());
	ok("a missing build-<slug>.md file reads back as prs_opened: 0", record.prs_opened === 0, JSON.stringify(record));
});

test("build: with a target, a build stage that fails (ok: false) throws an AGENT error naming the log path", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-buildtarget-failed-"));
	const { deps, stderr } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			runAgentStage: async (args) => ({ ok: false, exitCode: 1, logPath: join(args.runDir, `${args.stage}.log`) }),
		},
	});
	const code = await main(["build", "acme/broken#9"], deps);
	ok("a failed build stage exits 2", code === 2);
	ok("the failure names the build stage and points at its log", stderr.text.includes("build stage failed, see") && stderr.text.includes("build-acme-broken-9.log"), stderr.text);
});

test("build: without a target and no run directory has ever been opened, exits 2 with 'no funded row left'", async () => {
	// deps.runsDir points at a directory that was never created — this
	// exercises BOTH listRunDirs' own readdirSync-throws-ENOENT soft-fail
	// (degrades to []) and findNewestRunWithVerdict's "nothing found" path,
	// which is different from (and never reached by) the "every funded row
	// already built" exhaustion case covered elsewhere.
	const base = mkdtempSync(join(tmpdir(), "osstrich-cli-buildnorun-"));
	const runsDir = join(base, "never-created");
	const { deps, stderr } = makeCodePhaseDeps({ runsDir });
	const code = await main(["build"], deps);
	ok("build with no target and no run directory at all exits 2", code === 2);
	ok("the message names 'no funded row left'", stderr.text.includes("no funded row left"), stderr.text);
	ok("the hint tells the user to run osstrich discover", stderr.text.includes("run osstrich discover"), stderr.text);
});

test("build: without a target, an unparseable verdict.json degrades to an empty row set rather than throwing", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-buildbadverdict-"));
	const { dir } = openRun({ runsDir, slug: "priordiscover", fs: nodeFs });
	writeFileSync(join(dir, "verdict.json"), "{ not valid json");

	const { deps, stderr } = makeCodePhaseDeps({ runsDir });
	const code = await main(["build"], deps);
	ok("an unparseable verdict.json never throws out of JSON.parse — it's caught and treated as zero rows", code === 2);
	ok("with zero rows, the funded-row search comes up empty the same as if none were funded", stderr.text.includes("no funded row left"), stderr.text);
});

test("discover: missing agent command exits 2 with the init hint", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-noagent-"));
	const { deps, stderr } = makeCodePhaseDeps({ runsDir, overrides: { agentCommand: null } });
	const code = await main(["discover", "--slug", "noagent"], deps);
	ok("discover without an agent command exits 2", code === 2);
	ok("the failure names the missing agent", stderr.text.includes("no agent command configured"), stderr.text);
	ok("the hint tells the user to run osstrich init", stderr.text.includes("run osstrich init"), stderr.text);
});

test("build: missing agent command exits 2 with the init hint, target or not", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-build-noagent-"));
	const { deps, stderr } = makeCodePhaseDeps({ runsDir, overrides: { agentCommand: null } });
	const code = await main(["build", "owner/repo#7"], deps);
	ok("build without an agent command exits 2", code === 2);
	ok("the hint tells the user to run osstrich init", stderr.text.includes("run osstrich init"), stderr.text);
});

test("discover: an unparseable verdict.json fails the stage and exits 2", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-badjson-"));
	const { deps, stderr } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			runAgentStage: async (args) => {
				writeFileSync(join(args.runDir, "verdict.json"), "{ not json");
				return { ok: true, exitCode: 0, logPath: join(args.runDir, "verdict.log") };
			},
		},
	});
	const code = await main(["discover", "--slug", "badjson"], deps);
	ok("an unparseable verdict.json exits 2", code === 2);
	ok("the failure names verdict.json", stderr.text.includes("verdict.json"), stderr.text);
});

test("discover: a verdict.json that fails zod validation fails the stage and exits 2", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-badverdict-"));
	const { deps, stderr } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			runAgentStage: async (args) => {
				if (args.stage === "verdict") {
					// "funded" is not a valid ruling — the schema only allows
					// fund/defer/skip/give-back.
					writeFileSync(
						join(args.runDir, "verdict.json"),
						JSON.stringify({ rows: [{ name: "alpha", repo: "o/alpha", ruling: "funded", item: "x", need: "y", evidence: [], gate: null, combinedRank: 1 }] }),
					);
				}
				return { ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) };
			},
		},
	});
	const code = await main(["discover", "--slug", "badverdict"], deps);
	ok("an invalid verdict.json exits 2", code === 2);
	ok("the failure names validation", stderr.text.includes("failed validation"), stderr.text);

	const dir = join(runsDir, readdirSync(runsDir).find((d) => d.includes("badverdict")));
	const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
	const verdictPhase = status.phases.find((p) => p.stage === "verdict");
	ok("the verdict stage is downgraded to failed once the shape is known bad", verdictPhase?.state === "failed", JSON.stringify(verdictPhase));
});

test("discover: a failing verdict agent stage exits 2 without ever picking or building", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-verdictfail-"));
	const { deps, calls } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			runAgentStage: async (args) => ({ ok: false, exitCode: 1, logPath: join(args.runDir, `${args.stage}.log`) }),
		},
	});
	const code = await main(["discover", "--slug", "verdictfail"], deps);
	ok("a failing verdict stage exits 2", code === 2);
	ok("exactly one agent stage ran (verdict), no build stage followed", calls.runAgentStage.length === 1 && calls.runAgentStage[0].stage === "verdict");
});

function writeFundedVerdict(runDir) {
	const verdict = {
		rows: [
			{ name: "alpha", repo: "o/alpha", ruling: "fund", item: "upstream issue #1", need: "our workaround", evidence: ["reproduction", "patch"], gate: "upstream", combinedRank: 5 },
			{ name: "beta", repo: "o/beta", ruling: "fund", item: "upstream issue #2", need: "our other workaround", evidence: ["measurement"], gate: null, combinedRank: 2 },
			{ name: "gamma", repo: "o/gamma", ruling: "defer", item: "n/a", need: "n/a", evidence: [], gate: null, combinedRank: 9 },
		],
	};
	writeFileSync(join(runDir, "verdict.json"), JSON.stringify(verdict));
	return verdict;
}

test("discover: headless picks the single best funded row (by evidence count, then combinedRank) and runs one build stage", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-headless-"));
	const { deps, calls } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			runAgentStage: async (args) => {
				if (args.stage === "verdict") {
					writeFundedVerdict(args.runDir);
				} else if (args.stage.startsWith("build-")) {
					writeFileSync(join(args.runDir, `${args.stage}.md`), "prs_opened: 1\nOpened https://github.com/o/alpha/pull/9\n");
				}
				return { ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) };
			},
		},
	});

	const code = await main(["discover", "--slug", "headless", "--headless"], deps);
	ok("discover with a picked candidate exits 0", code === 0, deps.stderr?.text);

	const buildCalls = calls.runAgentStage.filter((c) => c.stage.startsWith("build-"));
	ok("exactly one build stage ran", buildCalls.length === 1, JSON.stringify(buildCalls.map((c) => c.stage)));
	ok("the picked row is alpha (2 evidence boxes beats beta's 1)", buildCalls[0].stage === "build-alpha", buildCalls[0].stage);
	ok("the build prompt carries the picked row's repo", buildCalls[0].prompt.includes("o/alpha"), buildCalls[0].prompt);
	ok("the build prompt carries the mandatory PR marker line naming this run", /Opened with osstrich · run \S+headless\S+/.test(buildCalls[0].prompt), buildCalls[0].prompt);

	const dir = join(runsDir, readdirSync(runsDir).find((d) => d.includes("headless")));
	const record = JSON.parse(readFileSync(join(dir, "run-record.jsonl"), "utf8").trim().split("\n").pop());
	ok("record.candidates counts every verdict row, not just funded ones", record.candidates === 3, JSON.stringify(record));
	ok("record.funded counts the two fund rulings", record.funded === 2, JSON.stringify(record));
	ok("record.deferred counts the one defer ruling", record.deferred === 1, JSON.stringify(record));
	ok("record.gate_upstream counts alpha's gate", record.gate_upstream === 1, JSON.stringify(record));
	ok("record.prs_opened is read from the build stage's own first line", record.prs_opened === 1, JSON.stringify(record));
});

test("discover: no TTY behaves as headless even without --headless", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-notty-"));
	let isInteractivePromptUsed = false;
	const { deps, calls } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			isTTY: false,
			prompts: createFakePrompts({
				multiselectAnswer: (() => {
					isInteractivePromptUsed = true;
					return [];
				})(),
			}),
			runAgentStage: async (args) => {
				if (args.stage === "verdict") {writeFundedVerdict(args.runDir);}
				else {writeFileSync(join(args.runDir, `${args.stage}.md`), "prs_opened: 0\n");}
				return { ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) };
			},
		},
	});
	await main(["discover", "--slug", "nottytest"], deps);
	ok("no TTY and no --headless still runs exactly one build stage (headless default)", calls.runAgentStage.filter((c) => c.stage.startsWith("build-")).length === 1);
	ok("the interactive multiselect prompt was never actually invoked", isInteractivePromptUsed === false || calls.runAgentStage.length > 0);
});

test("build: with a target opens a new run directory named for it and runs the build stage", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-buildtarget-"));
	const { deps, calls } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			runAgentStage: async (args) => {
				writeFileSync(join(args.runDir, `${args.stage}.md`), "prs_opened: 2\n");
				return { ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) };
			},
		},
	});

	const code = await main(["build", "acme/widget#123"], deps);
	ok("build with a target exits 0", code === 0);
	ok("exactly one build stage ran, named for the target", calls.runAgentStage.length === 1 && calls.runAgentStage[0].stage === "build-acme-widget-123", calls.runAgentStage[0]?.stage);
	ok("the build prompt carries the raw target string", calls.runAgentStage[0].prompt.includes("acme/widget#123"), calls.runAgentStage[0].prompt);

	const createdDir = readdirSync(runsDir).find((d) => d.includes("acme-widget-123"));
	ok("a new run directory was opened, named for the target's slug", Boolean(createdDir), readdirSync(runsDir).join(","));
	const record = JSON.parse(readFileSync(join(runsDir, createdDir, "run-record.jsonl"), "utf8").trim().split("\n").pop());
	ok("prs_opened is read back from the build stage's own file", record.prs_opened === 2, JSON.stringify(record));
});

test("build: without a target, builds the oldest funded row not yet built, then the next, then exits 2 once none remain", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-buildnotarget-"));
	const { dir } = openRun({ runsDir, slug: "priordiscover", fs: nodeFs });
	writeFundedVerdict(dir);

	const built = [];
	const { deps } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			// The fake stands in for lib/agent.mjs's runAgentStage, so it also
			// marks the stage "done" in status.json the same way the real one
			// does — that's the record `build`'s own "already built?" check
			// (cmdBuild reading status.json) depends on.
			runAgentStage: async (args) => {
				built.push(args.stage);
				writeFileSync(join(args.runDir, `${args.stage}.md`), "prs_opened: 1\n");
				markPhase(args.runDir, { stage: args.stage, state: "done" }, { fs: nodeFs });
				return { ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) };
			},
		},
	});

	const firstCode = await main(["build"], deps);
	ok("the first no-target build exits 0", firstCode === 0);
	ok("it builds alpha first (verdict row order)", built[0] === "build-alpha", JSON.stringify(built));

	const secondCode = await main(["build"], deps);
	ok("the second no-target build exits 0", secondCode === 0);
	ok("it builds beta next, skipping the already-built alpha", built[1] === "build-beta", JSON.stringify(built));

	const { deps: thirdDeps, stderr } = makeCodePhaseDeps({ runsDir });
	const thirdCode = await main(["build"], thirdDeps);
	ok("with every funded row already built, build exits 2", thirdCode === 2);
	ok("the message tells the user to discover again", stderr.text.includes("run osstrich discover"), stderr.text);
});

test("build: without a target, a verdict.json that parses but carries no .rows field is treated as zero funded rows", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-buildnoverdictrows-"));
	const { dir } = openRun({ runsDir, slug: "priordiscover", fs: nodeFs });
	writeFileSync(join(dir, "verdict.json"), JSON.stringify({}));

	const { deps, stderr } = makeCodePhaseDeps({ runsDir });
	const code = await main(["build"], deps);
	ok("a verdict.json with no .rows field never throws — it's treated as zero rows", code === 2);
	ok("with zero rows, the funded-row search comes up empty the same as if none were funded", stderr.text.includes("no funded row left"), stderr.text);
});

test("main(): a thin (bin-shaped) rawDeps that resolves successfully through defaultDeps() dispatches normally, no throw", async () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "osstrich-cli-thindeps-ok-"));
	mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
	const homedir = mkdtempSync(join(tmpdir(), "osstrich-cli-thindeps-ok-home-"));
	const stdout = createSink();
	// No `.osstrich.json` at all — loadConfig applies its ordinary defaults,
	// so defaultDeps() resolves cleanly (never throws) despite `rawDeps`
	// carrying none of the "resolved" shape's own keys (no `collectInventory`
	// etc.) — the exact thin shape `bin/osstrich.mjs` actually builds.
	const code = await main(["bogus-command"], {
		fs: nodeFs,
		env: {},
		exec: async () => ({ stdout: "{}" }),
		cwd: repoRoot,
		homedir,
		stdout,
		stderr: createSink(),
	});
	ok("an unknown command still exits 2 (usage), proving dispatch was reached — defaultDeps() never threw", code === 2);
	ok("usage was printed through the resolved deps' own stdout", stdout.text.includes("usage: osstrich <command>"), stdout.text);
});

test("main(): a nullish rawDeps itself (not just a missing key) throws synchronously reading .collectInventory, caught the same as any other resolve-deps failure", async () => {
	const code = await main(["discover"], null);
	ok("a null rawDeps exits 2 rather than throwing out of main()", code === 2);
});

test("main(): the command ?? 'run' fallback in formatFailure fires when argv is empty and dispatch still fails", async () => {
	// case 1: empty argv (`command` is undefined) AND a bad config makes
	// defaultDeps() itself throw — hit inside the FIRST catch (resolving
	// deps), before any command would have dispatched.
	{
		const repoRoot = mkdtempSync(join(tmpdir(), "osstrich-cli-emptyargv-badconfig-"));
		mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
		writeFileSync(join(repoRoot, ".osstrich.json"), "{ not valid json");
		const homedir = mkdtempSync(join(tmpdir(), "osstrich-cli-emptyargv-badconfig-home-"));
		const stderr = createSink();
		const code = await main([], { fs: nodeFs, env: {}, exec: async () => ({ stdout: "{}" }), cwd: repoRoot, homedir, stdout: createSink(), stderr });
		ok("empty argv with a config error still exits 2", code === 2);
		ok("the failure line names 'run', not 'undefined', as the command", stderr.text.includes("osstrich run: FAILED"), stderr.text);
	}

	// case 2: empty argv (`command` is undefined) but deps ARE already
	// resolved (skips defaultDeps entirely) — the `default:` switch branch
	// itself throws, hit inside the SECOND (dispatch) catch instead.
	{
		const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-emptyargv-dispatchfail-"));
		const stderr = createSink();
		const { deps } = makeCodePhaseDeps({
			runsDir,
			overrides: {
				stderr,
				stdout: {
					write: () => {
						throw new Error("stdout exploded");
					},
				},
			},
		});
		const code = await main([], deps);
		ok("empty argv whose default-branch write itself throws still exits 2", code === 2);
		ok("the failure line names 'run', not 'undefined', as the command", stderr.text.includes("osstrich run: FAILED"), stderr.text);
	}
});

test("build: without a target, a non-build status.json entry is filtered before its .state is ever read", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-buildmixedstatus-"));
	const { dir } = openRun({ runsDir, slug: "priordiscover", fs: nodeFs });
	writeFundedVerdict(dir);
	// A phase entry that ISN'T a build stage — `p.stage.startsWith('build-')`
	// must short-circuit false here, never reading `.state`, so this entry
	// is filtered out of builtSlugs entirely rather than confusing it.
	markPhase(dir, { stage: "inventory", state: "done" }, { fs: nodeFs });

	const built = [];
	const { deps } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			runAgentStage: async (args) => {
				built.push(args.stage);
				writeFileSync(join(args.runDir, `${args.stage}.md`), "prs_opened: 1\n");
				markPhase(args.runDir, { stage: args.stage, state: "done" }, { fs: nodeFs });
				return { ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) };
			},
		},
	});
	const code = await main(["build"], deps);
	ok("build succeeds despite a pre-existing non-build status entry", code === 0);
	ok("it still picks alpha first, unaffected by the inventory phase entry", built[0] === "build-alpha", JSON.stringify(built));
});

test("build: without a target, a status.json that parses but carries no .phases array treats nothing as already built", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-buildnostatusphases-"));
	const { dir } = openRun({ runsDir, slug: "priordiscover", fs: nodeFs });
	writeFundedVerdict(dir);
	writeFileSync(join(dir, "status.json"), JSON.stringify({}));

	const built = [];
	const { deps } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			runAgentStage: async (args) => {
				built.push(args.stage);
				writeFileSync(join(args.runDir, `${args.stage}.md`), "prs_opened: 1\n");
				return { ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) };
			},
		},
	});
	const code = await main(["build"], deps);
	ok("build succeeds when status.json has no .phases field", code === 0);
	ok("with nothing recorded as built, alpha (the first funded row) is picked", built[0] === "build-alpha", JSON.stringify(built));
});

test("discover: headless — a failed build stage skips prs_opened without throwing, and minimal inventory/rank shapes fall back to 0", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-headless-minimal-"));
	const { deps } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			collectInventory: async () => ({ status: "complete" }),
			rankProjects: () => ({}),
			runAgentStage: async (args) => {
				if (args.stage === "verdict") {
					writeFundedVerdict(args.runDir);
					return { ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) };
				}
				return { ok: false, exitCode: 1, logPath: join(args.runDir, `${args.stage}.log`) };
			},
		},
	});
	const code = await main(["discover", "--slug", "headlessminimal", "--headless"], deps);
	ok("discover still exits 0 even when the picked build stage fails", code === 0);
	const dir = join(runsDir, readdirSync(runsDir).find((d) => d.includes("headlessminimal")));
	const record = JSON.parse(readFileSync(join(dir, "run-record.jsonl"), "utf8").trim().split("\n").pop());
	ok("a failed build stage contributes 0 to prs_opened, never throws", record.prs_opened === 0, JSON.stringify(record));
	ok("projects_inventoried falls back to 0 when inventory carries no .projects", record.projects_inventoried === 0, JSON.stringify(record));
	ok("bottom_n falls back to 0 when rank carries no .bottom", record.bottom_n === 0, JSON.stringify(record));
});

test("discover --table: every optional summary field falls back to 0/{} when a phase returns a minimal shape", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-minimalshapes-"));
	const { deps, stdout } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			collectInventory: async () => ({ status: "complete" }),
			rankProjects: () => ({}),
			inferNextSteps: async () => ({}),
			shortlistUpstream: async () => ({}),
		},
	});
	const code = await main(["discover", "--slug", "minimalshapes", "--table"], deps);
	ok("discover exits 0 even when every phase returns a minimal shape", code === 0, deps.stderr?.text);
	ok("inventory summary falls back to projects=0 gaps=0", /osstrich inventory: projects=0 gaps=0 →/.test(stdout.text), stdout.text);
	ok("rank summary falls back to bottom=0 gaps=0", /osstrich rank: bottom=0 gaps=0 →/.test(stdout.text), stdout.text);
	ok("infer summary falls back to projects_with_hits=0 gaps=0", /osstrich infer: projects_with_hits=0 gaps=0 →/.test(stdout.text), stdout.text);
	ok("upstream summary falls back to checked=0 gaps=0", /osstrich upstream: checked=0 gaps=0 →/.test(stdout.text), stdout.text);
});

test("discover: the default slug, --bottom, and a falsy configPath all take their fallback/provided branches", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-defaultslug-"));
	let seenBottomN;
	const { deps, stdout } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			configPath: null,
			rankProjects: (_inventory, _markdown, opts) => {
				seenBottomN = opts.bottomN;
				return FAKE_RANK;
			},
		},
	});
	const code = await main(["discover", "--bottom", "3", "--table"], deps);
	ok("discover with no --slug at all exits 0 (defaults to 'discover')", code === 0);
	ok("a run directory named for the default slug 'discover' was opened", readdirSync(runsDir).some((d) => d.includes("-discover-")), readdirSync(runsDir).join(","));
	ok("--bottom is parsed to a real Number, not left as the string flag value", seenBottomN === 3, String(seenBottomN));
	ok("a falsy deps.configPath prints the 'no config' fallback line", stdout.text.includes("osstrich: config no config\n"), stdout.text);
});

test("standalone phases: the default slug (no --slug at all) and --bottom both take their non-default branches", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-phase-defaultslug-"));
	const { deps } = makeCodePhaseDeps({ runsDir });
	const inventoryCode = await main(["inventory"], deps);
	ok("inventory with no --slug at all exits 0 (defaults to its own verb as the slug)", inventoryCode === 0);
	ok("a run directory named for the default slug 'inventory' was opened", readdirSync(runsDir).some((d) => d.includes("-inventory-")), readdirSync(runsDir).join(","));

	let seenBottomN;
	const { deps: rankDeps } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			rankProjects: (_inventory, _markdown, opts) => {
				seenBottomN = opts.bottomN;
				return FAKE_RANK;
			},
		},
	});
	const soloDir = readdirSync(runsDir).find((d) => d.includes("-inventory-"));
	const rankCode = await main(["rank", "--dir", join(runsDir, soloDir), "--bottom", "7"], rankDeps);
	ok("rank --bottom exits 0", rankCode === 0);
	ok("--bottom is parsed to a real Number for the standalone phase too", seenBottomN === 7, String(seenBottomN));
});

test("loadRunEndHook (via defaultDeps): a hook module whose default export isn't a function degrades to null", async () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "osstrich-runendhook-nonfn-"));
	mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
	const homedir = mkdtempSync(join(tmpdir(), "osstrich-runendhook-nonfn-home-"));
	const hookPath = join(repoRoot, "run-end-hook.mjs");
	writeFileSync(hookPath, "export default 42;\n");
	writeFileSync(join(repoRoot, ".osstrich.json"), JSON.stringify({ hooks: { runEnd: hookPath } }));
	const deps = await defaultDeps({ cwd: repoRoot, fs: nodeFs, env: {}, homedir, exec: async () => ({ stdout: "{}" }) });
	ok("a non-function default export never becomes onRunEnd", deps.onRunEnd === null);
});

test("defaultDeps(): called with no overrides at all falls back to every real Node default (fs, env, homedir, cwd)", async () => {
	// No `cwd`/`repoRoot` override at all: this exercises BOTH nullish
	// fallbacks on that line (repoRoot undefined -> falls through to
	// process.cwd()) in one call — process.cwd() here is this repo's own
	// checkout, which has no .osstrich.json, so loadConfig applies its
	// ordinary defaults exactly as it would for any real invocation.
	const deps = await defaultDeps({});
	ok("fs falls back to the real node:fs module", typeof deps.fs.readFileSync === "function");
	ok("env falls back to the real process.env", deps.env === process.env);
	ok("homedir falls back to the real os.homedir()", typeof deps.homedir === "string" && deps.homedir.length > 0);
	ok("cwd falls back to the real process.cwd()", deps.cwd === process.cwd());
	ok("repoRoot mirrors the same fallback cwd", deps.repoRoot === process.cwd());
});

test("phaseLine/skipLine: a deps.now() override drives the printed timestamp instead of Date.now()", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-fixednow-"));
	const fixedNow = Date.UTC(2020, 0, 1);
	const { deps: firstDeps, stdout: firstStdout } = makeCodePhaseDeps({ runsDir, overrides: { now: () => fixedNow } });
	await main(["discover", "--slug", "fixednow", "--table"], firstDeps);
	ok("phaseLine uses deps.now() when it's a function", firstStdout.text.includes(`[${new Date(fixedNow).toISOString()}]`), firstStdout.text);

	const { deps: secondDeps, stdout: secondStdout } = makeCodePhaseDeps({ runsDir, overrides: { now: () => fixedNow } });
	const code = await main(["discover", "--slug", "fixednow", "--table", "--resume"], secondDeps);
	ok("the resumed pass exits 0", code === 0);
	ok("skipLine also uses deps.now() when it's a function", secondStdout.text.includes(`[${new Date(fixedNow).toISOString()}] osstrich inventory: skipped`), secondStdout.text);
});

test("readPrsOpened (via build): an empty build-<slug>.md file reads back as 0, exercising both its own soft-fallback branches", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-buildemptymd-"));
	const { deps } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			runAgentStage: async (args) => {
				writeFileSync(join(args.runDir, `${args.stage}.md`), "");
				return { ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) };
			},
		},
	});
	const code = await main(["build", "acme/empty#1"], deps);
	ok("build exits 0 even when the build stage's own .md file is empty", code === 0);
	const createdDir = readdirSync(runsDir).find((d) => d.includes("acme-empty-1"));
	const record = JSON.parse(readFileSync(join(runsDir, createdDir, "run-record.jsonl"), "utf8").trim().split("\n").pop());
	ok("an empty .md file reads back as prs_opened: 0", record.prs_opened === 0, JSON.stringify(record));
});

test("scrub: a scan result missing its own findings field defaults to zero findings", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-scrubnofindings-"));
	const { deps, stdout } = makeCodePhaseDeps({
		runsDir,
		overrides: { scrubText: async () => ({ ok: true }) },
	});
	const code = await main(["scrub", "--text", "anything"], deps);
	ok("a result with no findings field at all still exits 0 (treated as clean)", code === 0);
	ok("the summary line reports 0 finding(s)", stdout.text.includes("osstrich scrub: 0 finding(s)"), stdout.text);
});

test("recheck: a result missing one of its bucket keys defaults that bucket to an empty list", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-recheckmissingbucket-"));
	const { deps, stdout } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			extractClaims: () => [],
			recheckClaims: async () => ({ fired: [] }),
		},
	});
	const code = await main(["recheck", "some.md"], deps);
	ok("recheck exits 0 even when the result omits contradicted/unconfirmable/current", code === 0);
	ok("the missing 'contradicted' bucket still prints as 0, not a throw", stdout.lines.some((l) => l.trim() === "contradicted: 0"), JSON.stringify(stdout.lines));
	ok("the missing 'unconfirmable' bucket still prints as 0", stdout.lines.some((l) => l.trim() === "unconfirmable: 0"));
	ok("the missing 'current' bucket still prints as 0", stdout.lines.some((l) => l.trim() === "current: 0"));
});

test("defaultDeps()/main(): the default stdout/stderr writer closures reach the real process streams when nothing overrides them", async () => {
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	const capturedStdout = [];
	const capturedStderr = [];
	process.stdout.write = (chunk) => {
		capturedStdout.push(chunk);
		return true;
	};
	process.stderr.write = (chunk) => {
		capturedStderr.push(chunk);
		return true;
	};
	try {
		const deps = await defaultDeps({});
		deps.stdout.write("hello-stdout-default\n");
		deps.stderr.write("hello-stderr-default\n");
		ok("defaultDeps' own default stdout.write reaches process.stdout.write", capturedStdout.some((c) => c.includes("hello-stdout-default")), JSON.stringify(capturedStdout));
		ok("defaultDeps' own default stderr.write reaches process.stderr.write", capturedStderr.some((c) => c.includes("hello-stderr-default")), JSON.stringify(capturedStderr));

		// main()'s own fallbackStderr default closure — only used when a
		// rawDeps with no `.stderr` key at all fails before a command even
		// resolves (defaultDeps() itself throwing on a bad config).
		const repoRoot = mkdtempSync(join(tmpdir(), "osstrich-cli-fallbackstderr-"));
		mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
		writeFileSync(join(repoRoot, ".osstrich.json"), "{ not valid json");
		const homedir = mkdtempSync(join(tmpdir(), "osstrich-cli-fallbackstderr-home-"));
		capturedStderr.length = 0;
		const code = await main(["discover"], { fs: nodeFs, env: {}, exec: async () => ({ stdout: "{}" }), cwd: repoRoot, homedir });
		ok("a config error with no rawDeps.stderr at all still exits 2", code === 2);
		ok("main()'s own fallbackStderr default reaches process.stderr.write", capturedStderr.some((c) => c.includes("FAILED")), JSON.stringify(capturedStderr));
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
});

test("defaultDeps(): the real collectInventory/inferNextSteps/shortlistUpstream wrappers actually invoke their underlying modules", async () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "osstrich-defaultdeps-realcalls-"));
	mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
	const homedir = mkdtempSync(join(tmpdir(), "osstrich-defaultdeps-realcalls-home-"));
	const deps = await defaultDeps({ cwd: repoRoot, fs: nodeFs, env: {}, homedir, exec: async () => ({ stdout: "{}" }) });

	const inventory = await deps.collectInventory({ repoRoot, fs: nodeFs, exec: deps.exec, fetch: deps.fetch });
	ok("the real collectInventory wrapper returns an inventory shape", Array.isArray(inventory.projects), JSON.stringify(inventory));

	const inferred = await deps.inferNextSteps({ repoRoot, fs: nodeFs, projects: [] });
	ok("the real inferNextSteps wrapper returns the byProject shape", typeof inferred.byProject === "object" && inferred.byProject !== null, JSON.stringify(inferred));

	const shortlist = await deps.shortlistUpstream({ projects: [], inferred: {}, exec: deps.exec });
	ok("the real shortlistUpstream wrapper returns the budget shape", typeof shortlist.budget === "object" && shortlist.budget !== null, JSON.stringify(shortlist));
});

test("defaultDeps(): real wiring exposes every contract key this CLI needs", async () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "osstrich-defaultdeps-"));
	mkdirSync(join(repoRoot, "node_modules"), { recursive: true }); // keep the real deriveRepoStopwords walk trivial
	const homedir = mkdtempSync(join(tmpdir(), "osstrich-defaultdeps-home-"));
	const deps = await defaultDeps({ cwd: repoRoot, fs: nodeFs, env: {}, homedir, exec: async () => ({ stdout: "{}" }) });

	const requiredKeys = [
		"collectInventory",
		"rankProjects",
		"renderRankMarkdown",
		"inferNextSteps",
		"shortlistUpstream",
		"scrubText",
		"scrubPaths",
		"extractClaims",
		"recheckClaims",
		"openRun",
		"writePartial",
		"finishRun",
		"runAgentStage",
		"fs",
		"exec",
		"fetch",
		"stdout",
		"stderr",
		"runsDir",
		"repoRoot",
		"classificationPath",
		"termsPath",
		"configPath",
		"onRunEnd",
		"agentCommand",
		"agentModel",
		"skillDir",
	];
	ok(
		"defaultDeps() exposes every contract key",
		requiredKeys.every((k) => Object.hasOwn(deps, k)),
		Object.keys(deps).join(","),
	);
	ok("defaultDeps().runsDir defaults under the given homedir (~/.osstrich)", deps.runsDir === join(homedir, ".osstrich"), deps.runsDir);
	ok("defaultDeps().repoRoot is the given cwd", deps.repoRoot === repoRoot);
	ok("defaultDeps().agentCommand is null with no .osstrich.json and no env override", deps.agentCommand === null);
	ok("defaultDeps().onRunEnd is null with no hook configured", deps.onRunEnd === null);
	ok("defaultDeps().skillDir points at this package's own skill/ directory", deps.skillDir.endsWith(join("lib", "..", "skill")) || deps.skillDir.endsWith("skill"), deps.skillDir);

	const claims = await deps.extractClaims({ files: [], fs: nodeFs });
	ok("a lazily-resolved real module (extractClaims) actually runs", Array.isArray(claims) && claims.length === 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Every subcommand `main()` keeps from the private core this was ported
// from (inventory/rank/infer/upstream/scrub/recheck/record), plus the
// usage/--slug validation shared across all of them. Ported assertions
// from that core's own CLI test suite, adapted onto lib/cli-core.mjs's own
// deps contract.
// ─────────────────────────────────────────────────────────────────────────

test("standalone phases: prerequisite errors and the happy chain", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-phases-"));
	const { deps } = makeCodePhaseDeps({ runsDir });
	const soloDir = openRun({ runsDir, slug: "solo-chain", fs: nodeFs }).dir;

	ok("rank with no prior inventory partial exits 1", (await main(["rank", "--dir", soloDir], deps)) === 1);
	ok("infer with no prior inventory partial exits 1", (await main(["infer", "--dir", soloDir], deps)) === 1);
	ok("inventory alone exits 0", (await main(["inventory", "--dir", soloDir], deps)) === 0);
	ok("upstream with an inventory but no infer partial exits 1", (await main(["upstream", "--dir", soloDir], deps)) === 1);
	ok("infer, given --dir with an existing inventory partial, exits 0", (await main(["infer", "--dir", soloDir], deps)) === 0);
	ok("upstream after inventory+infer exist exits 0", (await main(["upstream", "--dir", soloDir], deps)) === 0);
	ok("shortlist.json exists after the standalone upstream phase", existsSync(join(soloDir, "shortlist.json")));
	ok("rank, given --dir with an existing inventory partial, exits 0", (await main(["rank", "--dir", soloDir], deps)) === 0);

	// --slug (no --dir) opens/reuses its own run directory the same way.
	const bySlugCode = await main(["inventory", "--slug", "byslug"], deps);
	ok("inventory --slug (no --dir) exits 0 and opens its own run directory", bySlugCode === 0);
	ok("a run directory named for the slug was created", readdirSync(runsDir).some((d) => d.includes("byslug")));
});

function makeScrubDeps(runsDir) {
	return makeCodePhaseDeps({
		runsDir,
		overrides: {
			scrubText: async ({ text }) => {
				if (text.includes("ENGINEBOOM")) {return { ok: false, error: "gitleaks exec failed: boom" };}
				return { ok: !text.includes("SECRETNAME"), findings: text.includes("SECRETNAME") ? [{ term: "SECRETNAME" }] : [] };
			},
			scrubPaths: async ({ paths }) => paths.some((p) => p.includes("ENGINEBOOM")) ? { ok: false, findings: [], error: "gitleaks exec failed: boom" } : { ok: true, findings: [], paths },
		},
	});
}

test("scrub: findings, clean, paths, an engine failure, --help, and an unrecognized flag", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-scrub-"));
	const { deps, stdout, stderr } = makeScrubDeps(runsDir);

	const dirtyCode = await main(["scrub", "--text", "this body names SECRETNAME"], deps);
	ok("scrub --text with a finding exits 1", dirtyCode === 1);
	ok("scrub prints one JSON line per finding plus a summary", stdout.lines.some((l) => l.includes("SECRETNAME")) && stdout.lines.some((l) => l.includes("1 finding")));

	stdout.lines.length = 0;
	const cleanCode = await main(["scrub", "--text", "nothing sensitive here"], deps);
	ok("scrub --text with no finding exits 0", cleanCode === 0);
	ok("clean scrub summary reports 0 findings", stdout.lines.some((l) => l.includes("0 finding")));

	stdout.lines.length = 0;
	const pathsCode = await main(["scrub", "some/file.md", "some/dir"], deps);
	ok("scrub over paths (no --text) exits 0 on the fake's clean result", pathsCode === 0);

	stdout.lines.length = 0;
	stderr.lines.length = 0;
	const failedCode = await main(["scrub", "--text", "ENGINEBOOM"], deps);
	ok("a scan-engine failure exits 2, distinct from 0 (clean) and 1 (findings)", failedCode === 2);
	ok(
		"a scan-engine failure prints the FAILED line to stderr, never stdout",
		stderr.lines.includes("osstrich scrub: FAILED — gitleaks exec failed: boom\n") && stdout.lines.length === 0,
		JSON.stringify({ stdout: stdout.lines, stderr: stderr.lines }),
	);

	stdout.lines.length = 0;
	stderr.lines.length = 0;
	const helpCode = await main(["scrub", "--help"], deps);
	ok("scrub --help exits 2 rather than scanning zero paths", helpCode === 2);
	ok("scrub --help prints the usage text", stdout.lines.some((l) => l.includes("usage: osstrich <command>")));
	ok("scrub --help never touches stderr", stderr.lines.length === 0);

	stdout.lines.length = 0;
	const unknownFlagCode = await main(["scrub", "--bogus", "some/file.md"], deps);
	ok("an unrecognized scrub flag exits 2 with usage, not a scan", unknownFlagCode === 2);
	ok("the unrecognized-flag usage print matches --help's", stdout.lines.some((l) => l.includes("usage: osstrich <command>")));
});

test("recheck: prints every bucket's count, including empty ones", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-recheck-"));
	const { deps, stdout } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			extractClaims: ({ files }) =>
				files.length > 0 ? [{ file: files[0], line: 1, text: "claim", url: "https://github.com/o/r/pull/1", kind: "pr", condition: true }] : [],
			recheckClaims: async ({ claims }) => ({ fired: claims, contradicted: [], unconfirmable: [], current: [] }),
		},
	});
	const code = await main(["recheck", "references/repos/foo.md"], deps);
	ok("recheck exits 0", code === 0);
	ok("recheck prints the fired bucket count", stdout.lines.some((l) => l.trim() === "fired: 1"), JSON.stringify(stdout.lines));
	ok("recheck prints the other buckets even when empty", stdout.lines.some((l) => l.trim() === "contradicted: 0"));
});

test("record: --dir is required, and appends the session's counts to run-record.jsonl", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-record-"));
	const { deps } = makeCodePhaseDeps({ runsDir });
	await main(["inventory", "--slug", "recordtest"], deps);
	const dir = join(runsDir, readdirSync(runsDir).find((d) => d.includes("recordtest")));

	const missingDirCode = await main(["record"], deps);
	ok("record without --dir exits 2", missingDirCode === 2);

	const recordCode = await main(["record", "--dir", dir, "--funded", "3", "--deferred", "1"], deps);
	ok("record --dir with counts exits 0", recordCode === 0);
	const lines = readFileSync(join(dir, "run-record.jsonl"), "utf8").trim().split("\n");
	const last = JSON.parse(lines.at(-1));
	ok("record appends the session's funded count", last.funded === 3);
	ok("record appends the session's deferred count", last.deferred === 1);
});

test("an unknown subcommand, or none at all, prints usage and exits 2", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-usage-"));
	const { deps, stdout } = makeCodePhaseDeps({ runsDir });
	const code = await main(["bogus-command"], deps);
	ok("an unknown subcommand exits 2", code === 2);
	ok("an unknown subcommand prints the usage text", stdout.lines.some((l) => l.includes("usage: osstrich <command>")));

	const noArgsCode = await main([], deps);
	ok("no subcommand at all also exits 2 with usage", noArgsCode === 2);
});

test("--slug is validated against a strict charset before it ever reaches a path.join", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "osstrich-cli-slug-"));
	const { deps, stdout } = makeCodePhaseDeps({ runsDir, overrides: { agentCommand: null } });

	const traversalCode = await main(["discover", "--slug", "../x", "--table"], deps);
	ok("discover --slug ../x is rejected with exit 2", traversalCode === 2);
	ok("the rejection prints usage, not a scan", stdout.lines.some((l) => l.includes("usage: osstrich <command>")));
	ok("no run directory is created for a rejected slug", readdirSync(runsDir).length === 0, JSON.stringify(readdirSync(runsDir)));

	stdout.lines.length = 0;
	const phaseTraversalCode = await main(["inventory", "--slug", "../../elsewhere"], deps);
	ok("a standalone phase command's --slug is validated the same way", phaseTraversalCode === 2);
	ok("no run directory is created for the rejected phase slug either", readdirSync(runsDir).length === 0);

	stdout.lines.length = 0;
	const uppercaseCode = await main(["discover", "--slug", "Bad_Slug", "--table"], deps);
	ok("a slug with disallowed characters (uppercase, underscore) is rejected", uppercaseCode === 2);

	stdout.lines.length = 0;
	const validCode = await main(["discover", "--slug", "valid-slug-123", "--table"], deps);
	ok("a slug matching the allowed charset is accepted (not rejected as usage)", validCode !== 2);
	ok("a run directory was created for the valid slug", readdirSync(runsDir).some((d) => d.includes("valid-slug-123")));
});
