/**
 * osstrich-scrub-recheck/runner.mjs — unit tests for
 * shared/osstrich-scrub.mjs and shared/osstrich-recheck.mjs.
 *
 * Scrub: config-generation tests (literal escaping, regex passthrough,
 * comment/blank skipping) never touch gitleaks at all. The main-path and
 * failure-path scrub tests inject a fake `exec` that stands in for the
 * gitleaks subprocess — writing a canned JSON report to the report path it
 * was given, or throwing — so THE REAL BINARY IS NOT INVOKED for any of
 * those. One additional test, guarded by `existsSync` on the real vendored
 * binary, spawns the actual pinned `gitleaks` (via the module's real
 * default exec) against a fabricated body — a true end-to-end check of the
 * shipped `references/scrub-terms.txt` + config generator, never run
 * against a fake.
 *
 * Recheck: `extractClaims` is exercised against an in-memory fixture
 * "file" (fake `fs.readFileSync`); `recheckClaims` gets a fake `exec` that
 * returns canned `gh api` JSON keyed by the endpoint it was asked for, so
 * every bucket (fired/contradicted/unconfirmable/current), the rate-limit
 * stop, and the concurrency bound are all verified without a network call.
 *
 * Exits 0 on all-pass, 1 on any failure.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { RATE_LIMIT_FLOOR, RECHECK_CONCURRENCY, extractClaims, recheckClaims } from "../lib/recheck.mjs";
import { scrubPaths, scrubText } from "../lib/scrub.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

/** `resolveGitleaksBin`'s own (internal-only) path formula — `node_modules/
 * .bin/gitleaks` relative to a repo root — reproduced here just to set up
 * fixture preconditions ("this bare dir has no vendored binary present");
 * never exported by lib/scrub.mjs, so a test that needs this computes it
 * locally. */
function gitleaksBinPath(repoRoot) {
	return join(repoRoot, "node_modules", ".bin", "gitleaks");
}

