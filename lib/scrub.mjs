/**
 * shared/osstrich-scrub.mjs — osstrich's outbound-leak scan, before any
 * draft (PR body, commit message, forked patch) leaves this repo.
 *
 * WHY THIS EXISTS
 * ----------------
 * `.claude/skills/osstrich/references/pr-etiquette.md`'s Scrubbing section
 * requires every draft to be checked, every time, for our internal
 * agent/product names, host identities, and personal contact info — not
 * "kept out by intention alone". This module is the deterministic half of
 * that check: it never judges what's a leak on its own. `gitleaks` (already
 * vendored — `scripts/postinstall.mjs`'s GITLEAKS_VERSION pin) is the whole
 * detection engine; the only code here is (a) turning
 * `references/scrub-terms.txt` into a gitleaks rule config, and (b) running
 * gitleaks against a piece of text or a set of paths and parsing its JSON
 * report back into a small, stable shape the caller can act on.
 *
 * TERM FILE FORMAT (see `references/scrub-terms.txt`'s own header)
 * -------------------------------------------------------------------
 * One term per non-blank, non-comment (`#`) line. `re:<pattern>` is a raw
 * regex, used as-is; anything else is a literal, matched case-insensitively
 * (escaped so regex metacharacters in the literal — the email address's
 * `.` and `@` — don't get reinterpreted).
 *
 * FAILURE SHAPE — SOFT, ALWAYS
 * -----------------------------
 * A missing gitleaks binary, a timeout, or any other exec failure never
 * throws into the caller — it comes back as `{ ok: false, error }`, the
 * same soft-fail contract as `shared/audit-signal-pack.mjs`'s `gh` calls.
 * `--exit-code 0` is passed on every gitleaks invocation specifically so a
 * FOUND leak (gitleaks' normal exit 1) never gets misread as an exec
 * failure — the JSON report, not the exit code, is what decides `ok`.
 */

import { execFile as nodeExecFile } from "node:child_process";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/** Default async exec — an execFile-shaped `(cmd, args, opts) =>
 * Promise<{stdout, stderr}>` function, injectable so tests never spawn the
 * real gitleaks binary unless they explicitly opt in (see the runner's one
 * existsSync-guarded real-binary test). */
const defaultExecFileAsync = promisify(nodeExecFile);

/** A stalled gitleaks process (a huge tree, a wedged filesystem) must not
 * hang whatever's waiting on the scrub result — 60s is generous for a
 * single-text or single-path scan and short enough that a genuinely stuck
 * run degrades to a soft failure within a minute, not indefinitely. */
const SCRUB_TIMEOUT_MS = 60_000;

/** gitleaks' own JSON report for a scrub-sized input is small; capped well
 * above anything this module legitimately produces, same reasoning as
 * `shared/audit-signal-pack.mjs`'s GH_MAX_BUFFER_BYTES. */
const SCRUB_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Where the vendored binary lives relative to the repo root — see `scripts/postinstall.mjs`'s GITLEAKS_VERSION pin. */
function resolveGitleaksBin(repoRoot = process.cwd()) {
	return path.join(repoRoot, "node_modules", ".bin", "gitleaks");
}

/**
 * Turn a term-file line into `{ raw, kind: "literal" | "regex", pattern }`.
 * `pattern` is the ALREADY USABLE regex body for a "regex" line (the text
 * after `re:`, unmodified — the author owns its correctness and any case
 * flag); for a "literal" line it's the raw literal text, escaping happens
 * later in `buildGitleaksConfig` once we know it's going into a TOML
 * literal string.
 */
function parseTermLine(rawLine) {
	const line = rawLine.trim();
	if (!line || line.startsWith("#")) return null;
	if (line.startsWith("re:")) {
		const pattern = line.slice(3).trim();
		if (!pattern) return null;
		return { raw: line, kind: "regex", pattern };
	}
	return { raw: line, kind: "literal", pattern: line };
}

/** Parse the whole term-file text into an ordered list of parsed terms, comments and blank lines dropped. */
function parseTerms(termsText) {
	return String(termsText || "")
		.split("\n")
		.map(parseTermLine)
		.filter(Boolean);
}

/** Escape a literal string for use inside a RE2 (gitleaks/Go) regex body —
 * every character `.^$*+?()[]{}|\` gets a backslash. Applied only to
 * "literal" terms; a "regex" term's pattern passes through untouched
 * because the author already wrote it as a regex. */
