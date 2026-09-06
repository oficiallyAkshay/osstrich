/**
 * shared/osstrich-infer.mjs — the osstrich skill's "our next steps ×
 * inferred" phase. Answers, for every project in the inventory, "where does
 * THIS repo already carry a workaround, a pin, a patch, or a note that names
 * it" — without anyone having filed a ticket for it. That's the corpus the
 * upstream phase (`shared/osstrich-upstream.mjs`) cross-references against
 * each project's live issues/PRs.
 *
 * SIX SIGNALS, IN THIS ORDER, each independently guarded so one bad file
 * never drops the rest:
 *   (a) patch-file      — an entry under any `patches/` directory, or a
 *                          `patchedDependencies` key in a manifest.
 *   (b) override         — an `overrides` / `resolutions` key in a
 *                          package.json.
 *   (c) exact-pin         — a package.json dependency pinned to an exact
 *                          version (no `^`/`~` range).
 *   (d) code-note         — a TODO/FIXME/HACK/workaround/upstream/quirk
 *                          comment in source that also names the project.
 *   (e) doc-note          — a markdown line that names the project alongside
 *                          one of this skill's watch-words (workaround, pin,
 *                          patch, upstream, quirk, hang, race, silently,
 *                          retire, unpin, or a `#1234`-shaped issue
 *                          reference). Doc notes come from every `*.md` file
 *                          in the repo outside `skipDirs` and outside
 *                          `options.ignore` (the consumer's own path
 *                          prefixes for notes ABOUT upstream that shouldn't
 *                          feed this signal back on itself) — no file gets a
 *                          bigger allowance than any other: a per-(project,
 *                          file) cap of 5 hits applies to every doc file
 *                          alike, so one large rolled log can't crowd out
 *                          every other source.
 *   (f) hand-patch        — `osstrich-inventory.mjs`'s `kind: "patch"` rows
 *                          are never matched as a NAME — a patch row is
 *                          named `<repo>#patch-<n>`, which is never a
 *                          project's own name — but every patch row whose
 *                          `repo` equals a project's `repo` becomes one
 *                          `hand-patch` hit under that project, carrying the
 *                          patch's own `label` as its text and its own
 *                          `sources[0]` (file/line) as provenance — never a
 *                          hardcoded path.
 *
 * MATCHING. A project is "named" on a line only as a WHOLE token — the
 * characters immediately before and after the match must not themselves be
 * alnum/underscore/hyphen, so "os" never fires inside "cross" and "express"
 * never fires inside "expression". A scoped npm name (`@scope/name`) is
 * matched as that one complete string, never split on the `/`. The bare
 * repo name (the half after the `/` in an `owner/repo` string) is also a
 * valid match — a project shipped as `acme/widget-cli` also fires on its
 * bare name `widget-cli` on its own.
 *
 * INJECTED `fs` ONLY, no defaults — `fs` is always the caller's instance
 * (real `node:fs` in production, a fake in tests), never touched at import
 * time, so this module has no side effects merely by being imported.
 *
 * OPTIONS. `skipDirs` (relative path prefixes and bare directory names
 * excluded from every walk below — defaults to a small generic set) and
 * `ignore` (relative path prefixes excluded from doc-note scanning only —
 * defaults to none) are both caller-supplied; neither carries any
 * repo-specific default here. A consumer with its own generated reference
 * output that shouldn't feed its own doc-note signal passes those paths in
 * `ignore`.
 */

import { DEFAULT_SKIP_DIRS } from "./config.mjs";
import { escapeRegExp, lineOf as sharedLineOf, stripPnpmPatchVersion, truncate as sharedTruncate, walkRepoFiles } from "./fs.mjs";

const HITS_PER_PROJECT_CAP = 50;
const TEXT_MAX_CHARS = 200;

/** Every doc-note hit is additionally capped per (project, file) — no single
 * markdown file, however large or however often rolled, gets a bigger
 * allowance than any other. */
const DOC_NOTE_PER_FILE_CAP = 5;

const CODE_NOTE_WORD_RE = /\b(?:TODO|FIXME|HACK|workaround|upstream|quirk)\b/i;
const CODE_FILE_RE = /\.(?:mjs|js|ts|sh|yml)$/i;
const DOC_NOTE_WORD_RE = /\b(?:workaround|pin|patch|upstream|quirk|hang|race|silently|retire|unpin)\b|#\d{2,6}/i;
const DOC_FILE_RE = /\.md$/i;

function isIgnoredPath(rel, ignorePrefixes) {
	for (const p of ignorePrefixes || []) {
		const clean = String(p).replace(/\/+$/, "");
		if (rel === clean || rel.startsWith(`${clean}/`)) return true;
	}
	return false;
}

/**
 * Builds the whole-token, case-insensitive matcher for one candidate name.
 * The lookaround boundary excludes `[A-Za-z0-9_-]` on both sides of the
 * match — "/", "@", "." and "+" are all valid boundaries (so a scoped
 * name's internal "/" survives untouched, and a patch-package filename's
 * "+"-joined form still matches), while a hyphen right against the match
 * is treated as PART of a longer token, so "pad" never fires inside
 * "left-pad" and "left-pad" never fires inside "left-pad-cli".
 */