// A real gitleaks binary is either vendored under this package's own
// node_modules/.bin (what scrubText actually invokes) or just available on
// PATH for local development — either is enough to run this one true
// end-to-end test; neither means the integration test skips cleanly (via
// node:test's own `t.skip()`, not a trivially-true assertion).
function findGitleaksBin() {
	const vendored = gitleaksBinPath(process.cwd());
	if (existsSync(vendored)) return vendored;
	for (const dir of (process.env.PATH || "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, "gitleaks");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function ok(name, cond, detail = "") {
	assert.ok(cond, detail ? `${name} — ${detail}` : name);
}


const tmpRoot = mkdtempSync(join(tmpdir(), "osstrich-scrub-recheck-test-"));
after(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

// `parseTerms`/`buildGitleaksConfig` are internal to lib/scrub.mjs (no
// production file imports them outside their own module) — this exercises
// the same behavior through the public `scrubText` entrypoint, capturing
// the TOML config a fake exec is handed via `--config` instead of calling
// the config builder directly.
test("scrubText: gitleaks config generation — comments/blanks skipped, literal vs. regex, safe rule ids", async () => {
	{
		const termsText = ["# a header comment", "", "Widgetco", "  ", "someone@example.test", "re:Example-Laptop", "re:/home/(a|b)/"].join("\n");
		let capturedConfig = null;
		const capturingExec = async (_cmd, args) => {
			const configIdx = args.indexOf("--config");
			capturedConfig = readFileSync(args[configIdx + 1], "utf8");
			const reportIdx = args.indexOf("--report-path");
			writeFileSync(args[reportIdx + 1], "[]");
			return { stdout: "", stderr: "" };
		};
		await scrubText({ text: "irrelevant", termsText, exec: capturingExec, repoRoot: tmpRoot });

		ok("config declares a title", capturedConfig.includes('title = "osstrich-scrub"'), capturedConfig);
		ok("one [[rules]] block per parsed term (comments/blanks dropped, 4 of 7 lines)", (capturedConfig.match(/\[\[rules\]\]/g) || []).length === 4, capturedConfig);
		ok(
			"a literal term's regex metacharacters are escaped and case-insensitive",
			capturedConfig.includes("regex = '''(?i)someone@example\\.test'''"),
			capturedConfig,
		);
		ok("a plain literal term gets a case-insensitive wrapper", capturedConfig.includes("regex = '''(?i)Widgetco'''"), capturedConfig);
		ok("a `re:` term's regex passes through verbatim, no (?i) wrapper added", capturedConfig.includes("regex = '''Example-Laptop'''"), capturedConfig);
		ok("a `re:` term with its own regex syntax survives untouched", capturedConfig.includes("regex = '''/home/(a|b)/'''"), capturedConfig);

		// The finding's rule id (RuleID, `id = "..."` in the generated config)
		// must never carry the term's own text — see lib/scrub.mjs's
		// slugifyTermId doc for why (a scrub finding is printed to stdout/logs).
		const ids = [...capturedConfig.matchAll(/^id = "([^"]+)"$/gm)].map((m) => m[1]);
		ok("one rule id per parsed term", ids.length === 4, JSON.stringify(ids));
		ok("every generated rule id is term-<n> only, never the term's own text", ids.every((id) => /^term-\d+$/.test(id)), JSON.stringify(ids));
	}
});

test("scrubText: fake exec writes a canned report, real gitleaks never invoked", async () => {
	{
		let execCalled = false;
		const fakeFindings = [{ RuleID: "term-1-gadget", StartLine: 3, Match: "Gadget" }];
		const fakeExec = async (_cmd, args) => {
			execCalled = true;
			const reportIdx = args.indexOf("--report-path");
			writeFileSync(args[reportIdx + 1], JSON.stringify(fakeFindings));
			return { stdout: "", stderr: "" };
		};
		// repoRoot points at a dir with no node_modules at all — proves the
		// real binary path is never actually spawned (it doesn't exist here).
		const bareRoot = mkdtempSync(join(tmpRoot, "no-node-modules-"));
		ok("a bare dir with no vendored gitleaks has no binary present", !existsSync(gitleaksBinPath(bareRoot)));

		const result = await scrubText({ text: "mentions Gadget", termsText: "Gadget", exec: fakeExec, repoRoot: bareRoot });
		ok("fake exec was called instead of a real spawn", execCalled === true);
		ok("findings are mapped to {rule, line, snippet}", result.findings.length === 1 && result.findings[0].rule === "term-1-gadget", JSON.stringify(result));
		ok("finding line comes from the report", result.findings[0].line === 3, JSON.stringify(result));
		ok("a 6-char match snippet is masked to first-2…last-2, never the raw text", result.findings[0].snippet === "Ga…et", JSON.stringify(result));
		ok("ok is false when findings are present", result.ok === false, JSON.stringify(result));
	}
});

test("scrubText: findings never carry the raw matched text (MED-2) — snippet is masked", async () => {
	{
		const fakeFindings = [
			{ RuleID: "term-1", StartLine: 7, Match: "someone@example.test" },
			{ RuleID: "term-2", StartLine: 9, Match: "abcd" },
		];
		const fakeExec = async (_cmd, args) => {
			const reportIdx = args.indexOf("--report-path");
			writeFileSync(args[reportIdx + 1], JSON.stringify(fakeFindings));
			return { stdout: "", stderr: "" };
		};
		const result = await scrubText({ text: "irrelevant", termsText: "Widgetco", exec: fakeExec, repoRoot: tmpRoot });
		ok("rule and line pass through unmasked", result.findings[0].rule === "term-1" && result.findings[0].line === 7, JSON.stringify(result.findings[0]));
		ok("a long match is masked to its first 2 and last 2 characters, joined by …", result.findings[0].snippet === "so…st", JSON.stringify(result.findings[0]));
		ok(
			"the raw matched text never appears anywhere in the finding",
			!JSON.stringify(result.findings[0]).includes("someone@example.test"),
			JSON.stringify(result.findings[0]),
		);
		ok("a match under 6 characters is fully masked as •••, not partially revealed", result.findings[1].snippet === "•••", JSON.stringify(result.findings[1]));
	}
});

// `buildGitleaksConfig` is internal — its throw is caught right inside the
// module's own gitleaks runner and converted to `{ok:false,error}`, so the
// public behavior (never a corrupt silent scan) is asserted end-to-end here.
test("scrubText: a term containing triple-single-quotes fails the scan SOFTLY, never corrupts the TOML config (MED-1)", async () => {
	{
		const result = await scrubText({ text: "irrelevant", termsText: "safe-term\nbroken'''term", exec: async () => ({ stdout: "", stderr: "" }), repoRoot: tmpRoot });
		ok(
			"a TOML-breaking term fails the scan SOFTLY ({ok:false,error}), never a corrupt silent scan",
			result.ok === false && typeof result.error === "string" && result.error.includes("TOML"),
			JSON.stringify(result),
		);
		ok("the rejection names the offending term", result.error.includes("broken'''term"), result.error);
	}
});

test("scrubText: clean report → ok true, empty findings", async () => {
	{
		const fakeExec = async (_cmd, args) => {
			const reportIdx = args.indexOf("--report-path");
			writeFileSync(args[reportIdx + 1], "[]");
			return { stdout: "", stderr: "" };
		};
		const result = await scrubText({ text: "nothing sensitive here", termsText: "Widgetco", exec: fakeExec, repoRoot: tmpRoot });
		ok("ok is true and findings is an empty array on a clean scan", result.ok === true && result.findings.length === 0, JSON.stringify(result));
	}
});

test("scrubText: exec failure is soft — {ok:false, error}, never a throw", async () => {
	{
		const throwingExec = async () => {
			throw new Error("spawn ENOENT");
		};
		let threw = false;
		let result;
		try {
			result = await scrubText({ text: "x", termsText: "Widgetco", exec: throwingExec, repoRoot: tmpRoot });
		} catch {
			threw = true;
		}
		ok("scrubText never throws on an exec failure", threw === false);
		ok("failure comes back as {ok:false, error}", result.ok === false && typeof result.error === "string" && result.error.length > 0, JSON.stringify(result));
	}
});

test("scrubText: a report gitleaks never actually wrote is a soft failure, not a throw", async () => {
	{
		// A "successful" exec that never actually writes --report-path (a real
		// gitleaks binary always does, but a hostile/broken binary might not).
		const execThatWritesNothing = async () => ({ stdout: "", stderr: "" });
		const result = await scrubText({ text: "x", termsText: "Widgetco", exec: execThatWritesNothing, repoRoot: tmpRoot });
		ok(
			"a missing report file after a 'successful' exec is a soft failure naming the read step",
			result.ok === false && result.error.includes("could not read gitleaks report"),
			JSON.stringify(result),
		);
	}
});

test("scrubText: an unparseable gitleaks report is a soft failure, not a throw", async () => {
	{
		const execThatWritesGarbage = async (_cmd, args) => {
			const reportIdx = args.indexOf("--report-path");
			writeFileSync(args[reportIdx + 1], "not valid json{{{");
			return { stdout: "", stderr: "" };
		};
		const result = await scrubText({ text: "x", termsText: "Widgetco", exec: execThatWritesGarbage, repoRoot: tmpRoot });
		ok(
			"an unparseable report file is a soft failure naming the parse step",
			result.ok === false && result.error.includes("could not parse gitleaks report"),
			JSON.stringify(result),
		);
	}
});

test("scrubText: a failure writing the scrub input itself is a soft failure, not a throw", async () => {
	{
		// scrubText's own write (the scrub input text) fails before anything
		// else in the pipeline is touched, so a minimal fake fs suffices.
		const fakeFsWriteFails = {
			writeFileSync: () => {
				throw new Error("disk full");
			},
		};
		const workDir = mkdtempSync(join(tmpRoot, "writefail-"));
		const result = await scrubText({ text: "x", termsText: "Widgetco", fs: fakeFsWriteFails, tmpDir: workDir, repoRoot: tmpRoot });
		ok(
			"a failure writing the scrub input text is a soft failure naming that step",
			result.ok === false && result.error.includes("could not write scrub input"),
			JSON.stringify(result),
		);
	}
});

test("scrubPaths: merges findings across sources, stops and reports on first failure", async () => {
	{
		const fileA = join(tmpRoot, "a.txt");
		const fileB = join(tmpRoot, "b.txt");
		writeFileSync(fileA, "a");
		writeFileSync(fileB, "b");
		let call = 0;
		const fakeExec = async (_cmd, args) => {
			call += 1;
			const reportIdx = args.indexOf("--report-path");
			const findings = call === 1 ? [{ RuleID: "term-1-widgetco", StartLine: 1, Match: "a" }] : [];
			writeFileSync(args[reportIdx + 1], JSON.stringify(findings));
			return { stdout: "", stderr: "" };
		};
		const result = await scrubPaths({ paths: [fileA, fileB], termsText: "Widgetco", exec: fakeExec, repoRoot: tmpRoot });
		ok("findings from every scanned path are merged", result.findings.length === 1, JSON.stringify(result));

		let failingCall = 0;
		const failingExec = async (_cmd, args) => {
			failingCall += 1;
			if (failingCall === 1) {
				const reportIdx = args.indexOf("--report-path");
				writeFileSync(args[reportIdx + 1], "[]");
				return { stdout: "", stderr: "" };
			}
			throw new Error("boom");
		};
		const failResult = await scrubPaths({ paths: [fileA, fileB], termsText: "Widgetco", exec: failingExec, repoRoot: tmpRoot });
		ok("a later path's failure surfaces as {ok:false, error} naming the source", failResult.ok === false && failResult.error.includes(fileB), JSON.stringify(failResult));
	}
});

test("scrubPaths / scrubText: a finding's `file` field is populated per source kind", async () => {
	{
		// Directory scan: gitleaks' own relative `File` is caller-meaningful —
		// pass it through as-is.
		const dirPath = mkdtempSync(join(tmpRoot, "scan-dir-"));
		const fakeExecDir = async (_cmd, args) => {
			const reportIdx = args.indexOf("--report-path");
			writeFileSync(args[reportIdx + 1], JSON.stringify([{ RuleID: "term-1", StartLine: 2, Match: "Widgetco", File: "notes.txt" }]));
			return { stdout: "", stderr: "" };
		};
		const dirResult = await scrubPaths({ paths: [dirPath], termsText: "Widgetco", exec: fakeExecDir, repoRoot: tmpRoot });
		ok(
			"a directory-scan finding carries the gitleaks-reported relative file",
			dirResult.findings[0]?.file === "notes.txt",
			JSON.stringify(dirResult.findings),
		);

		// Single-file scan: gitleaks' own `File` value isn't reliably the
		// caller's own path — the finding's `file` maps back to the caller's
		// path directly instead.
		const singleFile = join(tmpRoot, "single-scan-target.txt");
		writeFileSync(singleFile, "secret stuff");
		const fakeExecFile = async (_cmd, args) => {
			const reportIdx = args.indexOf("--report-path");
			writeFileSync(args[reportIdx + 1], JSON.stringify([{ RuleID: "term-1", StartLine: 1, Match: "Widgetco", File: "single-scan-target.txt" }]));
			return { stdout: "", stderr: "" };
		};
		const fileResult = await scrubPaths({ paths: [singleFile], termsText: "Widgetco", exec: fakeExecFile, repoRoot: tmpRoot });
		ok(
			"a single-file-scan finding's `file` maps back to the caller's own path",
			fileResult.findings[0]?.file === singleFile,
			JSON.stringify(fileResult.findings),
		);

		// scrubText scans a synthetic tmp file with no meaning to the caller —
		// its finding's `file` is always null, whatever gitleaks reports.
		const fakeExecText = async (_cmd, args) => {
			const reportIdx = args.indexOf("--report-path");
			writeFileSync(args[reportIdx + 1], JSON.stringify([{ RuleID: "term-1", StartLine: 1, Match: "Widgetco", File: "scrub-input.txt" }]));
			return { stdout: "", stderr: "" };
		};
		const textResult = await scrubText({ text: "mentions Widgetco", termsText: "Widgetco", exec: fakeExecText, repoRoot: tmpRoot });
		ok("a scrubText finding's `file` is always null", textResult.findings[0]?.file === null, JSON.stringify(textResult.findings));
	}
});

test("scrubText: REAL gitleaks binary, skipped cleanly when not on PATH or in node_modules/.bin", async (t) => {
	const gitleaksBin = findGitleaksBin();
	if (!gitleaksBin) {
		t.skip("gitleaks not found on PATH or in node_modules/.bin");
		return;
	}

	// SYNTHETIC term file — this package ships no scrub-terms.txt of its
	// own (that file is a consumer repo's `.osstrich/scrub-terms.txt`, read
	// through `.osstrich.json`), so the end-to-end check plants its own
	// terms rather than reading anything repo-specific.
	const syntheticTermsText = ["Widgetco", "someone@example.test"].join("\n");
	const body = "This PR references Widgetco internally and can be reached at someone@example.test.";
	const result = await scrubText({ text: body, termsText: syntheticTermsText, repoRoot: process.cwd() });
	ok("real gitleaks ran (no error)", result.error === undefined, JSON.stringify(result));
	ok("real gitleaks found exactly 2 planted terms", result.ok === false && result.findings.length === 2, JSON.stringify(result));
	// `buildGitleaksConfig`/`parseTerms` are internal — a config that didn't
	// build, or terms that didn't parse to 2 entries, would already have
	// shown up above as a scan failure or a wrong finding count.
});

test("extractClaims: url + kind extraction, condition detection, no-checkable-artifact lines", async () => {
	{
		const fixtureText = [
			"1: retire this pin once https://github.com/o/r/pull/1 merges",
			"2: still open, see https://github.com/o/r/pull/2",
			"3: opened as an upstream PR against o/r (no link filed yet)",
			"4: https://github.com/o/r/releases/tag/v1.0.0 lets us drop the shim once it ships",
			"5: nothing to see here",
			"6: https://github.com/o/r/issues/9 is open right now",
		].join("\n");
		const fakeFs = { readFileSync: () => fixtureText };
		const claims = extractClaims({ files: ["notes.md"], fs: fakeFs });
		ok("only claim-worthy lines are extracted (5 of 6)", claims.length === 5, JSON.stringify(claims));
		const byLine = Object.fromEntries(claims.map((cl) => [cl.line, cl]));
		ok("line 1: pr url + condition true", byLine[1].kind === "pr" && byLine[1].condition === true, JSON.stringify(byLine[1]));
		ok("line 2: pr url, condition false", byLine[2].kind === "pr" && byLine[2].condition === false, JSON.stringify(byLine[2]));
		ok("line 3: no url, condition true (the §57 failure mode)", byLine[3].url === null && byLine[3].kind === "none" && byLine[3].condition === true, JSON.stringify(byLine[3]));
		ok("line 4: release url + condition true", byLine[4].kind === "release" && byLine[4].condition === true, JSON.stringify(byLine[4]));
		ok("line 5 (no url, no condition) is not extracted", byLine[5] === undefined);
		ok("line 6: issue url, condition false", byLine[6].kind === "issue" && byLine[6].condition === false, JSON.stringify(byLine[6]));
	}
});

test("extractClaims: DEFECT B — bare 'PR #<n>' resolves against the note's own repo heading", async () => {
	{
		// The exact battle-test fixture: openclaw/imsg's real note, line 14 —
		// "Retire condition: unpin once an official release contains PR #185."
		const fixtureText = ["# openclaw/imsg", "", "Retire condition: unpin once an official release contains PR #185."].join("\n");
		const fakeFs = { readFileSync: () => fixtureText };
		const claims = extractClaims({ files: ["imsg.md"], fs: fakeFs });
		ok("exactly one claim extracted", claims.length === 1, JSON.stringify(claims));
		ok(
			"bare PR #185 resolves to a pull URL against the heading's owner/repo, kind pr, condition true",
			claims[0].url === "https://github.com/openclaw/imsg/pull/185" && claims[0].kind === "pr" && claims[0].condition === true,
			JSON.stringify(claims[0]),
		);
		ok("a resolved bare reference is never marked ambiguous", !claims[0].ambiguous, JSON.stringify(claims[0]));
	}
});

test("extractClaims: <owner>/<repo>#<n> form with no PR/issue word resolves ambiguously", async () => {
	{
		const fixtureText = "Retire this shim once org/widget#12 ships in a release.";
		const fakeFs = { readFileSync: () => fixtureText };
		const claims = extractClaims({ files: ["notes.md"], fs: fakeFs });
		ok("one claim extracted even with no heading in the file", claims.length === 1, JSON.stringify(claims));
		ok(
			"owner/repo#n resolves to a tentative pull URL, marked ambiguous",
			claims[0].url === "https://github.com/org/widget/pull/12" && claims[0].kind === "pr" && claims[0].ambiguous === true,
			JSON.stringify(claims[0]),
		);
	}
});

test("extractClaims: bare 'issue #<n>' resolves to kind issue, and a line with neither a number nor a URL is still unconfirmable-shaped", async () => {
	{
		const fixtureText = ["# org/widget", "Retire the workaround once issue #7 is resolved.", "Retire this workaround once it ships upstream."].join("\n");
		const fakeFs = { readFileSync: () => fixtureText };
		const claims = extractClaims({ files: ["notes.md"], fs: fakeFs });
		ok("both condition lines are extracted (2 of 3)", claims.length === 2, JSON.stringify(claims));
		const byLine = Object.fromEntries(claims.map((cl) => [cl.line, cl]));
		ok(
			"line 2: bare issue #7 resolves to kind issue against the note's own repo",
			byLine[2].kind === "issue" && byLine[2].url === "https://github.com/org/widget/issues/7",
			JSON.stringify(byLine[2]),
		);
		ok("line 3: no number and no URL — extracted (condition true) but unresolved", byLine[3].url === null && byLine[3].kind === "none", JSON.stringify(byLine[3]));
	}
});

test("recheckClaims: a merged PR computes `published` from the repo's own releases", async () => {
	{
		const claims = [{ file: "f.md", line: 14, text: "unpin once an official release contains PR #185", url: "https://github.com/o/r/pull/185", kind: "pr", condition: true }];

		const fakeExecPublished = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) };
			if (endpoint === "repos/o/r/pulls/185") return { stdout: JSON.stringify({ state: "closed", merged_at: "2026-07-19T14:03:51Z" }) };
			if (endpoint === "repos/o/r/releases?per_page=5") {
				return {
					stdout: JSON.stringify([
						{ tag_name: "v0.15.1", published_at: "2026-09-04T17:37:39Z", prerelease: false, draft: false },
						{ tag_name: "v0.14.2", published_at: "2026-08-28T18:40:28Z", prerelease: false, draft: false },
					]),
				};
			}
			throw new Error(`unexpected endpoint ${endpoint}`);
		};
		const result = await recheckClaims({ claims, exec: fakeExecPublished });
		ok("bucket is fired (a merged PR fires regardless of publish state)", result.fired.length === 1 && result.fired[0].line === 14, JSON.stringify(result.fired));
		ok("published is true when a release postdates the merge", result.fired[0].live.published === true, JSON.stringify(result.fired[0]));

		const fakeExecUnpublished = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) };
			if (endpoint === "repos/o/r/pulls/185") return { stdout: JSON.stringify({ state: "closed", merged_at: "2026-07-19T14:03:51Z" }) };
			if (endpoint === "repos/o/r/releases?per_page=5") {
				return { stdout: JSON.stringify([{ tag_name: "v0.13.0", published_at: "2026-06-01T00:00:00Z", prerelease: false, draft: false }]) };
			}
			throw new Error(`unexpected endpoint ${endpoint}`);
		};
		const resultUnpublished = await recheckClaims({ claims, exec: fakeExecUnpublished });
		ok("still fired even when nothing has published yet", resultUnpublished.fired.length === 1, JSON.stringify(resultUnpublished.fired));
		ok("published is false when every release predates the merge", resultUnpublished.fired[0].live.published === false, JSON.stringify(resultUnpublished.fired[0]));

		const fakeExecPrereleaseOnly = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) };
			if (endpoint === "repos/o/r/pulls/185") return { stdout: JSON.stringify({ state: "closed", merged_at: "2026-07-19T14:03:51Z" }) };
			if (endpoint === "repos/o/r/releases?per_page=5") {
				return { stdout: JSON.stringify([{ tag_name: "v0.15.0-rc1", published_at: "2026-08-29T00:00:00Z", prerelease: true, draft: false }]) };
			}
			throw new Error(`unexpected endpoint ${endpoint}`);
		};
		const resultPrerelease = await recheckClaims({ claims, exec: fakeExecPrereleaseOnly });
		ok("a prerelease that postdates the merge does not count as published", resultPrerelease.fired[0].live.published === false, JSON.stringify(resultPrerelease.fired[0]));

		// The releases lookup itself can fail (network, rate limit) — that
		// must soft-fail to published:false, never take the whole claim down
		// (a merged PR still fires; `published` is a best-effort add-on).
		const fakeExecReleasesThrow = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) };
			if (endpoint === "repos/o/r/pulls/185") return { stdout: JSON.stringify({ state: "closed", merged_at: "2026-07-19T14:03:51Z" }) };
			if (endpoint === "repos/o/r/releases?per_page=5") throw new Error("network error");
			throw new Error(`unexpected endpoint ${endpoint}`);
		};
		const resultReleasesThrow = await recheckClaims({ claims, exec: fakeExecReleasesThrow });
		ok("still fired even when the releases lookup itself throws", resultReleasesThrow.fired.length === 1, JSON.stringify(resultReleasesThrow.fired));
		ok("published soft-fails to false when the releases lookup throws, never crashes the claim", resultReleasesThrow.fired[0].live.published === false, JSON.stringify(resultReleasesThrow.fired[0]));
	}
});

