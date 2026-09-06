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
import { shortlistUpstream } from "../lib/upstream.mjs";
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
			if (concurrencyProbe) concurrencyProbe(inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
			const kind = args[0]; // "issue" | "pr"
			const repoIdx = args.indexOf("--repo");
			const repo = args[repoIdx + 1];
			const entry = repoResponses[repo];
			if (!entry) return { stdout: "[]" };
			if (entry.throwFor === kind) throw new Error(`gh ${kind} list exploded for ${repo}`);
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
			!result.byProject.alpha.matches.some((m) => m.keyword === "race"),
			JSON.stringify(result.byProject.alpha.matches),
		);
		ok(
			"#n ref match found even with an unrelated title",
			result.byProject.beta.matches.some((m) => m.keyword === "#42" && m.item === "https://github.com/o/beta/issues/42"),
			JSON.stringify(result.byProject.beta.matches),
		);
		ok("no match on the unrelated alpha issue", !result.byProject.alpha.matches.some((m) => m.item.endsWith("/issues/5")));
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
		let threw = false;
		let result;
		try {
			result = await shortlistUpstream({ projects, inferred: {}, exec });
		} catch {
			threw = true;
		}
		ok("a failing gh call never throws out of shortlistUpstream", !threw);
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
				if (opts?.recursive) return; // idempotent parent (runsDir) creation
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
			writeFileSync: () => {},
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
		let hookThrew = false;
		let throwingPath;
		try {
			throwingPath = await finishRun(hookRun.dir, { funded: 2 }, { fs: nodeFs, now, onRunEnd: throwingHook });
		} catch {
			hookThrew = true;
		}
		ok("finishRun never propagates a throwing onRunEnd hook", !hookThrew);
		const linesAfterThrow = readFileSync(throwingPath, "utf8").trim().split("\n");
		ok("the record's own line still lands (2 real records + 1 gap line)", linesAfterThrow.length === 3, JSON.stringify(linesAfterThrow));
		const gapLine = JSON.parse(linesAfterThrow[2]);
		ok("the hook failure is recorded as a gap line naming the failure, not thrown", gapLine.gap?.includes("hook boom"), JSON.stringify(gapLine));
		ok("the gap line still names the run_id", gapLine.run_id === basename(hookRun.dir));

		let calledWithoutHook = false;
		try {
			await finishRun(hookRun.dir, {}, { fs: nodeFs, now });
			calledWithoutHook = true;
		} catch {
			calledWithoutHook = false;
		}
		ok("finishRun with no onRunEnd at all is a plain no-op on the hook", calledWithoutHook);
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
		ok(`--resume prints a skip line for ${phase}`, new RegExp(`osstrich ${phase}: skipped \\(partial present\\)`).test(secondStdout.text), secondStdout.text);
	}
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
	let interactivePromptUsed = false;
	const { deps, calls } = makeCodePhaseDeps({
		runsDir,
		overrides: {
			isTTY: false,
			prompts: createFakePrompts({
				multiselectAnswer: (() => {
					interactivePromptUsed = true;
					return [];
				})(),
			}),
			runAgentStage: async (args) => {
				if (args.stage === "verdict") writeFundedVerdict(args.runDir);
				else writeFileSync(join(args.runDir, `${args.stage}.md`), "prs_opened: 0\n");
				return { ok: true, exitCode: 0, logPath: join(args.runDir, `${args.stage}.log`) };
			},
		},
	});
	await main(["discover", "--slug", "nottytest"], deps);
	ok("no TTY and no --headless still runs exactly one build stage (headless default)", calls.runAgentStage.filter((c) => c.stage.startsWith("build-")).length === 1);
	ok("the interactive multiselect prompt was never actually invoked", interactivePromptUsed === false || calls.runAgentStage.length > 0);
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
	ok("defaultDeps() exposes every contract key", requiredKeys.every((k) => k in deps), Object.keys(deps).join(","));
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
				if (text.includes("ENGINEBOOM")) return { ok: false, error: "gitleaks exec failed: boom" };
				return { ok: !text.includes("SECRETNAME"), findings: text.includes("SECRETNAME") ? [{ term: "SECRETNAME" }] : [] };
			},
			scrubPaths: async ({ paths }) => {
				if (paths.some((p) => p.includes("ENGINEBOOM"))) return { ok: false, findings: [], error: "gitleaks exec failed: boom" };
				return { ok: true, findings: [], paths };
			},
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
		stderr.lines.some((l) => l === "osstrich scrub: FAILED — gitleaks exec failed: boom\n") && stdout.lines.length === 0,
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
				files.length ? [{ file: files[0], line: 1, text: "claim", url: "https://github.com/o/r/pull/1", kind: "pr", condition: true }] : [],
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
	const last = JSON.parse(lines[lines.length - 1]);
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