function buildTokenMatcher(name) {
	const escaped = escapeRegExp(name);
	return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "i");
}

/** One project's set of names a line can be matched against: its inventory
 * `name` plus, when `repo` is an `owner/repo` string, the bare repo name. */
function candidateNames(project) {
	const names = new Set();
	if (project.name) names.add(project.name);
	if (project.repo?.includes("/")) {
		const bare = project.repo.slice(project.repo.lastIndexOf("/") + 1);
		if (bare) names.add(bare);
	}
	return [...names];
}

function truncate(text) {
	return sharedTruncate(text, TEXT_MAX_CHARS);
}

/** 1-based line number of `needle` in `text`, defaulting to 1 (never
 * `null`) when it isn't found — every call site here already knows the
 * needle SHOULD be present (it was just read out of this same manifest's
 * own parsed JSON), so "not found" is a formatting edge case, not a real
 * gap, and this keeps the pre-shared-helper default line callers relied on. */
function lineOf(text, needle) {
	return sharedLineOf(text, needle) ?? 1;
}

function readLines(fs, absPath) {
	try {
		return fs.readFileSync(absPath, "utf8").split(/\r?\n/);
	} catch {
		return null;
	}
}

/**
 * `inferNextSteps({ repoRoot, fs, projects, skipDirs, ignore })` →
 * `{ byProject, gaps }`.
 *
 * `projects` is the array of inventory rows (or anything with `.name` /
 * `.repo`) to search for. Every hit is pushed in discovery order per
 * signal and then the whole per-project list is sorted by `(file, line)`
 * before it is capped and returned, so output is deterministic regardless
 * of the host filesystem's own directory-entry ordering.
 *
 * `skipDirs` — bare directory names and relative-path prefixes excluded
 * from every walk (default: a small generic set — node_modules, .git,
 * coverage, dist, build). `ignore` — relative-path prefixes excluded from
 * doc-note scanning only (default: none).
 */
export function inferNextSteps({ repoRoot, fs, projects, skipDirs = DEFAULT_SKIP_DIRS, ignore = [] }) {
	const byProject = {};
	const gaps = [];

	// A hand-patch row (`kind: "patch"`) is never a NAME to match against —
	// it's named `<repo>#patch-<n>`, which is never a real project's own
	// name — so it's excluded from `matchers` entirely and handled
	// separately below, by `repo` equality, once every other signal has run.
	const matchableProjects = projects.filter((project) => project.kind !== "patch");
	const patchRows = projects.filter((project) => project.kind === "patch");
	const matchers = matchableProjects.map((project) => ({
		project,
		matchers: candidateNames(project).map((name) => ({ name, re: buildTokenMatcher(name) })),
	}));

	const docNotePerFileHitCounts = {};

	function pushHit(projectName, hit) {
		const arr = byProject[projectName] || (byProject[projectName] = []);
		if (arr.length >= HITS_PER_PROJECT_CAP) return;
		if (hit.signal === "doc-note") {
			const key = `${projectName}::${hit.file}`;
			const count = docNotePerFileHitCounts[key] || 0;
			if (count >= DOC_NOTE_PER_FILE_CAP) return;
			docNotePerFileHitCounts[key] = count + 1;
		}
		arr.push(hit);
	}

	function matchingProjects(text) {
		const hits = [];
		for (const { project, matchers: nameMatchers } of matchers) {
			if (nameMatchers.some(({ re }) => re.test(text))) hits.push(project);
		}
		return hits;
	}

	// (a) + (b) + (c): every package.json / manifest in the tree.
	const manifestFound = scanManifestSignals({ repoRoot, fs, skipDirs, matchingProjects, pushHit, gaps });
	if (!manifestFound) gaps.push({ source: repoRoot, reason: "repo root not found — manifest walk produced zero results" });

	// (d) + (e): line-scan every source / doc file for a project name plus
	// this signal's watch-words. A doc file additionally honors `ignore` —
	// the consumer's own generated notes ABOUT upstream are not a NEED it
	// should infer from itself.
	scanCodeAndDocNotes({ repoRoot, fs, skipDirs, ignore, matchingProjects, pushHit, gaps });

	// (f): every hand-patch row against the project sharing its repo.
	applyHandPatchHits({ patchRows, matchableProjects, pushHit });

	for (const name of Object.keys(byProject)) {
		byProject[name].sort((a, b) => (a.file !== b.file ? a.file.localeCompare(b.file) : a.line - b.line));
	}

	return { byProject, gaps };
}

/** A package.json dependency value is an exact pin only when the WHOLE
 * value is `N.N.N` — anchored at both ends, unlike a bare `^\d+\.\d+\.\d+`
 * prefix check, which would also match a semver range that merely STARTS
 * with a version (a hyphen range `"1.2.3 - 2.0.0"`, an OR range
 * `"1.2.3 || 2.0.0"`) and wrongly infer "we depend on this precisely" from
 * a range that names no exact version at all. */
const EXACT_PIN_RE = /^\d+\.\d+\.\d+$/;