test("recheckClaims: an ambiguous <owner>/<repo>#<n> falls back to an issue lookup on a 404", async () => {
	{
		const claims = [{ file: "f.md", line: 1, text: "retire once org/widget#12 ships", url: "https://github.com/org/widget/pull/12", kind: "pr", condition: true, ambiguous: true }];
		const fakeExec = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) };
			if (endpoint === "repos/org/widget/pulls/12") throw new Error("gh: Not Found (HTTP 404)");
			if (endpoint === "repos/org/widget/issues/12") return { stdout: JSON.stringify({ state: "closed" }) };
			throw new Error(`unexpected endpoint ${endpoint}`);
		};
		const result = await recheckClaims({ claims, exec: fakeExec });
		ok("the closed issue fires the condition claim", result.fired.length === 1 && result.fired[0].line === 1, JSON.stringify(result.fired));

		// A non-ambiguous PR claim must NOT get this fallback — its 404 is real.
		const nonAmbiguousClaims = [{ file: "f.md", line: 2, text: "x", url: "https://github.com/org/widget/pull/13", kind: "pr", condition: false }];
		const fakeExec2 = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) };
			if (endpoint === "repos/org/widget/pulls/13") throw new Error("gh: Not Found (HTTP 404)");
			throw new Error(`unexpected endpoint ${endpoint} (issue fallback must not fire for a non-ambiguous claim)`);
		};
		const result2 = await recheckClaims({ claims: nonAmbiguousClaims, exec: fakeExec2 });
		ok("a real PR 404 with no ambiguous flag lands in unconfirmable, no issue-endpoint retry", result2.unconfirmable.length === 1 && result2.unconfirmable[0].line === 2, JSON.stringify(result2));

		// Neither guess resolves (the number names nothing at all) — the
		// claim still lands in unconfirmable, reporting the ORIGINAL (pulls)
		// failure rather than the issue-fallback's own error.
		const bothFailClaims = [{ file: "f.md", line: 3, text: "retire once org/ghost#99 ships", url: "https://github.com/org/ghost/pull/99", kind: "pr", condition: true, ambiguous: true }];
		const fakeExecBothFail = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) };
			if (endpoint === "repos/org/ghost/pulls/99") throw new Error("gh: Not Found (HTTP 404)");
			if (endpoint === "repos/org/ghost/issues/99") throw new Error("gh: Not Found (HTTP 404)");
			throw new Error(`unexpected endpoint ${endpoint}`);
		};
		const result3 = await recheckClaims({ claims: bothFailClaims, exec: fakeExecBothFail });
		ok(
			"neither the PR nor the issue endpoint resolving lands the claim in unconfirmable, citing the original pulls endpoint",
			result3.unconfirmable.length === 1 && result3.unconfirmable[0].line === 3 && result3.unconfirmable[0].reason.includes("repos/org/ghost/pulls/99"),
			JSON.stringify(result3),
		);
	}
});

