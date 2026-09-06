/**
 * shared/osstrich-inventory.mjs — osstrich's "inventory" phase: every
 * open-source project this repo runs, one row each, found BY SHAPE anywhere
 * in the repo (never by a hard-coded path), then enriched by two lookup
 * queues (the npm registry and GitHub). The shared JSON contract every
 * osstrich module reads/writes — `rank`, `infer`, and `upstream` all consume
 * this module's `projects[]` array as-is.
 *
 * SIX READERS, EACH INDEPENDENTLY TRY/CAUGHT, share ONE recursive directory
 * walk (honouring `options.skipDirs` and `options.maxFileBytes`) and then run
 * concurrently via `Promise.all`. A reader that can't find its expected shape
 * at all, or a single source file that fails to parse, writes one entry to
 * `gaps[]` and degrades that source to zero rows; it never throws out of
 * `collectInventory` and never silently drops what it could still read:
 *   1. npm dependencies    — every tracked package.json, resolved against
 *                            the nearest ancestor package-lock.json that
 *                            contains the entry — sibling first, then each
 *                            parent directory's own lock file up to
 *                            `repoRoot`
 *   2. Binary pins          — any `*.mjs|*.js|*.cjs|*.ts|*.sh` file outside
 *                            a test path (a `test/tests/__tests__/fixtures/
 *                            fixture/spec/__mocks__` directory at any depth,
 *                            or a `.test.`/`.spec.` filename) containing a
 *                            `github.com/<o>/<r>/releases/download/…` or
 *                            `/releases/tag/…` URL, anywhere
 *   3. Container images     — any `*compose*.yml|yaml` file, anywhere
 *   4. Vendored copies      — any file whose first 5 lines carry a
 *                            "Vendored from github.com/<o>/<r> @ <ref>
 *                            (<date>)" header
 *   5. Hand patches         — three shapes: a patch-package file under any
 *                            `patches/` directory, a pnpm `patchedDependencies`
 *                            entry in any package.json, or a numbered/
 *                            bulleted list under any markdown heading whose
 *                            text mentions "patch"
 *   6. CI actions           — `.github/workflows/**\/*.yml` `uses:` lines
 * Host installs are a SEVENTH, purely declarative source: `options.hostsFile`
 * (a pipe-table path, relative to `repoRoot`) is read as-is when given;
 * `null` (the default) means zero host rows and no gap — this repo simply
 * hasn't told the module where to look, which isn't a failure.
 *
 * SELF-EXCLUSION. Any row that IS osstrich itself — an npm row named
 * "osstrich", or any other row whose `repo` is `oficiallyAkshay/osstrich`
 * (a vendored copy, a binary pin, a hand patch, a CI action) — is dropped
 * before the dedupe/join below, by construction, so a consumer that installs
 * or vendors osstrich never inventories and ranks itself. One informational
 * `gaps[]` entry (`source: "self"`) records it when (and only when)
 * something was actually dropped; `status` is untouched either way.
 *
 * DEDUPE. A project can surface from more than one source at the same
 * `kind`+`name` (the same npm package declared in two trees; the same
 * container image tagged in two compose files; the same vendored upstream
 * copied into several local directories) — those collapse into ONE row,
 * sources concatenated. The first-seen `ours`/`repo` wins; a later
 * occurrence disagreeing on `ours` doesn't silently overwrite it — it logs
 * a `gaps[]` version-drift entry so the discrepancy surfaces rather than
 * getting lost. CI actions dedupe by `owner/repo` specifically, which is
 * why `name` for that kind IS `owner/repo` — the same kind+name dedupe
 * used everywhere else handles it for free.
 *
 * LOOKUPS, TWO QUEUES, BOTH BOUNDED BY `concurrency`:
 *   - Registry: every `kind: "npm"` row asks registry.npmjs.org for
 *     `dist-tags.latest` + the GitHub repo (from `repository.url`), and
 *     api.npmjs.org for last-week download counts. A hand-patch row that
 *     patches a known npm package (see reader 5) resolves its own `repo`
 *     through the same registry call, inline, since it already knows the
 *     package name it patches.
 *   - GitHub: every row (any kind) that HAS a `repo` asks `gh api
 *     repos/<repo>` for stars/pushed-date/archived/owner-type/open-issues;
 *     non-npm kinds also ask `repos/<repo>/releases/latest` for `latest`
 *     (npm's `latest` already comes from the registry). Gated on a
 *     `gh api rate_limit` pre-check — the whole queue is skipped (one
 *     `gaps[]` entry, not one per row) when core remaining < 200 or the
 *     check itself can't be verified.
 *
 * EVERYTHING INJECTABLE: `fs`, `exec`, `fetch`, `now` are always
 * caller-supplied parameters with real-implementation defaults — none of
 * them is touched at import time, so importing this module performs no
 * I/O. Every network call (registry fetch, `gh` exec) carries a 15s
 * timeout; a failure there degrades the field(s) it would have filled to
 * `null` plus a `gaps[]` entry, never a throw.
 *
 * OPTIONS. Every field is optional and carries a repo-agnostic default —
 * this module has no idea what repo it's running against until told:
 *   - `skipDirs` — bare directory names and relative-path prefixes excluded
 *     from the shared walk. Default: a small generic set (node_modules,
 *     .git, coverage, dist, build). A caller running this against a repo
 *     with its own extra directories to exclude (a nested checkout
 *     convention, say) passes the fuller list itself.
 *   - `hostsFile` — see reader 7 above. Default `null`.
 *   - `maxFileBytes` — files larger than this are skipped by every content
 *     scanner below (never read, so a huge generated blob can't stall the
 *     walk); default 262144 (256 KiB). Skipping one is soft-logged to
 *     `gaps[]`, never silent.
 *
 * DETERMINISM: `projects` is sorted by `name` before return, so two runs
 * over an unchanged repo and unchanged upstream state produce
 * byte-identical output — `rank`/`infer`/`upstream` depend on this to diff
 * cleanly across runs.
 */

import { execFile } from "node:child_process";
import nodeFs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_SKIP_DIRS } from "./config.mjs";
import { escapeRegExp, execGh, lineOf, mapWithConcurrency, stripPnpmPatchVersion, walkRepoFiles } from "./fs.mjs";
import { retryOnce } from "./retry.mjs";

const posixJoin = path.posix.join;

// `promisify` only wraps a function reference — no process is spawned by
// this line, so the module stays side-effect-free at import.
const defaultExec = promisify(execFile);

/** Every registry fetch in this module carries this timeout — a stalled
 * registry call degrades to a gaps[] entry within seconds rather than
 * wedging the whole discover phase. `gh` calls carry their own timeout via
 * `execGh` (`./fs.mjs`). */
const CALL_TIMEOUT_MS = 15_000;

/** Below this many remaining core-quota calls, the whole GitHub lookup
 * queue is skipped for the run rather than racing the budget row by row. */