/** (a) + (b) + (c): walks every package.json / manifest in the tree, firing
 * patch-file / override / exact-pin hits. Returns `true` once `repoRoot`
 * itself could be listed (`walkRepoFiles`'s own contract) — `false` becomes
 * `inferNextSteps`'s "repo root not found" gap. */
function scanManifestSignals({ repoRoot, fs, skipDirs, matchingProjects, pushHit, gaps }) {
	return walkRepoFiles({
		repoRoot,
		fs,
		skipDirs,
		visit: (rel, abs) => {
			if (!rel.endsWith("package.json")) {
				// (a, filename form): a file living directly under a `patches/` dir.
				const parts = rel.split("/");
				const idx = parts.lastIndexOf("patches");
				if (idx !== -1 && idx === parts.length - 2) {
					for (const project of matchingProjects(rel)) {
						pushHit(project.name, { signal: "patch-file", file: rel, line: 1, text: truncate(parts[parts.length - 1]) });
					}
				}
				return;
			}

			const lines = readLines(fs, abs);
			if (lines === null) {
				gaps.push({ source: rel, reason: "failed to read manifest" });
				return;
			}

			const manifestText = lines.join("\n");
			let manifest;
			try {
				manifest = JSON.parse(manifestText);
			} catch (e) {
				gaps.push({ source: rel, reason: `failed to parse manifest JSON: ${e?.message || e}` });
				return;
			}

			// (a, structured form): pnpm-style `patchedDependencies`.
			for (const key of Object.keys(manifest.patchedDependencies || {})) {
				const bareName = stripPnpmPatchVersion(key);
				for (const project of matchingProjects(bareName)) {
					const ln = lineOf(manifestText, `"${key}"`);
					pushHit(project.name, { signal: "patch-file", file: rel, line: ln, text: truncate(lines[ln - 1] || key) });
				}
			}

			// (b): `overrides` / `resolutions`.
			for (const section of [manifest.overrides, manifest.resolutions]) {
				for (const key of Object.keys(section || {})) {
					for (const project of matchingProjects(key)) {
						const ln = lineOf(manifestText, `"${key}"`);
						pushHit(project.name, { signal: "override", file: rel, line: ln, text: truncate(lines[ln - 1] || key) });
					}
				}
			}

			// (c): an exact-pinned `dependencies` / `devDependencies` entry —
			// see EXACT_PIN_RE's own doc for what "exact" excludes.
			for (const section of [manifest.dependencies, manifest.devDependencies]) {
				for (const [key, value] of Object.entries(section || {})) {
					if (typeof value !== "string" || !EXACT_PIN_RE.test(value)) continue;
					for (const project of matchingProjects(key)) {
						const ln = lineOf(manifestText, `"${key}"`);
						pushHit(project.name, { signal: "exact-pin", file: rel, line: ln, text: truncate(lines[ln - 1] || `${key}: ${value}`) });
					}
				}
			}
		},
	});
}

/** (d) + (e): line-scans every source/doc file for a project name plus that
 * signal's watch-words — a single shared walk, branching per file type. */
function scanCodeAndDocNotes({ repoRoot, fs, skipDirs, ignore, matchingProjects, pushHit, gaps }) {
	walkRepoFiles({
		repoRoot,
		fs,
		skipDirs,
		visit: (rel, abs) => {
			const isCode = CODE_FILE_RE.test(rel);
			const isDoc = DOC_FILE_RE.test(rel) && !isIgnoredPath(rel, ignore);
			if (!isCode && !isDoc) return;

			const lines = readLines(fs, abs);
			if (lines === null) {
				gaps.push({ source: rel, reason: "failed to read file" });
				return;
			}

			const wordRe = isCode ? CODE_NOTE_WORD_RE : DOC_NOTE_WORD_RE;
			const signal = isCode ? "code-note" : "doc-note";
			lines.forEach((line, i) => {
				if (!wordRe.test(line)) return;
				for (const project of matchingProjects(line)) {
					pushHit(project.name, { signal, file: rel, line: i + 1, text: truncate(line) });
				}
			});
		},
	});
}

/** (f): one `hand-patch` hit per patch row, filed under every project whose
 * `repo` equals that patch's `repo` — never under the patch row's own name.
 * A patch row with no `repo` at all (a patch that doesn't name a known
 * bundled dependency) matches nothing, on purpose: matching on
 * `repo === null` would wrongly attach it to every repo-less project. File/
 * line provenance comes from the patch row's own `sources[0]` — never a
 * hardcoded reference path — so a row with no recorded source produces no
 * hit rather than a fabricated location. */
function applyHandPatchHits({ patchRows, matchableProjects, pushHit }) {
	for (const patchRow of patchRows) {
		if (!patchRow.repo) continue;
		const source = patchRow.sources?.[0];
		if (!source?.file) continue;
		const text = truncate(String(patchRow.label ?? patchRow.name ?? ""));
		for (const project of matchableProjects) {
			if (project.repo !== patchRow.repo) continue;
			pushHit(project.name, { signal: "hand-patch", file: source.file, line: typeof source.line === "number" ? source.line : 1, text });
		}
	}
}