test("recheckClaims: fired / contradicted / unconfirmable(404) / unconfirmable(no-url) / current", async () => {
	{
		const claims = [
			{ file: "f.md", line: 1, text: "retire once https://github.com/o/r/pull/1 merges", url: "https://github.com/o/r/pull/1", kind: "pr", condition: true },
			{ file: "f.md", line: 2, text: "still open: https://github.com/o/r/pull/2", url: "https://github.com/o/r/pull/2", kind: "pr", condition: false },
			{ file: "f.md", line: 3, text: "opened as an upstream PR against o/r", url: null, kind: "none", condition: true },
			{
				file: "f.md",
				line: 4,
				text: "https://github.com/o/r/releases/tag/v9.9.9 lets us drop the pin once it ships",
				url: "https://github.com/o/r/releases/tag/v9.9.9",
				kind: "release",
				condition: true,
			},
			{ file: "f.md", line: 5, text: "https://github.com/o/r/issues/9 is open right now", url: "https://github.com/o/r/issues/9", kind: "issue", condition: false },
		];
		const fakeExec = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) };
			if (endpoint === "repos/o/r/pulls/1") return { stdout: JSON.stringify({ state: "closed", merged_at: "2026-01-01T00:00:00Z" }) };
			if (endpoint === "repos/o/r/pulls/2") return { stdout: JSON.stringify({ state: "closed", merged_at: "2026-01-01T00:00:00Z" }) };
			// Both merged PRs (lines 1 and 2) trigger a `published` lookup now —
			// no releases at all here, so both stay published: false.
			if (endpoint === "repos/o/r/releases?per_page=5") return { stdout: JSON.stringify([]) };
			if (endpoint === "repos/o/r/releases/tags/v9.9.9") throw new Error("gh: Not Found (HTTP 404)");
			if (endpoint === "repos/o/r/issues/9") return { stdout: JSON.stringify({ state: "open" }) };
			throw new Error(`unexpected endpoint ${endpoint}`);
		};
		const result = await recheckClaims({ claims, exec: fakeExec });
		ok("fired: condition claim whose PR merged", result.fired.length === 1 && result.fired[0].line === 1, JSON.stringify(result.fired));
		ok("published defaults false when the repo has no releases at all", result.fired[0].live.published === false, JSON.stringify(result.fired[0]));
		ok("contradicted: line says open, live state is merged", result.contradicted.length === 1 && result.contradicted[0].line === 2, JSON.stringify(result.contradicted));
		ok(
			"unconfirmable: no-url condition claim carries the §57 reason",
			result.unconfirmable.some((entry) => entry.line === 3 && entry.reason === "no checkable artifact"),
			JSON.stringify(result.unconfirmable),
		);
		ok(
			"unconfirmable: a 404'd release lookup lands here too",
			result.unconfirmable.some((entry) => entry.line === 4 && /failed/.test(entry.reason)),
			JSON.stringify(result.unconfirmable),
		);
		ok("current: an accurate, non-conditional claim needs no action", result.current.length === 1 && result.current[0].line === 5, JSON.stringify(result.current));
	}
});