const GH_RATE_LIMIT_FLOOR = 200;

/** How long `fetchJsonWithTimeout` waits before its one retry — see that
 * function's doc. */
const FETCH_RETRY_DELAY_MS = 500;

/** Default bounded concurrency for both lookup queues when the caller
 * doesn't pass one. */
const DEFAULT_CONCURRENCY = 6;

/** Files bigger than this are never read by a content scanner below. */
const DEFAULT_MAX_FILE_BYTES = 262_144;

/** 1-based line number of the character at `charIndex` in `text`. */
function lineAt(text, charIndex) {
	return text.slice(0, charIndex).split("\n").length;
}

/** A bare, source-agnostic project row with every enrichable field left
 * `null` — every reader below spreads this and overrides what it knows. */
function blankRow(overrides) {
	return {
		name: null,
		kind: null,
		ours: null,
		latest: null,
		repo: null,
		stars: null,
		weeklyDownloads: null,
		ownerType: null,
		archived: null,
		openIssues: null,
		sources: [],
		...overrides,
	};
}

// ── Shared directory walk ──────────────────────────────────────────────────
// classifySkipDirs / isSkippedDir / walkRepoFiles now live in
// shared/osstrich-fs.mjs (imported above) — this module only supplies its
// own `skipDirs` default and reads file content, never lists directories
// itself.

/** Reads `absPath` as utf8, capped at `maxFileBytes`. Returns
 * `{ text }` on success, `{ skipped: true }` when the file is over the
 * cap (never read, so a huge generated blob can't stall a scanner), or
 * `{ error }` on any read failure. Never throws. */
function readCapped(fs, absPath, maxFileBytes) {
	let text;
	try {
		text = fs.readFileSync(absPath, "utf8");
	} catch (e) {
		return { error: e };
	}
	if (text.length > maxFileBytes) return { skipped: true };
	return { text };
}

// ── Reader 1: npm dependencies ─────────────────────────────────────────────

/** Repo-relative directory of `rel`, normalized so the repo root itself is
 * `""` rather than `path.posix.dirname`'s `"."`. */
function dirOf(rel) {
	const d = path.posix.dirname(rel);
	return d === "." ? "" : d;
}

/** `dirRel` plus every parent directory up to (and including) the repo
 * root (`""`), nearest first — the search order for ancestor lock
 * resolution below. */
function ancestorDirs(dirRel) {
	const dirs = [];
	let cur = dirRel;
	for (;;) {
		dirs.push(cur);
		if (cur === "") break;
		cur = dirOf(cur);
	}
	return dirs;
}

/** Reads and JSON-parses the package-lock.json at repo-relative `lockRel`,
 * memoized in `lockCache` so a lock file sitting several manifests' common
 * ancestor is read from disk once no matter how many manifests walk past
 * it. `{ lock: null, corrupt: false }` on a missing file — that's the
 * ordinary "no lock here, keep walking ancestors" case, no gap. `{ lock:
 * null, corrupt: true }` on a file that EXISTS but fails to parse — a real
 * authoring mistake distinct from "not present," recorded as one `gaps[]`
 * entry (`source: "lockfile"`) the first time this lock is read (never
 * again — `lockCache`'s own memoization is what makes this "once per
 * file"); the caller uses `corrupt` to say "lockfile unreadable" instead of
 * "no lockfile entry" in its own per-dependency gap, so a session reading
 * that message goes straight to the broken file instead of assuming the
 * dependency was simply never locked. */
function loadLockCached({ fs, repoRoot, lockRel, lockCache, gaps }) {
	if (lockCache.has(lockRel)) return lockCache.get(lockRel);
	let text = null;
	try {
		text = fs.readFileSync(path.join(repoRoot, lockRel), "utf8");
	} catch {
		const result = { lock: null, corrupt: false };
		lockCache.set(lockRel, result);
		return result;
	}
	let lock = null;
	let corrupt = false;
	try {
		lock = JSON.parse(text);
	} catch (e) {
		corrupt = true;
		gaps.push({ source: "lockfile", file: lockRel, error: e.message });
	}
	const result = { lock, corrupt };
	lockCache.set(lockRel, result);
	return result;
}

/**
 * Direct `dependencies` + `devDependencies` from every tracked
 * package.json, resolved against `name`'s entry in the NEAREST ancestor
 * package-lock.json that actually contains it — the manifest's own sibling
 * lock first, then each parent directory's lock file up to `repoRoot`. Only
 * when no lock anywhere in that chain has the entry does this fall back to
 * the manifest's own range string as `ours` plus a `gaps[]` entry — never a
 * throw, never a dropped dependency.
 */
/** Resolve one dependency's `ours` version against the NEAREST ancestor
 * package-lock.json (in `searchDirs` order) that actually contains it,
 * falling back to the manifest's own range plus a `gaps[]` entry when
 * nothing in the chain has it — split out of `readNpmDependencies` so that
 * function is just "read every manifest, resolve each dependency." */
function resolveDependencyVersion({ repoRoot, fs, gaps, lockCache, searchDirs, manifestRel, name, range }) {
	const lockRelFor = (dir) => (dir ? posixJoin(dir, "package-lock.json") : "package-lock.json");
	let anyLockCorrupt = false;
	for (const dir of searchDirs) {
		const { lock, corrupt } = loadLockCached({ fs, repoRoot, lockRel: lockRelFor(dir), lockCache, gaps });
		if (corrupt) anyLockCorrupt = true;
		const entry = lock?.packages?.[`node_modules/${name}`];
		if (entry?.version) return entry.version;
	}
	const nearestLockRel = lockRelFor(searchDirs[0]);
	const reason = anyLockCorrupt ? "lockfile unreadable" : "no lockfile entry";
	gaps.push({
		source: "npm-manifest",
		file: manifestRel,
		error:
			searchDirs.length > 1
				? `${reason} for "${name}" in ${nearestLockRel} or any ancestor lock up to ${repoRoot}; falling back to manifest range "${range}"`
				: `${reason} for "${name}" in ${nearestLockRel}; falling back to manifest range "${range}"`,
	});
	return range;
}

