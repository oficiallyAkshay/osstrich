/**
 * shared/osstrich-fs.mjs — small filesystem/text primitives shared by every
 * osstrich module: one repo-wide directory walk (skip-dir aware), a
 * bounded-concurrency map, a handful of string helpers (regex escaping,
 * truncation, line-number lookup, a pnpm patch-key strip), and the one
 * `gh` CLI exec wrapper every `gh`-calling module shares. No module-
 * specific knowledge lives here — every caller supplies its own skip list,
 * file predicate, and cap; this module only does the mechanical part every
 * one of them used to duplicate.
 */

import path from "node:path";
import { retryOnce } from "./retry.mjs";

const posixJoin = path.posix.join;

/** `gh` CLI timeout — a stuck host degrades to a soft gap within seconds
 * rather than wedging the whole run. */
const GH_TIMEOUT_MS = 15_000;

/** `gh api`/`gh issue|pr list` response cap — generous for any single call
 * this package makes, still a real bound. */
const GH_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** How long `execGh` waits before its one retry of a transient failure. */
const GH_RETRY_DELAY_MS = 500;

/** True for a transient `gh` failure worth one retry: a spawn-level error
 * with no captured exit at all (no `.code`/`.exitCode` — the process never
 * even ran, e.g. a network blip or ENOENT), or a non-zero exit whose stdout
 * came back empty (no response body ever arrived). False — never retried —
 * for a non-zero exit that DID return stdout, such as a `gh api` 404 body:
 * that's a real answer from the API, not a network hiccup. */
function isTransientGhFailure(error) {
	const hasCapturedExit = typeof error?.code === "number" || typeof error?.exitCode === "number";
	if (!hasCapturedExit) return true;
	return !error?.stdout || String(error.stdout).trim() === "";
}

/** This module's one `gh`-transient retry policy — the shared primitive
 * from lib/retry.mjs, retrying exactly once after `GH_RETRY_DELAY_MS`. */
const ghRetry = retryOnce({ backoffMs: GH_RETRY_DELAY_MS, shouldRetry: isTransientGhFailure });

/** `exec("gh", args, opts)` with this package's standard timeout/buffer —
 * the one options object `inventory.mjs`, `recheck.mjs`, and `upstream.mjs`
 * each used to hand-copy separately — retried once on a transient failure
 * (see `isTransientGhFailure`), never on a real (e.g. 404) response body.
 * `exec` stays a parameter (never closed over) so every caller keeps its
 * own injected exec seam for tests. */
export function execGh(exec, args) {
	return ghRetry(() => exec("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER_BYTES }));
}

/** Splits a `skipDirs`-shaped array into bare directory names (matched
 * against any directory's own name, at any depth) and relative-path
 * prefixes (matched against the full repo-relative path). An entry
 * containing "/" is a prefix; everything else is a bare name. */
export function classifySkipDirs(skipDirs) {
	const names = new Set();
	const prefixes = [];
	for (const entry of skipDirs || []) {
		if (typeof entry !== "string" || !entry) continue;
		if (entry.includes("/")) prefixes.push(entry.replace(/\/+$/, ""));
		else names.add(entry);
	}
	return { names, prefixes };
}

/** True when `rel` (or the directory named `entryName`) matches `skipConfig`
 * — a bare name at any depth, or a relative-path prefix. */
export function isSkippedDir(rel, entryName, skipConfig) {
	if (skipConfig.names.has(entryName)) return true;
	return skipConfig.prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));
}

/** Escapes a string for literal use inside a RegExp source. */
export function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Run `worker` over every item in `items`, at most `concurrency` in flight
 * at once, preserving input order. Returns the array of resolved worker
 * results — a caller that only wants the side effects ignores the return
 * value. */
export async function mapWithConcurrency(items, concurrency, worker) {
	const results = new Array(items.length);
	let nextIndex = 0;
	async function runOne() {
		while (nextIndex < items.length) {
			const i = nextIndex;
			nextIndex += 1;
			results[i] = await worker(items[i], i);
		}
	}
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => runOne());
	await Promise.all(workers);
	return results;
}

/** Trims `text` and caps it to `cap` characters — the shared "keep a
 * preview of this hit's text" shape every signal/finding carries. */
export function truncate(text, cap) {
	return String(text ?? "")
		.trim()
		.slice(0, cap);
}

/** 1-based line number of the first occurrence of `needle` in `text`, or
 * `null` if it isn't found — best-effort provenance, not a guarantee (e.g. a
 * key that appears only inside a value string). */
export function lineOf(text, needle) {
	const idx = text.indexOf(needle);
	if (idx === -1) return null;
	return text.slice(0, idx).split("\n").length;
}

/** Strips a pnpm-style `patchedDependencies` key's trailing `@version` —
 * `"lodash@4.17.21"` → `"lodash"`, `"@babel/core@7.10.0"` → `"@babel/core"`.
 * Only the LAST "@" counts as the version separator, so a scoped name's
 * leading "@" is never mistaken for one. */
export function stripPnpmPatchVersion(key) {
	const lastAt = key.lastIndexOf("@");
	return lastAt > 0 ? key.slice(0, lastAt) : key;
}

/**
 * Recursively lists every file under `repoRoot`, skipping any directory
 * `skipDirs` names (bare names or relative-path prefixes — see
 * `classifySkipDirs`/`isSkippedDir`). This walker's only job is finding paths.
 *
 * Two modes, chosen by whether `visit` is given:
 *   - no `visit`: returns an array of repo-relative (posix-joined) file
 *     paths, in filesystem directory-listing order — the "collect into
 *     array" shape `osstrich-inventory.mjs`'s readers filter and read
 *     themselves. Throws only when `repoRoot` itself can't be listed —
 *     callers decide whether that's a gap.
 *   - `visit(rel, abs)` given: called once per file instead of collecting
 *     anything; returns `true` once `repoRoot` itself could be listed,
 *     `false` when it couldn't (missing/unreadable) — the single-pass
 *     "visitor" shape `osstrich-infer.mjs`'s scanners use, which prefers a
 *     soft `false` to a thrown error.
 * Either way, an unreadable SUBdirectory degrades that branch to empty and
 * keeps going — every other file is still found.
 */
export function walkRepoFiles({ repoRoot, fs, skipDirs, visit }) {
	const skipConfig = classifySkipDirs(skipDirs);
	const results = visit ? null : [];

	function walk(absDir, relDir) {
		const entries = fs.readdirSync(absDir, { withFileTypes: true });
		for (const entry of entries) {
			const rel = relDir ? posixJoin(relDir, entry.name) : entry.name;
			const abs = path.join(absDir, entry.name);
			if (entry.isDirectory()) {
				if (isSkippedDir(rel, entry.name, skipConfig)) continue;
				try {
					walk(abs, rel);
				} catch {
					// an unreadable subdirectory degrades that branch to empty,
					// never the whole walk.
				}
			} else if (entry.isFile()) {
				if (visit) visit(rel, abs);
				else results.push(rel);
			}
		}
	}

	if (!visit) {
		walk(repoRoot, "");
		return results;
	}

	try {
		walk(repoRoot, "");
		return true;
	} catch {
		return false;
	}
}