test("recheckClaims: low rate limit stops the batch before any per-claim call", async () => {
	{
		const claims = [{ file: "f.md", line: 1, text: "x", url: "https://github.com/o/r/pull/1", kind: "pr", condition: false }];
		let calls = 0;
		const fakeExec = async (_cmd, args) => {
			calls += 1;
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: RATE_LIMIT_FLOOR - 1 } } }) };
			throw new Error(`should not have called ${endpoint}`);
		};
		const result = await recheckClaims({ claims, exec: fakeExec });
		ok("only the rate_limit probe ran, no per-claim gh api calls", calls === 1, `calls=${calls}`);
		ok("every url claim lands in unconfirmable with the rate-limit reason", result.unconfirmable.length === 1 && /rate limit/i.test(result.unconfirmable[0].reason), JSON.stringify(result));
	}
});

test("recheckClaims: no-url claims never reach the rate_limit probe at all", async () => {
	{
		let execCalled = false;
		const fakeExec = async () => {
			execCalled = true;
			throw new Error("should never be called");
		};
		const emptyResult = await recheckClaims({ claims: [], exec: fakeExec });
		ok("an empty claims array never calls exec", execCalled === false);
		ok("budget reports used:0 for an empty claims array", emptyResult.budget.used === 0 && emptyResult.budget.max > 0, JSON.stringify(emptyResult.budget));

		const noUrlClaims = [{ file: "f.md", line: 1, text: "opened as an upstream PR", url: null, kind: "none", condition: true }];
		const noUrlResult = await recheckClaims({ claims: noUrlClaims, exec: fakeExec });
		ok("a claims list with no URLs at all never calls exec either", execCalled === false);
		ok("the no-url condition claim still lands in unconfirmable with the §57 reason", noUrlResult.unconfirmable[0]?.reason === "no checkable artifact", JSON.stringify(noUrlResult));
	}
});