function readNpmDependencies({ repoRoot, fs, gaps, allFiles, maxFileBytes }) {
	const rows = [];
	const manifestRelPaths = allFiles.filter((f) => f.endsWith("package.json")).sort();
	const lockCache = new Map();

	for (const manifestRel of manifestRelPaths) {
		const read = readCapped(fs, path.join(repoRoot, manifestRel), maxFileBytes);
		if (read.error) {
			gaps.push({ source: "npm-manifest", file: manifestRel, error: `could not read manifest: ${read.error.message}` });
			continue;
		}
		if (read.skipped) {
			gaps.push({ source: "npm-manifest", file: manifestRel, error: `skipped: exceeds maxFileBytes (${maxFileBytes})` });
			continue;
		}
		const manifestText = read.text;
		let manifest;
		try {
			manifest = JSON.parse(manifestText);
		} catch (e) {
			gaps.push({ source: "npm-manifest", file: manifestRel, error: `could not parse manifest JSON: ${e.message}` });
			continue;
		}

		const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
		if (Object.keys(deps).length === 0) continue;

		const searchDirs = ancestorDirs(dirOf(manifestRel));
		for (const [name, range] of Object.entries(deps)) {
			const ours = resolveDependencyVersion({ repoRoot, fs, gaps, lockCache, searchDirs, manifestRel, name, range });
			rows.push(blankRow({ name, kind: "npm", ours, sources: [{ file: manifestRel, line: lineOf(manifestText, `"${name}"`) }] }));
		}
	}
	return rows;
}

// ── Reader 2: binary pins ──────────────────────────────────────────────────

const BINARY_PIN_FILE_RE = /\.(?:mjs|js|cjs|ts|sh)$/i;
const RELEASE_URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/(?:download|tag)\/([^\s'"`)]+)/g;
const LITERAL_VERSION_RE = /^v?\d+[\w.-]*/;
const INTERPOLATED_CONST_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;

/** Bare directory names that mark a path as test-owned, at ANY depth — a
 * release URL living under one of these is a fixture proving detector
 * behavior, never a real dependency this repo runs. */
const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__", "fixtures", "fixture", "spec", "__mocks__"]);
/** A filename carrying `.test.` or `.spec.` anywhere is test-owned even
 * when it doesn't live under one of `TEST_DIR_NAMES` (a colocated
 * `foo.test.mjs` next to `foo.mjs`, say). */
const TEST_FILE_NAME_RE = /\.(?:test|spec)\./;

/** True when `rel` (a repo-relative path) is test-owned by directory name or
 * filename shape — used only by the binary-pin reader below; every other
 * detector still scans these paths as it always has. */
function isTestPath(rel) {
	const parts = rel.split("/");
	if (TEST_FILE_NAME_RE.test(parts[parts.length - 1])) return true;
	return parts.slice(0, -1).some((dir) => TEST_DIR_NAMES.has(dir));
}

/** Finds the nearest `NAME = "..."` (or `export const NAME = "..."`)
 * assignment to `constName` anywhere in `text`, "nearest" meaning smallest
 * line-distance to `nearLine`. `null` when the constant is never assigned. */
function nearestConstValue(text, constName, nearLine) {
	const re = new RegExp(`\\b${escapeRegExp(constName)}\\s*=\\s*["']([^"']+)["']`, "g");
	let best = null;
	let m = re.exec(text);
	while (m) {
		const line = lineAt(text, m.index);
		const distance = Math.abs(line - nearLine);
		if (!best || distance < best.distance) best = { value: m[1], distance };
		m = re.exec(text);
	}
	return best ? best.value : null;
}

/** Every `github.com/<owner>/<repo>/releases/download/…` or `/releases/
 * tag/…` occurrence anywhere in a `*.mjs|*.js|*.cjs|*.ts|*.sh` file — the
 * shape a binary-pin install script always carries, wherever it lives.
 * Name = the repo's own last path segment (never the constant's name, never
 * the containing file's own naming convention). Version is the literal
 * `v?\d+[\w.-]*` segment right after `download/`/`tag/`, or — when that
 * segment instead interpolates a JS constant (`${X_VERSION}`) — the value
 * of the nearest same-named assignment anywhere in the same file. */
function readBinaryPins({ repoRoot, fs, gaps, allFiles, maxFileBytes }) {
	const rows = [];
	const files = allFiles.filter((f) => BINARY_PIN_FILE_RE.test(f) && !isTestPath(f)).sort();
	for (const fileRel of files) {
		const read = readCapped(fs, path.join(repoRoot, fileRel), maxFileBytes);
		if (read.error) continue; // a source file this module can't read is not a binary-pin gap on its own
		if (read.skipped) {
			gaps.push({ source: "binary-pins", file: fileRel, error: `skipped: exceeds maxFileBytes (${maxFileBytes})` });
			continue;
		}
		const text = read.text;
		for (const m of text.matchAll(RELEASE_URL_RE)) {
			const [, owner, repoName, rest] = m;
			const line = lineAt(text, m.index);
			const verSeg = rest.split("/")[0];
			const literal = verSeg.match(LITERAL_VERSION_RE);
			let version = null;
			if (literal) {
				version = literal[0];
			} else {
				const interpolated = verSeg.match(INTERPOLATED_CONST_RE);
				if (interpolated) {
					version = nearestConstValue(text, interpolated[1], line);
					if (version == null) {
						gaps.push({ source: "binary-pins", file: fileRel, error: `no "${interpolated[1]}" constant found in ${fileRel} for its interpolated release URL` });
					}
				} else {
					gaps.push({ source: "binary-pins", file: fileRel, error: `could not determine a version for the release URL naming ${owner}/${repoName} in ${fileRel}` });
				}
			}
			rows.push(
				blankRow({
					name: repoName,
					kind: "binary",
					ours: version,
					repo: `${owner}/${repoName}`,
					sources: [{ file: fileRel, line }],
				}),
			);
		}
	}
	return rows;
}

// ── Reader 3: container images ──────────────────────────────────────────────

const COMPOSE_FILE_RE = /compose.*\.ya?ml$/i;
const IMAGE_LINE_RE = /^\s*-?\s*image:\s*(\S+)/;

/** Any `*compose*.yml|yaml` file, anywhere in the repo, `image:` lines.
 * `name` is the last path segment of the image reference
 * (`docker.io/redis:7.4.11` → "redis"); `ours` is the tag after the LAST
 * colon, but only when that colon comes after the last slash (so a
 * registry port like `host:5000/img` isn't mistaken for a tag separator).
 * No `repo` — a container registry reference isn't a GitHub repo, so this
 * kind never enters the GitHub lookup queue. */
function readContainerImages({ repoRoot, fs, gaps, allFiles, maxFileBytes }) {
	const rows = [];
	const files = allFiles.filter((f) => COMPOSE_FILE_RE.test(path.posix.basename(f))).sort();
	for (const fileRel of files) {
		const read = readCapped(fs, path.join(repoRoot, fileRel), maxFileBytes);
		if (read.error) {
			gaps.push({ source: "container-images", file: fileRel, error: `could not read: ${read.error.message}` });
			continue;
		}
		if (read.skipped) {
			gaps.push({ source: "container-images", file: fileRel, error: `skipped: exceeds maxFileBytes (${maxFileBytes})` });
			continue;
		}
		const lines = read.text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(IMAGE_LINE_RE);
			if (!m) continue;
			const ref = m[1];
			const lastColon = ref.lastIndexOf(":");
			const lastSlash = ref.lastIndexOf("/");
			const hasTag = lastColon > lastSlash;
			const imagePath = hasTag ? ref.slice(0, lastColon) : ref;
			const tag = hasTag ? ref.slice(lastColon + 1) : null;
			const name = imagePath.split("/").pop();
			rows.push(
				blankRow({
					name,
					kind: "image",
					ours: tag,
					sources: [{ file: fileRel, line: i + 1 }],
				}),
			);
		}
	}
	return rows;
}

// ── Reader 4: vendored copies ────────────────────────────────────────────────

const VENDORED_RE = /Vendored from github\.com\/([^/\s]+)\/([^\s@]+)\s*@\s*(\S+)\s*\(([^)]+)\)/;
const VENDORED_HEADER_LINES = 5;