function escapeRegexLiteral(literal) {
	return literal.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

/** Reject a term whose text can't be safely embedded in a `'''...'''`
 * TOML literal string — anything containing a run of 3+ single quotes. */
function hasTomlLiteralBreakout(text) {
	return /'''/.test(text);
}

/** Escapes `\` and `"` for a TOML basic (`"..."`) string — used for the `id`/`description` fields, not the `'''`-wrapped `regex` value. */
function escapeTomlBasicString(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** A gitleaks rule `id`, positional only (`term-<n>`, 1-based) — never the term's own text, since a finding's `rule` field is printed straight to stdout/logs. */
function slugifyTermId(_term, index) {
	return `term-${index + 1}`;
}

/**
 * Build the gitleaks TOML config: one `[[rules]]` block per parsed term. A
 * literal term's regex is its escaped text wrapped in a case-insensitive
 * `(?i)` group (scrub-terms.txt's literals are matched case-insensitively
 * by contract); a `re:` term's regex is its pattern verbatim.
 *
 * @param {string} termsText raw contents of scrub-terms.txt
 * @returns {string} a complete gitleaks config.toml body
 */
function buildGitleaksConfig(termsText) {
	const terms = parseTerms(termsText);
	const lines = ['title = "osstrich-scrub"', ""];
	terms.forEach((term, index) => {
		if (hasTomlLiteralBreakout(term.pattern) || hasTomlLiteralBreakout(term.raw)) {
			throw new Error(`scrub term breaks TOML literal-string encoding (contains '''): ${term.raw}`);
		}
		const id = slugifyTermId(term, index);
		const regexBody = term.kind === "regex" ? term.pattern : `(?i)${escapeRegexLiteral(term.pattern)}`;
		lines.push("[[rules]]");
		lines.push(`id = "${id}"`);
		lines.push(`description = "term: ${escapeTomlBasicString(term.raw)}"`);
		lines.push(`regex = '''${regexBody}'''`);
		lines.push("");
	});
	return lines.join("\n");
}

/** Mask a matched leak so a finding never carries the actual sensitive text
 * into stdout/logs — only enough to recognize which value matched. A match
 * under 6 characters can't be split into a distinct first-2/last-2 without
 * the halves overlapping (or reconstructing most of a short secret), so it
 * is fully masked instead. */
function maskMatch(value) {
	const text = String(value ?? "");
	if (text.length < 6) return "•••";
	return `${text.slice(0, 2)}…${text.slice(-2)}`;
}

/** Map one raw gitleaks JSON-report entry into this module's stable
 * `{ rule, file, line, snippet }` shape — callers depend on these four
 * fields only, never gitleaks' own report schema directly. `file` defaults
 * to gitleaks' own `File` field, but a caller scanning a directory or
 * synthetic single-file source overrides it via `resolveFile` (see
 * `runGitleaksOnSource`, `scrubText`, `scrubPaths`) — gitleaks' raw `File`
 * value is only trustworthy for a directory scan, where it's already
 * relative to that directory root. `snippet` is always the MASKED matched
 * text (see `maskMatch`) — the whole point of scrubbing is to keep the
 * actual leaked value out of anything that captures this finding (a
 * terminal transcript, a CI log), so it never appears verbatim. */
function toFinding(entry, resolveFile) {
	return {
		rule: entry?.RuleID ?? "unknown",
		file: typeof resolveFile === "function" ? resolveFile(entry) : (entry?.File ?? null),
		line: typeof entry?.StartLine === "number" ? entry.StartLine : null,
		snippet: maskMatch(entry?.Match ?? entry?.Secret ?? ""),
	};
}

/**
 * Run gitleaks once against a single file/directory `source`, using a
 * config generated from `termsText`, and return the parsed findings.
 * Every failure — binary missing, timeout, bad exit, unparsable report —
 * is caught and returned as `{ ok: false, error }`; this function never
 * throws.
 */
async function runGitleaksOnSource({ source, termsText, exec = defaultExecFileAsync, fs = nodeFs, tmpDir, repoRoot = process.cwd(), resolveFile }) {
	const workDir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), "osstrich-scrub-"));
	const configPath = path.join(workDir, "gitleaks-config.toml");
	const reportPath = path.join(workDir, "gitleaks-report.json");
	try {
		fs.writeFileSync(configPath, buildGitleaksConfig(termsText));
	} catch (e) {
		return { ok: false, error: `could not write scrub config: ${e.message}` };
	}

	const gitleaksBin = resolveGitleaksBin(repoRoot);
	try {
		await exec(
			gitleaksBin,
			[
				"detect",
				"--no-git",
				"--source",
				source,
				"--config",
				configPath,
				"--report-format",
				"json",
				"--report-path",
				reportPath,
				"--exit-code",
				"0",
				"--no-banner",
			],
			{ encoding: "utf8", timeout: SCRUB_TIMEOUT_MS, maxBuffer: SCRUB_MAX_BUFFER_BYTES },
		);
	} catch (e) {
		return { ok: false, error: `gitleaks exec failed: ${e.message}` };
	}

	let raw;
	try {
		raw = fs.readFileSync(reportPath, "utf8");
	} catch (e) {
		return { ok: false, error: `could not read gitleaks report: ${e.message}` };
	}

	let parsed;
	try {
		// gitleaks writes `[]` for a clean scan and an array of finding
		// objects otherwise — never anything else in JSON mode.
		parsed = raw.trim() ? JSON.parse(raw) : [];
	} catch (e) {
		return { ok: false, error: `could not parse gitleaks report: ${e.message}` };
	}

	const findings = (Array.isArray(parsed) ? parsed : []).map((entry) => toFinding(entry, resolveFile));
	return { ok: findings.length === 0, findings };
}

/**
 * Scrub a single in-memory string (a PR body draft, a commit message) for
 * every term in `termsText`. Writes `text` to a temp file and delegates to
 * gitleaks — see module doc for the failure contract.
 *
 * @param {object} args
 * @param {string} args.text
 * @param {string} args.termsText
 * @param {Function} [args.exec] injected execFile-shaped runner
 * @param {object} [args.fs] injected `node:fs`-shaped module
 * @param {string} [args.tmpDir] reuse an existing dir instead of making one
 * @param {string} [args.repoRoot] repo root the gitleaks binary lives under
 * @returns {Promise<{ok: boolean, findings?: Array, error?: string}>}
 */
export async function scrubText({ text, termsText, exec = defaultExecFileAsync, fs = nodeFs, tmpDir, repoRoot = process.cwd() }) {
	const workDir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), "osstrich-scrub-"));
	const sourcePath = path.join(workDir, "scrub-input.txt");
	try {
		fs.writeFileSync(sourcePath, text ?? "");
	} catch (e) {
		return { ok: false, error: `could not write scrub input: ${e.message}` };
	}
	// `sourcePath` is a synthetic tmp file holding the caller's in-memory
	// text — it names nothing in the caller's own filesystem, so every
	// finding's `file` is forced to null rather than leaking that tmp path.
	return runGitleaksOnSource({ source: sourcePath, termsText, exec, fs, tmpDir: workDir, repoRoot, resolveFile: () => null });
}

/**
 * Scrub each of `paths` (a file or directory) for every term in
 * `termsText`, merging findings across all of them. Runs gitleaks once per
 * path (never batched into one call — gitleaks' `--source` takes exactly
 * one root) and stops at the first exec/parse failure, returning whatever
 * findings were already collected alongside the error.
 *
 * @param {object} args
 * @param {string[]} args.paths
 * @param {string} args.termsText
 * @param {Function} [args.exec]
 * @param {object} [args.fs]
 * @param {string} [args.repoRoot]
 * @returns {Promise<{ok: boolean, findings: Array, error?: string}>}
 */
export async function scrubPaths({ paths, termsText, exec = defaultExecFileAsync, fs = nodeFs, repoRoot = process.cwd() }) {
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "osstrich-scrub-"));
	const findings = [];
	for (const source of paths || []) {
		let isDirectory = false;
		try {
			isDirectory = fs.statSync(source).isDirectory();
		} catch {
			isDirectory = false;
		}
		// gitleaks reports `File` relative to `--source`: for a directory scan
		// that relative path IS the caller-meaningful path, so pass it through
		// as-is. For a single-file scan, gitleaks' own `File` value isn't
		// reliably the caller's own path (it may be the source path verbatim,
		// or just its basename, depending on version) — map back to `source`
		// directly instead, the exact path the caller gave us for this scan.
		const resolveFile = isDirectory ? (entry) => (typeof entry?.File === "string" ? entry.File : null) : () => source;
		const result = await runGitleaksOnSource({ source, termsText, exec, fs, tmpDir: workDir, repoRoot, resolveFile });
		if (result.error) {
			return { ok: false, findings, error: `${source}: ${result.error}` };
		}
		findings.push(...result.findings);
	}
	return { ok: findings.length === 0, findings };
}