test("recheckClaims: the rate_limit probe itself throwing lands every claim in unconfirmable", async () => {
	{
		const claims = [{ file: "f.md", line: 1, text: "x", url: "https://github.com/o/r/pull/1", kind: "pr", condition: false }];
		const throwingRateLimitExec = async (_cmd, args) => {
			if (args[1] === "rate_limit") throw new Error("network unreachable");
			throw new Error("should not reach a per-claim call");
		};
		const result = await recheckClaims({ claims, exec: throwingRateLimitExec });
		ok(
			"a throwing rate_limit probe lands the claim in unconfirmable, naming the failure",
			result.unconfirmable.length === 1 && result.unconfirmable[0].reason.includes("could not check gh api rate limit"),
			JSON.stringify(result),
		);
	}
});

test("recheckOneClaim: a claim url that fails to parse lands in unconfirmable", async () => {
	{
		const claims = [{ file: "f.md", line: 1, text: "x", url: "https://example.com/not-a-github-url", kind: "pr", condition: false }];
		const fakeExec = async (_cmd, args) => {
			if (args[1] === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 5000 } } }) };
			throw new Error("should never call gh api for an unparseable url");
		};
		const result = await recheckClaims({ claims, exec: fakeExec });
		ok(
			"an unparseable claim url lands in unconfirmable with its own reason, no gh api call",
			result.unconfirmable.length === 1 && result.unconfirmable[0].reason === "could not parse artifact url",
			JSON.stringify(result),
		);
	}
});