/** Any file, anywhere, whose first 5 lines carry a "Vendored from
 * github.com/<owner>/<repo> @ <ref> (<date>)" header — no restriction on
 * where it lives or what it's named. `name` is the repo's own last path
 * segment, so two files vendored from the same upstream project (e.g. two
 * local entry points wrapping one vendored tool) collapse into one row via
 * the normal kind+name dedupe below, which is the correct count for "how
 * many upstream projects do we vendor," not "how many local files carry a
 * copy." Kind stays `"skill"` for downstream compatibility. */
function readVendoredCopies({ repoRoot, fs, gaps, allFiles, maxFileBytes }) {
	const rows = [];
	for (const fileRel of allFiles.sort()) {
		const read = readCapped(fs, path.join(repoRoot, fileRel), maxFileBytes);
		if (read.error) continue; // an unreadable file is simply not a vendored copy
		if (read.skipped) continue; // oversized files are skipped, silently — this is routine, not a gap
		const lines = read.text.split(/\r?\n/, VENDORED_HEADER_LINES);
		let matchedLine = -1;
		let match = null;
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(VENDORED_RE);
			if (m) {
				matchedLine = i;
				match = m;
				break;
			}
		}
		if (!match) continue;
		const owner = match[1];
		const repoName = match[2];
		const ref = match[3];
		const name = repoName.includes("/") ? repoName.slice(repoName.lastIndexOf("/") + 1) : repoName;
		rows.push(
			blankRow({
				name,
				kind: "skill",
				ours: ref,
				repo: `${owner}/${repoName}`,
				sources: [{ file: fileRel, line: matchedLine + 1 }],
			}),
		);
	}
	return rows;
}

// ── Reader 5: hand patches (three shapes) ────────────────────────────────────

const PATCH_PACKAGE_FILE_RE = /^(.+)\+([^+]+)\.patch$/;

/** Resolves `pkg`'s GitHub repo the same way an npm dependency row does —
 * a registry.npmjs.org lookup on the package name — since a hand-patch row
 * of this shape already knows exactly which npm package it patches. */
async function resolvePkgRepoViaRegistry({ pkg, fetch, gaps, source }) {
	const meta = await fetchJsonWithTimeout(fetch, `https://registry.npmjs.org/${encodeURIComponent(pkg)}`);
	if (!meta) {
		gaps.push({ source, file: pkg, error: `registry.npmjs.org lookup failed for "${pkg}"` });
		return null;
	}
	const repoField = meta.repository;
	const repoUrl = typeof repoField === "string" ? repoField : repoField?.url;
	const repo = parseGithubRepo(repoUrl);
	if (!repo) gaps.push({ source, file: pkg, error: `"${pkg}" has no GitHub repository field in its registry metadata` });
	return repo;
}

/** Shape (a): a file living directly under a `patches/` directory, named
 * `<pkg>+<version>.patch` (the patch-package convention; a scoped package's
 * "/" is itself replaced by "+", e.g. `@scope+name+1.2.3.patch`). */
async function readPatchPackageFiles({ allFiles, fetch, gaps, patchNumberByPkg }) {
	const rows = [];
	const files = allFiles
		.filter((f) => {
			const parts = f.split("/");
			const idx = parts.lastIndexOf("patches");
			return idx !== -1 && idx === parts.length - 2 && parts[parts.length - 1].endsWith(".patch");
		})
		.sort();
	for (const fileRel of files) {
		const base = path.posix.basename(fileRel);
		const m = base.match(PATCH_PACKAGE_FILE_RE);
		if (!m) continue;
		const rawPkg = base.slice(0, base.length - 6); // strip ".patch"
		const segments = rawPkg.split("+");
		segments.pop(); // version
		const pkg = segments.join("/");
		if (!pkg) continue;
		const n = (patchNumberByPkg.get(pkg) || 0) + 1;
		patchNumberByPkg.set(pkg, n);
		const repo = await resolvePkgRepoViaRegistry({ pkg, fetch, gaps, source: "hand-patches" });
		rows.push(
			blankRow({
				name: repo ? `${repo}#patch-${n}` : `${pkg}#patch-${n}`,
				kind: "patch",
				repo,
				label: base,
				sources: [{ file: fileRel, line: 1 }],
			}),
		);
	}
	return rows;
}

/** Shape (b): a pnpm-style `patchedDependencies` entry in any package.json. */
async function readPnpmPatchedDependencies({ repoRoot, fs, allFiles, maxFileBytes, fetch, gaps, patchNumberByPkg }) {
	const rows = [];
	const manifests = allFiles.filter((f) => f.endsWith("package.json")).sort();
	for (const manifestRel of manifests) {
		const read = readCapped(fs, path.join(repoRoot, manifestRel), maxFileBytes);
		if (read.error || read.skipped) continue; // already reported by the npm-dependencies reader
		let manifest;
		try {
			manifest = JSON.parse(read.text);
		} catch {
			continue; // already reported by the npm-dependencies reader
		}
		const entries = Object.keys(manifest.patchedDependencies || {}).sort();
		for (const key of entries) {
			const pkg = stripPnpmPatchVersion(key);
			const n = (patchNumberByPkg.get(pkg) || 0) + 1;
			patchNumberByPkg.set(pkg, n);
			const repo = await resolvePkgRepoViaRegistry({ pkg, fetch, gaps, source: "hand-patches" });
			rows.push(
				blankRow({
					name: repo ? `${repo}#patch-${n}` : `${pkg}#patch-${n}`,
					kind: "patch",
					repo,
					label: key,
					sources: [{ file: manifestRel, line: lineOf(read.text, `"${key}"`) }],
				}),
			);
		}
	}
	return rows;
}

const MD_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const MD_HEADING_PATCH_WORD_RE = /\bpatch(?:es)?\b/i;
const MD_LIST_ITEM_RE = /^\s*(?:\d+\.|[-*])\s+(.+)$/;