test("recheckOneClaim: a contradicted assertion is checked BEFORE the fired short-circuit (BUCKETS: stale regardless of condition)", async () => {
	{
		const claims = [
			{ file: "f.md", line: 1, text: "Still open — will retire once this merges.", url: "https://github.com/o/r/pull/1", kind: "pr", condition: true },
		];
		const fakeExec = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) };
			if (endpoint === "repos/o/r/pulls/1") return { stdout: JSON.stringify({ state: "closed", merged_at: "2026-01-01T00:00:00Z" }) };
			if (endpoint === "repos/o/r/releases?per_page=5") return { stdout: JSON.stringify([]) };
			throw new Error(`unexpected endpoint ${endpoint}`);
		};
		const result = await recheckClaims({ claims, exec: fakeExec });
		ok(
			"a merged PR whose text asserts 'open' lands in contradicted, not fired",
			result.contradicted.length === 1 && result.contradicted[0].line === 1 && result.fired.length === 0,
			JSON.stringify(result),
		);
		ok("the contradicted entry still carries the true live.fired state", result.contradicted[0]?.live?.fired === true, JSON.stringify(result.contradicted[0]));

		// An existing fired fixture with no assertion word at all must still
		// land in `fired` — the reorder must not regress the plain fired path.
		const noAssertionClaims = [{ file: "f.md", line: 2, text: "unpin once this merges", url: "https://github.com/o/r/pull/2", kind: "pr", condition: true }];
		const fakeExec2 = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) };
			if (endpoint === "repos/o/r/pulls/2") return { stdout: JSON.stringify({ state: "closed", merged_at: "2026-01-01T00:00:00Z" }) };
			if (endpoint === "repos/o/r/releases?per_page=5") return { stdout: JSON.stringify([]) };
			throw new Error(`unexpected endpoint ${endpoint}`);
		};
		const result2 = await recheckClaims({ claims: noAssertionClaims, exec: fakeExec2 });
		ok("a fired claim with no assertion word still lands in fired", result2.fired.length === 1 && result2.fired[0].line === 2, JSON.stringify(result2));
	}
});