/** The first `github.com/<owner>/<repo>` or bare `<owner>/<repo>` token in
 * `text`, whichever appears earliest. The bare form deliberately excludes
 * any candidate immediately preceded or followed by another path
 * segment (a "/" or a "." right against it) — real prose is full of
 * multi-segment file paths (`extensions/slack/src/foo.ts`) that would
 * otherwise false-positive as a repo slug; a genuine `owner/repo` mention
 * stands alone. */
function firstOwnerRepoToken(text) {
	const s = String(text || "");
	const candidates = [];
	const ghMatch = /github\.com\/([\w.-]+)\/([\w-]+)/.exec(s);
	if (ghMatch) candidates.push({ index: ghMatch.index, repo: `${ghMatch[1]}/${ghMatch[2]}` });
	const bareRe = /(?<![\w./-])([\w-]+)\/([\w-]+)(?![\w./-])/;
	const bareMatch = bareRe.exec(s);
	if (bareMatch) candidates.push({ index: bareMatch.index, repo: `${bareMatch[1]}/${bareMatch[2]}` });
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => a.index - b.index);
	return candidates[0].repo;
}

/** Whole-token case-insensitive test for whether `name` appears in `text`. */
function nameAppearsIn(text, name) {
	const re = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`, "i");
	return re.test(text);
}

/** The earliest-mentioned candidate project's own `repo` (possibly `null`),
 * or `null` when no candidate's name appears in `text` at all. */
function firstProjectMentioned(text, candidateProjects) {
	let best = null;
	for (const p of candidateProjects) {
		if (!p.name) continue;
		const re = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(p.name)}(?![A-Za-z0-9_-])`, "i");
		const m = re.exec(text);
		if (m && (!best || m.index < best.index)) best = { index: m.index, project: p };
	}
	return best ? best.project : null;
}

/** Runs the same three matchers, in the same order, a single patch item's
 * own text is resolved by: a `github.com/<o>/<r>` URL, a bare `<o>/<r>`
 * token, then the first already-known project mentioned by name. `null`
 * when none of the three fire on this particular piece of text — the
 * caller chains this across successive fallback contexts. */
function resolveRepoFromText(text, candidateProjects) {
	if (!text) return null;
	return firstOwnerRepoToken(text) ?? firstProjectMentioned(text, candidateProjects)?.repo ?? null;
}

/** The file's first level-1 (`# `) heading text, or `null` when the file
 * has none — the last-resort fallback context for an item naming no
 * resolvable repo anywhere closer. */
function firstH1(lines) {
	for (const line of lines) {
		const m = line.match(MD_HEADING_RE);
		if (m && m[1] === "#") return m[2];
	}
	return null;
}

/** The last markdown paragraph in `preambleLines` (blank-line-separated
 * blocks, with `""` entries marking the separators) — the paragraph
 * NEAREST the list, which is the one a reader would actually take context
 * from, not an earlier paragraph the list has already moved past. `null`
 * when the preamble is entirely blank. */
function nearestParagraph(preambleLines) {
	const paragraphs = [];
	let current = [];
	for (const line of preambleLines) {
		if (line === "") {
			if (current.length > 0) paragraphs.push(current);
			current = [];
		} else {
			current.push(line);
		}
	}
	if (current.length > 0) paragraphs.push(current);
	if (paragraphs.length === 0) return null;
	return paragraphs[paragraphs.length - 1].join(" ");
}

/** Shape (c): any markdown file with a heading (any level) whose text
 * contains the whole word "patch" or "patches" (case-insensitive — a
 * whole-word match so a heading merely containing "dispatch" never
 * qualifies), followed by a numbered or bulleted list — any prose preamble
 * between the heading and the list is skipped, but once the list starts it
 * must run contiguously (blank lines tolerated) so a later, unrelated
 * bulleted aside further down the same section is never mistaken for one
 * more patch. Each item is one patch, numbered by its position within that
 * list (reset per heading). `repo` is the item's own first
 * `github.com/<o>/<r>` or bare `<o>/<r>` token, else the first
 * already-known project (by name) mentioned in the item's text. An item
 * resolving neither falls back to the NEAREST context, trying each in turn
 * with the same two matchers: the heading that introduces the list, then
 * the markdown paragraph nearest the list (between the heading and the
 * list), then the file's own first H1. Only when none of those resolve
 * anything either does `repo` stay `null` (plus a gap). `label` is the
 * item's own first line, trimmed to 120 characters. */
function readMarkdownPatchLists({ repoRoot, fs, gaps, allFiles, maxFileBytes, priorProjects }) {
	const rows = [];
	const files = allFiles.filter((f) => f.endsWith(".md")).sort();
	const candidateProjects = priorProjects.filter((p) => p.name);

	for (const fileRel of files) {
		const read = readCapped(fs, path.join(repoRoot, fileRel), maxFileBytes);
		if (read.error) continue;
		if (read.skipped) {
			gaps.push({ source: "hand-patches", file: fileRel, error: `skipped: exceeds maxFileBytes (${maxFileBytes})` });
			continue;
		}
		const lines = read.text.split("\n");
		const fileH1Text = firstH1(lines);
		for (let i = 0; i < lines.length; i++) {
			const heading = lines[i].match(MD_HEADING_RE);
			if (!heading || !MD_HEADING_PATCH_WORD_RE.test(heading[2])) continue;

			let end = lines.length;
			for (let j = i + 1; j < lines.length; j++) {
				if (MD_HEADING_RE.test(lines[j])) {
					end = j;
					break;
				}
			}

			// Any prose PREAMBLE between the heading and the list is skipped
			// while searching for the list's start (captured into
			// `preambleLines`, `""` marking each blank-line paragraph break, so
			// a repo-less item can fall back to the paragraph nearest the list
			// below); once the list has started, a run of list-item lines
			// (blank lines tolerated between them) continues until the first
			// non-blank, non-list line — which ends the list WITHOUT consuming
			// later, unrelated bulleted content that happens to sit later in
			// the same section (a follow-up instruction bullet is not itself
			// "one more patch").
			// Collect raw item records first (line + accumulated text) so a
			// wrapped item's CONTINUATION lines — indented to the item's own
			// content column, standard markdown for a multi-line list entry —
			// join the same item instead of prematurely ending the list or
			// starting a phantom new one.
			let n = 0;
			const items = [];
			const preambleLines = [];
			let started = false;
			let current = null;
			for (let j = i + 1; j < end; j++) {
				const line = lines[j];
				const item = line.match(MD_LIST_ITEM_RE);
				if (item) {
					started = true;
					current = { line: j + 1, parts: [item[1]] };
					items.push(current);
					continue;
				}
				if (line.trim() === "") {
					if (!started) preambleLines.push(""); // paragraph break, still in the preamble
					continue; // blank lines are tolerated, before or within the list
				}
				if (/^\s+\S/.test(line) && started) {
					current?.parts.push(line.trim()); // an indented continuation of the current item
					continue;
				}
				if (started) break; // an un-indented line ends the list — later content is not part of it
				preambleLines.push(line); // still searching for the list's start — preamble prose
			}

			// The fallback context chain for an item naming no repo of its
			// own — nearest first: the heading itself, then the paragraph
			// nearest the list, then the file's own first H1. Shared by every
			// item under this heading, computed once.
			const headingText = heading[2];
			const introText = nearestParagraph(preambleLines);

			for (const record of items) {
				n += 1;
				const itemText = record.parts.join(" ");
				const repo =
					resolveRepoFromText(itemText, candidateProjects) ??
					resolveRepoFromText(headingText, candidateProjects) ??
					resolveRepoFromText(introText, candidateProjects) ??
					resolveRepoFromText(fileH1Text, candidateProjects) ??
					null;
				if (!repo) gaps.push({ source: "hand-patches", file: fileRel, error: `patch ${n} in ${fileRel} names no recognizable upstream repo` });
				const label = itemText.trim().slice(0, 120);
				rows.push(
					blankRow({
						name: repo ? `${repo}#patch-${n}` : `patch-${n}`,
						kind: "patch",
						repo,
						label,
						sources: [{ file: fileRel, line: record.line }],
					}),
				);
			}
		}
	}
	return rows;
}

/** Runs all three hand-patch shapes and concatenates their rows. Shapes (a)
 * and (b) share one per-package numbering counter (they're the same kind of
 * thing — a patch applied to a named npm dependency); shape (c) numbers
 * positionally within its own list, independent of the other two. */
async function readHandPatches({ repoRoot, fs, gaps, allFiles, maxFileBytes, fetch, priorProjects }) {
	const patchNumberByPkg = new Map();
	const patchPackageRows = await readPatchPackageFiles({ allFiles, fetch, gaps, patchNumberByPkg });
	const pnpmRows = await readPnpmPatchedDependencies({ repoRoot, fs, allFiles, maxFileBytes, fetch, gaps, patchNumberByPkg });
	const markdownRows = readMarkdownPatchLists({ repoRoot, fs, gaps, allFiles, maxFileBytes, priorProjects });
	return [...patchPackageRows, ...pnpmRows, ...markdownRows];
}

// ── Reader 6: CI actions ────────────────────────────────────────────────────

const USES_LINE_RE = /uses:\s*([^\s@'"]+\/[^\s@'"]+)@([^\s#]+)(?:\s*#\s*(\S+))?/;
const WORKFLOWS_DIR_PREFIX = ".github/workflows/";

/** `.github/workflows/**\/*.yml` `uses: owner/repo@<sha>  # vX.Y.Z` lines,
 * deduped by `owner/repo` (hence `name === repo` for this kind). A
 * `uses:` line with no trailing version comment still becomes a row (with
 * `ours: null`) plus a `gaps[]` entry — the pin exists even if this scan
 * can't read a human version off it. */
function readCiActions({ repoRoot, fs, gaps, allFiles, maxFileBytes }) {
	const rows = [];
	const files = allFiles.filter((f) => f.startsWith(WORKFLOWS_DIR_PREFIX) && /\.ya?ml$/.test(f)).sort();

	const seen = new Map();
	for (const fileRel of files) {
		const read = readCapped(fs, path.join(repoRoot, fileRel), maxFileBytes);
		if (read.error) {
			gaps.push({ source: "ci-actions", file: fileRel, error: `could not read: ${read.error.message}` });
			continue;
		}
		if (read.skipped) {
			gaps.push({ source: "ci-actions", file: fileRel, error: `skipped: exceeds maxFileBytes (${maxFileBytes})` });
			continue;
		}
		const lines = read.text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(USES_LINE_RE);
			if (!m) continue;
			const [, repo, , version] = m;
			if (!version) {
				gaps.push({ source: "ci-actions", file: fileRel, error: `uses: ${repo} on line ${i + 1} has no trailing version comment` });
			}
			const existing = seen.get(repo);
			if (existing) {
				existing.sources.push({ file: fileRel, line: i + 1 });
			} else {
				const row = blankRow({ name: repo, kind: "action", ours: version || null, repo, sources: [{ file: fileRel, line: i + 1 }] });
				seen.set(repo, row);
				rows.push(row);
			}
		}
	}
	return rows;
}

// ── Reader 7: host installs ──────────────────────────────────────────────────

/** `options.hostsFile`'s pipe table: `| name | upstream repo | how installed
 * | where the version is read | notes |`. `hostsFile: null` (the default) is
 * zero rows and NO gap — this module simply hasn't been told where to look,
 * which isn't a failure. When a path IS given but unreadable, that's the
 * usual gap. `ours` stays `null`: the actual installed version lives on
 * whatever host runs it, not in anything this repo can read — the table
 * only documents WHERE to read it, live, on that host. */
function readHostInstalls({ repoRoot, fs, gaps, hostsFile }) {
	if (!hostsFile) return [];
	const rows = [];
	// Accepts either shape: a path relative to `repoRoot` (this module's own
	// documented contract) or an already-absolute path (what a config loader
	// resolving several optional reference files typically hands back,
	// consistently with how it resolves its other path-shaped keys).
	const absPath = path.isAbsolute(hostsFile) ? hostsFile : path.join(repoRoot, hostsFile);
	let text;
	try {
		text = fs.readFileSync(absPath, "utf8");
	} catch (e) {
		gaps.push({ source: "host-installs", file: hostsFile, error: `hostsFile missing or unreadable: ${e.message}` });
		return rows;
	}

	const lines = text.split("\n");
	let sawSeparator = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim().startsWith("|")) continue;
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		if (cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))) {
			sawSeparator = true;
			continue;
		}
		if (!sawSeparator) continue; // header row, before the separator
		if (cells.length < 4) continue;
		const [name, repo] = cells;
		if (!name) continue;
		rows.push(
			blankRow({
				name,
				kind: "host",
				repo: repo || null,
				sources: [{ file: hostsFile, line: i + 1 }],
			}),
		);
	}
	return rows;
}

// ── Self-exclusion ───────────────────────────────────────────────────────────

/** osstrich's own package name and repo — a consumer that installs osstrich
 * would otherwise find both an npm row named "osstrich" (from its own
 * manifest) and a "skill" row for `oficiallyAkshay/osstrich` (from the
 * vendored-copy header this file itself would carry once shipped), and rank
 * itself #1. See https://github.com/oficiallyAkshay/osstrich/issues/1. */
const SELF_NAME = "osstrich";
const SELF_REPO = "oficiallyAkshay/osstrich";