test("recheckClaims: bounded concurrency never exceeds RECHECK_CONCURRENCY in flight", async () => {
	{
		const claims = Array.from({ length: 10 }, (_, i) => ({
			file: "f.md",
			line: i + 1,
			text: "x",
			url: `https://github.com/o/r/pull/${i + 1}`,
			kind: "pr",
			condition: false,
		}));
		let inFlight = 0;
		let maxInFlight = 0;
		const fakeExec = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 5000 } } }) };
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 15));
			inFlight -= 1;
			return { stdout: JSON.stringify({ state: "open" }) };
		};
		await recheckClaims({ claims, exec: fakeExec });
		ok(`max in-flight (${maxInFlight}) never exceeds RECHECK_CONCURRENCY (${RECHECK_CONCURRENCY})`, maxInFlight <= RECHECK_CONCURRENCY, `maxInFlight=${maxInFlight}`);
		ok("concurrency was actually exercised (more than 1 in flight at once)", maxInFlight > 1, `maxInFlight=${maxInFlight}`);
	}
});

test("recheckClaims: MED-4 — a per-run call budget caps gh api calls, never silently unbounded", async () => {
	{
		const claims = Array.from({ length: 5 }, (_, i) => ({
			file: "f.md",
			line: i + 1,
			text: "x",
			url: `https://github.com/o/r/pull/${i + 1}`,
			kind: "pr",
			condition: false,
		}));
		let apiCalls = 0;
		const fakeExec = async (_cmd, args) => {
			const endpoint = args[1];
			if (endpoint === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { remaining: 5000 } } }) };
			apiCalls += 1;
			return { stdout: JSON.stringify({ state: "open" }) };
		};
		const result = await recheckClaims({ claims, exec: fakeExec, maxCalls: 2 });
		ok("only maxCalls claims are actually checked against gh", apiCalls === 2, `apiCalls=${apiCalls}`);
		ok("claims within budget land in a real bucket (current, here)", result.current.length === 2, JSON.stringify(result.current));
		ok(
			"claims past the budget land in unconfirmable with the exact reason, never dropped",
			result.unconfirmable.length === 3 && result.unconfirmable.every((c) => c.reason === "call budget exhausted"),
			JSON.stringify(result.unconfirmable),
		);
		ok("the result reports budget.used/budget.max", result.budget.used === 2 && result.budget.max === 2, JSON.stringify(result.budget));

		// A run within budget reports budget.used as the number actually
		// checked, with no over-budget claims.
		const smallResult = await recheckClaims({ claims: claims.slice(0, 1), exec: fakeExec, maxCalls: 200 });
		ok("a run within budget reports the real max, not the count checked", smallResult.budget.max === 200, JSON.stringify(smallResult.budget));
		ok("a run within budget reports used = claims actually checked", smallResult.budget.used === 1, JSON.stringify(smallResult.budget));
	}
});