/** Drops any row that IS osstrich itself — by construction, before the
 * central dedupe/join below, rather than by filtering it back out of
 * `projects` afterward. A row counts as self when its `name` is "osstrich"
 * (an npm dependency row, before the registry lookup even fills in a repo)
 * or its `repo` is `oficiallyAkshay/osstrich` (a vendored/binary/patch/CI
 * row, whatever its own `name` happens to be — a patch row's name is
 * `owner/repo#patch-N`, a CI-action row's name IS its repo). Records ONE
 * informational `gaps[]` entry, `source: "self"`, naming every file a
 * dropped row was found in — but only when at least one row was actually
 * dropped; a repo that doesn't vendor or depend on osstrich gets no such
 * entry, and `status` is untouched either way since this is not an
 * incompleteness. */
function dropSelfRows(rows, gaps) {
	const kept = [];
	const droppedFiles = [];
	for (const row of rows) {
		if (row.name === SELF_NAME || row.repo === SELF_REPO) {
			for (const s of row.sources) droppedFiles.push(s.file);
			continue;
		}
		kept.push(row);
	}
	if (droppedFiles.length > 0) {
		gaps.push({ source: "self", file: [...new Set(droppedFiles)].sort().join(", "), error: "osstrich skipped its own package" });
	}
	return kept;
}

// ── Central dedupe ───────────────────────────────────────────────────────────

/** Collapse rows sharing a `kind`+`name` key into one, concatenating
 * `sources[]`. The first-seen `ours`/`repo` wins; a later row disagreeing
 * on `ours` logs a version-drift gap rather than silently overwriting —
 * see the module header's DEDUPE note. */
function dedupeProjects(allRows, gaps) {
	const byKey = new Map();
	for (const row of allRows) {
		const key = `${row.kind}:${row.name}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, { ...row, sources: [...row.sources] });
			continue;
		}
		existing.sources.push(...row.sources);
		if (row.ours != null && existing.ours != null && row.ours !== existing.ours) {
			gaps.push({
				source: row.kind,
				file: row.sources[0]?.file,
				error: `version drift for ${row.name}: "${existing.ours}" vs "${row.ours}" — kept the first-seen value`,
			});
		} else if (existing.ours == null && row.ours != null) {
			existing.ours = row.ours;
		}
		if (existing.repo == null && row.repo != null) existing.repo = row.repo;
	}
	return [...byKey.values()];
}

// ── Lookup queue 1: npm registry ────────────────────────────────────────────

/** Extract an `owner/repo` GitHub slug out of a package.json-style
 * `repository` field's URL, in whatever form npm's registry hands back
 * (`git+https://…`, `git://…`, a bare `owner/repo`, a `.git` suffix, a
 * `#path` suffix). `null` when the field doesn't point at github.com. */
function parseGithubRepo(url) {
	if (!url || typeof url !== "string") return null;
	const m = url.match(/github\.com[:/]([^/]+)\/([^/#]+?)(?:\.git)?(?:[/#].*)?$/);
	if (!m) return null;
	return `${m[1]}/${m[2]}`;
}

/** One `fetchImpl(url)` attempt with a hard `CALL_TIMEOUT_MS` abort.
 * Returns the parsed body on a 2xx response; otherwise throws a
 * `FetchFailure` tagged `.retryable` — true for a thrown network/timeout/
 * abort/parse error or a 5xx status, false for anything else (a 4xx),
 * which `fetchRetry`'s policy (below) deliberately never retries. */
class FetchFailure extends Error {
	constructor(retryable) {
		super("fetch failed");
		this.retryable = retryable;
	}
}

async function attemptFetchJson(fetchImpl, url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, { signal: controller.signal });
		if (!res.ok) throw new FetchFailure(res.status >= 500);
		return await res.json();
	} catch (error) {
		if (error instanceof FetchFailure) throw error;
		throw new FetchFailure(true);
	} finally {
		clearTimeout(timer);
	}
}

/** This module's one registry/GitHub-metadata retry policy — the shared
 * primitive from lib/retry.mjs, retrying exactly once after
 * `FETCH_RETRY_DELAY_MS`, only for a `FetchFailure` marked `.retryable`. */
const fetchRetry = retryOnce({ backoffMs: FETCH_RETRY_DELAY_MS, shouldRetry: (error) => error instanceof FetchFailure && error.retryable });

/** `fetchImpl(url)` with a hard `CALL_TIMEOUT_MS` abort and JSON parsing,
 * retried exactly ONCE, after `FETCH_RETRY_DELAY_MS`, when the first
 * attempt fails with a network/timeout/abort error or a 5xx status — a
 * transient failure worth one more try before this run's registry/GitHub
 * data goes missing for that project. A 4xx status (bad request, not
 * found, rate-limited) never retries — the request itself is wrong or
 * refused, and trying again half a second later wastes a call for no
 * better outcome. Returns `null` (never throws) when every attempt fails —
 * callers add the `gaps[]` entry, since only they know which field(s) the
 * failure should null out. */
async function fetchJsonWithTimeout(fetchImpl, url) {
	try {
		return await fetchRetry(() => attemptFetchJson(fetchImpl, url));
	} catch {
		return null;
	}
}

/** Enrich every `kind: "npm"` row in place with `latest`, `repo` (from the
 * registry's own `repository` field — a later GitHub-queue pass never
 * needs to guess it), and `weeklyDownloads`. Bounded by `concurrency`. */
async function runRegistryQueue({ projects, fetch, concurrency, gaps }) {
	const npmRows = projects.filter((p) => p.kind === "npm");
	await mapWithConcurrency(npmRows, concurrency, async (row) => {
		const meta = await fetchJsonWithTimeout(fetch, `https://registry.npmjs.org/${encodeURIComponent(row.name)}`);
		if (meta) {
			row.latest = meta["dist-tags"]?.latest ?? null;
			const repoField = meta.repository;
			const repoUrl = typeof repoField === "string" ? repoField : repoField?.url;
			row.repo = parseGithubRepo(repoUrl);
		} else {
			gaps.push({ source: "npm-registry", file: row.name, error: `registry.npmjs.org lookup failed for "${row.name}"` });
		}

		const downloads = await fetchJsonWithTimeout(fetch, `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(row.name)}`);
		if (downloads) {
			row.weeklyDownloads = downloads.downloads ?? null;
		} else {
			gaps.push({ source: "npm-downloads", file: row.name, error: `api.npmjs.org downloads lookup failed for "${row.name}"` });
		}
	});
}

// ── Lookup queue 2: GitHub ───────────────────────────────────────────────────

/** One `gh api rate_limit` reading. `{ remaining: null, error }` (never a
 * throw) when the call itself fails — `error` carries the real failure
 * text (no `gh`, not authenticated, timeout) so a caller's gap names the
 * actual reason rather than a generic "couldn't check." */
async function checkGithubRateLimit(exec) {
	try {
		const { stdout } = await execGh(exec, ["api", "rate_limit"]);
		return { remaining: JSON.parse(stdout || "{}")?.resources?.core?.remaining ?? null, error: null };
	} catch (e) {
		return { remaining: null, error: e.message };
	}
}

/** Enrich every row that carries a `repo` with stars/archived/owner-type/
 * open-issues, plus `latest` (via `releases/latest`) for every non-npm
 * kind. `gh api rate_limit` is checked before EVERY batch of `concurrency`
 * repos — never once for the whole queue, which would burn straight
 * through a budget that goes low partway through a long inventory (the
 * same per-batch shape `shared/osstrich-upstream.mjs`'s `shortlistUpstream`
 * already uses for its own GitHub budget, see that module's BUDGET
 * section). The moment a check reports fewer than `GH_RATE_LIMIT_FLOOR`
 * remaining core calls — or can't be read at all (no `gh`, not
 * authenticated, timeout): an unverifiable budget is treated as an
 * exhausted one, never as "assume it's fine" — every repo not yet fetched
 * (this batch and every later one) is named in ONE `gaps[]` entry and the
 * queue stops outright, no partial batch. */
async function runGithubQueue({ projects, exec, concurrency, gaps }) {
	const withRepo = projects.filter((p) => p.repo);
	if (withRepo.length === 0) return;

	for (let start = 0; start < withRepo.length; start += concurrency) {
		const batch = withRepo.slice(start, start + concurrency);
		const { remaining, error } = await checkGithubRateLimit(exec);
		if (error) {
			gaps.push({ source: "github-rate-limit", error: `gh api rate_limit failed (soft): ${error}` });
		}
		if (remaining == null || remaining < GH_RATE_LIMIT_FLOOR) {
			const skipped = withRepo.slice(start).map((p) => p.repo);
			gaps.push({
				source: "github-metadata",
				error: `GitHub lookup queue skipped: rate-limit budget ${remaining == null ? "unverifiable" : `${remaining} remaining`}, floor is ${GH_RATE_LIMIT_FLOOR}; skipped repos: ${skipped.join(", ")}`,
			});
			return;
		}

		await Promise.all(
			batch.map(async (row) => {
				try {
					const { stdout } = await execGh(exec, ["api", `repos/${row.repo}`]);
					const meta = JSON.parse(stdout || "{}");
					row.stars = meta.stargazers_count ?? null;
					row.archived = meta.archived ?? null;
					row.ownerType = meta.owner?.type ?? null;
					row.openIssues = meta.open_issues_count ?? null;
				} catch (e) {
					gaps.push({ source: "github-metadata", file: row.repo, error: `gh api repos/${row.repo} failed: ${e.message}` });
				}

				if (row.kind === "npm") return; // npm's `latest` already came from the registry

				try {
					const { stdout } = await execGh(exec, ["api", `repos/${row.repo}/releases/latest`]);
					const meta = JSON.parse(stdout || "{}");
					if (meta.tag_name) row.latest = meta.tag_name;
				} catch (e) {
					gaps.push({ source: "github-releases", file: row.repo, error: `gh api repos/${row.repo}/releases/latest failed: ${e.message}` });
				}
			}),
		);
	}
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.repoRoot — absolute repo root every reader below resolves paths against.
 * @param {object} [opts.fs] — injected node:fs-shaped module. Defaults to the real `node:fs`.
 * @param {Function} [opts.exec] — injected `(cmd, args, opts) => Promise<{stdout, stderr}>` runner (execFile-shaped). Defaults to `promisify(execFile)`.
 * @param {Function} [opts.fetch] — injected `fetch`-shaped function. Defaults to `globalThis.fetch`.
 * @param {() => number} [opts.now] — injected clock. Defaults to `Date.now`.
 * @param {number} [opts.concurrency] — bound on both lookup queues. Defaults to 6.
 * @param {string[]} [opts.skipDirs] — bare directory names / relative-path prefixes excluded from the shared walk. Defaults to a small generic set.
 * @param {string|null} [opts.hostsFile] — path to a host-installs pipe table, relative to `repoRoot` or already absolute (either is accepted). Defaults to `null` (zero host rows, no gap).
 * @param {number} [opts.maxFileBytes] — files larger than this are skipped by every content scanner. Defaults to 262144.
 * @returns {Promise<{status: "complete"|"incomplete", generatedAt: string, projects: object[], gaps: object[]}>}
 */
export async function collectInventory({
	repoRoot,
	fs = nodeFs,
	exec = defaultExec,
	fetch = globalThis.fetch,
	now = Date.now,
	concurrency = DEFAULT_CONCURRENCY,
	skipDirs = DEFAULT_SKIP_DIRS,
	hostsFile = null,
	maxFileBytes = DEFAULT_MAX_FILE_BYTES,
}) {
	const gaps = [];

	let allFiles;
	try {
		allFiles = walkRepoFiles({ repoRoot, fs, skipDirs });
	} catch (e) {
		gaps.push({ source: "repo-walk", error: `failed to walk ${repoRoot}: ${e.message}` });
		allFiles = [];
	}

	const [npmRows, binaryRows, imageRows, vendoredRows, ciRows, hostRows] = await Promise.all([
		Promise.resolve().then(() => readNpmDependencies({ repoRoot, fs, gaps, allFiles, maxFileBytes })),
		Promise.resolve().then(() => readBinaryPins({ repoRoot, fs, gaps, allFiles, maxFileBytes })),
		Promise.resolve().then(() => readContainerImages({ repoRoot, fs, gaps, allFiles, maxFileBytes })),
		Promise.resolve().then(() => readVendoredCopies({ repoRoot, fs, gaps, allFiles, maxFileBytes })),
		Promise.resolve().then(() => readCiActions({ repoRoot, fs, gaps, allFiles, maxFileBytes })),
		Promise.resolve().then(() => readHostInstalls({ repoRoot, fs, gaps, hostsFile })),
	]);

	// Hand patches run last among the readers: shape (c)'s repo-fallback
	// ("the first inventory project mentioned in the item text") needs the
	// other six readers' rows already in hand.
	const priorRows = [...npmRows, ...binaryRows, ...imageRows, ...vendoredRows, ...ciRows, ...hostRows];
	const handPatchRows = await readHandPatches({ repoRoot, fs, gaps, allFiles, maxFileBytes, fetch, priorProjects: priorRows });

	// Self-exclusion runs AFTER hand-patch resolution (which may legitimately
	// mention "osstrich" by name as CONTEXT for resolving some other patch's
	// repo) but BEFORE the join below — see dropSelfRows' own doc.
	const nonSelfRows = dropSelfRows([...priorRows, ...handPatchRows], gaps);
	const projects = dedupeProjects(nonSelfRows, gaps);

	await runRegistryQueue({ projects, fetch, concurrency, gaps });
	await runGithubQueue({ projects, exec, concurrency, gaps });

	projects.sort((a, b) => a.name.localeCompare(b.name));

	return {
		status: gaps.length === 0 ? "complete" : "incomplete",
		generatedAt: new Date(now()).toISOString(),
		projects,
		gaps,
	};
}
