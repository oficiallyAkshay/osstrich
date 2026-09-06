/**
 * shared/osstrich-upstream.mjs — the osstrich `discover` pipeline's D3
 * "their side": for every project we ship, pull their open issues/PRs and
 * match them against what OUR repo already tells us we need
 * (`shared/osstrich-infer.mjs`'s inferred next steps).
 *
 * WHY THIS EXISTS
 * ----------------
 * Reading every open issue/PR on every dependency is not proportional past
 * the bottom-N candidates, and even for those it is a real GitHub API cost.
 * This module does bulk read calls against `gh issue list` / `gh pr list`,
 * using the same injectable-exec + 15s-timeout + soft-fail-to-gaps shape as
 * this repo's other `gh`-calling modules rather than inventing a new one.
 *
 * MATCHING, NOT SEARCHING
 * ------------------------
 * We never hit GitHub's search endpoint (discover.md's gate: "never use
 * search" — rate-limited far more aggressively than the REST list
 * endpoints). Instead: every inferred hit for a project already carries the
 * free-text `text` of the workaround/pin/gotcha that named it. We turn that
 * text into keywords (and any literal `#123` issue references it names) and
 * test those keywords against the TITLES of the project's own open
 * issues/PRs — a title-substring match, or a referenced issue number that
 * equals an open item's number. This is deliberately crude (no ranking, no
 * fuzzy match): a false positive costs a human two seconds of reading a row
 * in the verdict table; a false negative costs nothing extra, because D3
 * says the raw inferred list is read on its own regardless.
 *
 * BUDGET
 * ------
 * `gh api rate_limit` is checked once before EVERY batch of `concurrency`
 * repos (never per-repo — that would burn the budget it's meant to guard).
 * The very first successful reading is recorded as `budget.remainingAtStart`
 * so a caller can see what headroom existed for the whole run. The moment a
 * check reports `resources.core.remaining < minRemaining`, the phase stops
 * outright — no partial batch, no "try the cheap ones first" — and every
 * repo not yet fetched is named in one `gaps[]` entry. A `rate_limit` call
 * that itself fails (offline, `gh` not authenticated) is treated as "unknown
 * budget, proceed" rather than blocking the whole phase on a transient
 * network hiccup — `shared/audit-signal-pack.mjs`'s `isGhAvailable` takes the
 * same stance for its own probe.
 *
 * INJECTABLE SEAMS
 * -----------------
 * `exec` is the only I/O boundary (an `execFile`-shaped
 * `(cmd, args, opts) => Promise<{stdout}>`, matching every other `gh` caller
 * in this repo) — no default is given here because a caller with no working
 * `gh` should see that explicitly rather than this module silently reaching
 * for a real subprocess.
 *
 * `inferred` ACCEPTS EITHER SHAPE
 * --------------------------------
 * `shared/osstrich-infer.mjs`'s `inferNextSteps()` returns `{ byProject,
 * gaps }`, not a bare `{ [projectName]: hits[] }` map — a real CLI run
 * (2026-09-06, `2026-09-06-battle-attempt-1`) shipped the whole `{byProject,
 * gaps}` object straight through as `inferred`, so every per-project lookup
 * below silently missed (0 matches on 54 repos) even though 49 projects had
 * real inferred hits. Rather than trust every caller to unwrap it correctly,
 * this module accepts BOTH shapes itself: `inferred?.byProject ?? inferred`.
 * A caller passing the correct `{[name]: hits}` map (or `undefined`) sees no
 * change; a caller passing the whole inferred-phase object gets the right
 * per-project hits anyway.
 */

import { DEFAULT_SKIP_DIRS } from "./config.mjs";
import { classifySkipDirs, execGh, isSkippedDir, truncate, walkRepoFiles } from "./fs.mjs";

const GH_JSON_FIELDS = "number,title,updatedAt,comments,url";

/** `gh issue|pr list --limit` — nothing overrides this, so it stays a plain
 * constant rather than a per-call option. */
const PER_REPO_LIMIT = 200;

/** A match's recorded `text` (the inferred hit that produced it) is
 * trimmed to this many characters — long enough for a human to see WHY the
 * match fired, short enough to keep the verdict table readable. */
const MATCH_TEXT_MAX_CHARS = 120;

/** Trims a match's recorded `text` to `MATCH_TEXT_MAX_CHARS` — the shared
 * `truncate()` every hit/match "text" field in this package uses. */
function truncateMatchText(text) {
	return truncate(text, MATCH_TEXT_MAX_CHARS);
}

/** A short list of the connective words common enough in gotcha/TODO prose
 * to swamp a title-substring match with noise (see module doc, "matching,
 * not searching") — not an attempt at real stopword coverage. */
const STOPWORDS = new Set([
	"this",
	"that",
	"with",
	"from",
	"have",
	"been",
	"were",
	"which",
	"their",
	"about",
	"would",
	"could",
	"should",
	"there",
	"where",
	"when",
	"what",
	"into",
	"then",
	"than",
	"also",
	"just",
	"only",
	"over",
	"under",
	"after",
	"before",
	"while",
	"being",
	"doing",
	"does",
	"each",
	"some",
	"more",
	"most",
	"such",
	"very",
	"because",
	"between",
	"during",
	"other",
	"these",
	"those",
	"upon",
	// This skill's own vocabulary — words common enough in an INFERRED hit's
	// gotcha/TODO text (which describes OUR side of the workaround) to swamp
	// a title-substring match with noise, never a useful signal about the
	// upstream issue itself.
	"upstream",
	"patch",
	"pinned",
	"pin",
	"version",
	"versions",
	"release",
	"releases",
	"issue",
	"issues",
	"install",
	"installed",
	"update",
	"updated",
	"config",
	"file",
	"files",
	"lines",
	"line",
	"repo",
	"tool",
	"tools",
	"script",
	"scripts",
	"shared",
]);

/** A keyword must be long enough to carry real signal — short words are
 * either stopwords already or generic enough to false-positive against an
 * unrelated title. A bare `#123`-style issue reference (extracted
 * separately, see `extractKeywordsAndRefs`) is the only sub-5-char match
 * this module allows. */
const MIN_KEYWORD_LEN = 5;

/**
 * Pull the keywords and `#123`-style issue refs out of one inferred hit's
 * free text. Refs are extracted from the ORIGINAL text (their `#` would be
 * stripped by the word-split below), keywords from a lowercase split on
 * every non-word run. `stopwordSet` is the built-in `STOPWORDS` merged with
 * any caller-supplied repo-specific words (see `deriveRepoStopwords` below)
 * — every call site passes the fully-merged set, never the bare built-in
 * one, so a repo's own directory/package names never masquerade as a real
 * upstream-issue keyword.
 */
function extractKeywordsAndRefs(text, stopwordSet) {
	const raw = String(text || "");
	const refs = new Set();
	const refRe = /#(\d+)/g;
	let m = refRe.exec(raw);
	while (m) {
		refs.add(m[1]);
		m = refRe.exec(raw);
	}
	const keywords = new Set();
	for (const word of raw.toLowerCase().split(/[^a-z0-9]+/)) {
		if (word.length < MIN_KEYWORD_LEN) continue;
		if (stopwordSet.has(word)) continue;
		if (/^\d+$/.test(word)) continue; // a bare number is never a useful title keyword
		keywords.add(word);
	}
	return { keywords, refs };
}

/**
 * `deriveRepoStopwords({ repoRoot, fs, skipDirs })` — the repo-specific
 * words a caller should merge into the built-in `STOPWORDS` set via
 * `shortlistUpstream`'s own `stopwords` option: the repo root's own
 * directory name, every top-level directory name inside it, and every
 * `name` field found across the repo's own `package.json` manifests
 * (walked recursively, skipping `skipDirs`). None of this module's own
 * vocabulary is hardcoded here — a consumer repo's own internal project
 * names are exactly the words that would otherwise swamp a title-substring
 * match with false positives (a repo directory named the same as a common
 * English word, a workspace package sharing a name with itself), so this
 * helper exists purely so a caller can compute and pass its OWN set rather
 * than this module guessing at repo layout.
 */
export function deriveRepoStopwords({ repoRoot, fs, skipDirs = DEFAULT_SKIP_DIRS }) {
	const rootPath = repoRoot.replace(/\/+$/, "");
	const rootName = rootPath.slice(rootPath.lastIndexOf("/") + 1);
	const words = new Set();
	if (rootName) words.add(rootName.toLowerCase());

	const skipConfig = classifySkipDirs(skipDirs);
	let topEntries = [];
	try {
		topEntries = fs.readdirSync(repoRoot, { withFileTypes: true });
	} catch {
		topEntries = [];
	}
	for (const entry of topEntries) {
		if (entry.isDirectory() && !isSkippedDir(entry.name, entry.name, skipConfig)) words.add(entry.name.toLowerCase());
	}

	let manifestPaths = [];
	try {
		manifestPaths = walkRepoFiles({ repoRoot, fs, skipDirs }).filter((rel) => rel.endsWith("package.json"));
	} catch {
		manifestPaths = [];
	}
	for (const rel of manifestPaths) {
		try {
			const manifest = JSON.parse(fs.readFileSync(`${repoRoot}/${rel}`, "utf8"));
			if (typeof manifest.name === "string" && manifest.name) {
				const bare = manifest.name.includes("/") ? manifest.name.slice(manifest.name.lastIndexOf("/") + 1) : manifest.name;
				words.add(bare.toLowerCase());
			}
		} catch {
			// unreadable/unparseable manifest — not this helper's concern,
			// the inventory phase already reports it as a gap.
		}
	}

	return [...words];
}

/**
 * One `gh api rate_limit` reading, in "core" requests remaining. Soft-fail:
 * any error (offline, unauthenticated, unparseable output) reads as `null`
 * — "budget unknown," which callers here treat as "proceed" rather than
 * halting a whole phase on a probe that itself couldn't be trusted.
 */
async function checkRateLimit({ exec }) {
	try {
		const { stdout } = await execGh(exec, ["api", "rate_limit"]);
		const parsed = JSON.parse(stdout);
		const remaining = parsed?.resources?.core?.remaining;
		return typeof remaining === "number" ? remaining : null;
	} catch {
		return null;
	}
}

/** Normalize one `gh issue|pr list --json` row to the contract shape,
 * collapsing a comments ARRAY (issues/PRs both return one) to its count. */
function normalizeItem(raw) {
	return {
		number: raw.number,
		title: raw.title,
		updatedAt: raw.updatedAt,
		comments: Array.isArray(raw.comments) ? raw.comments.length : typeof raw.comments === "number" ? raw.comments : 0,
		url: raw.url,
	};
}

/** Run one `gh issue|pr list` call for `repo` and parse it into the
 * contract's item shape, sorted by number for deterministic output. A
 * rejected call or unparseable JSON both become one gap string and an empty
 * list — never a throw all the way out of `shortlistUpstream`. */
async function fetchList({ kind, repo, exec, gaps }) {
	try {
		const { stdout } = await execGh(exec, [kind, "list", "--repo", repo, "--state", "open", "--limit", String(PER_REPO_LIMIT), "--json", GH_JSON_FIELDS]);
		let raw;
		try {
			raw = JSON.parse(stdout);
		} catch (e) {
			gaps.push(`gh ${kind} list returned unparseable JSON for ${repo} (soft): ${e.message}`);
			return [];
		}
		return raw.map(normalizeItem).sort((a, b) => a.number - b.number);
	} catch (e) {
		gaps.push(`gh ${kind} list failed for ${repo} (soft): ${e.message || e}`);
		return [];
	}
}

/**
 * Every match between `repo`'s open issues/PRs and one project's inferred
 * hits. Iterates hits in their given order (deterministic — matches D3's
 * documented reading order) and dedupes on (item url, keyword) so a keyword
 * shared by several hits doesn't produce repeat rows. Each match carries the
 * `text` of the hit that produced it (trimmed to `MATCH_TEXT_MAX_CHARS`) so
 * a human reading the verdict table can see WHY it fired, not just that it
 * did.
 */
function matchAgainstHits({ hits, issues, prs, stopwordSet }) {
	const matches = [];
	const seen = new Set();
	const items = [...issues, ...prs];
	for (const hit of hits) {
		const { keywords, refs } = extractKeywordsAndRefs(hit?.text, stopwordSet);
		const text = truncateMatchText(hit?.text);
		for (const item of items) {
			const titleLower = String(item.title || "").toLowerCase();
			for (const keyword of keywords) {
				if (!titleLower.includes(keyword)) continue;
				const dedupeKey = `${item.url}|${keyword}`;
				if (seen.has(dedupeKey)) continue;
				seen.add(dedupeKey);
				matches.push({ item: item.url, signal: hit?.signal, keyword, text });
			}
			for (const ref of refs) {
				if (String(item.number) !== ref) continue;
				const dedupeKey = `${item.url}|#${ref}`;
				if (seen.has(dedupeKey)) continue;
				seen.add(dedupeKey);
				matches.push({ item: item.url, signal: hit?.signal, keyword: `#${ref}`, text });
			}
		}
	}
	return matches;
}

/**
 * @param {object} args
 * @param {Array<{name: string, repo?: string}>} args.projects — from
 *   `osstrich-inventory.mjs`'s output; only rows with a `repo` are fetched.
 * @param {Record<string, Array<{signal: string, text: string}>> | {byProject: Record<string, Array<{signal: string, text: string}>>}} args.inferred
 *   — `osstrich-infer.mjs`'s output. Accepts EITHER the raw `{[name]: hits}`
 *   map OR the whole `{byProject, gaps}` object that function actually
 *   returns (see module doc, "`inferred` accepts either shape") — a caller
 *   that forgot to unwrap `.byProject` still gets correct per-project hits.
 * @param {(cmd: string, args: string[], opts: object) => Promise<{stdout: string}>} args.exec
 * @param {number} [args.concurrency]
 * @param {number} [args.minRemaining]
 * @param {string[]} [args.stopwords] — extra repo-specific stopwords merged
 *   into the built-in `STOPWORDS` set for this run only (see
 *   `deriveRepoStopwords`, exported by this module, for how a caller
 *   computes them).
 * @returns {Promise<{byProject: object, budget: {checked: number, remainingAtStart: number|null, stopped: boolean}, gaps: string[]}>}
 */
export async function shortlistUpstream({ projects, inferred, exec, concurrency = 4, minRemaining = 200, stopwords = [] }) {
	const byProject = {};
	const gaps = [];
	let checked = 0;
	let remainingAtStart = null;
	let stopped = false;
	const stopwordSet = new Set([...STOPWORDS, ...stopwords.map((w) => String(w).toLowerCase())]);

	const inferredByProject = inferred?.byProject ?? inferred ?? {};
	const targets = (projects || []).filter((p) => p?.repo);
	for (let start = 0; start < targets.length && !stopped; start += concurrency) {
		const batch = targets.slice(start, start + concurrency);

		const remaining = await checkRateLimit({ exec });
		if (remainingAtStart === null && remaining !== null) remainingAtStart = remaining;
		if (remaining !== null && remaining < minRemaining) {
			stopped = true;
			const skipped = targets.slice(start).map((p) => p.repo);
			gaps.push(`rate limit budget exhausted (remaining ${remaining} < ${minRemaining}); skipped repos: ${skipped.join(", ")}`);
			break;
		}

		await Promise.all(
			batch.map(async (project) => {
				checked += 1;
				const repoGaps = [];
				const issues = await fetchList({ kind: "issue", repo: project.repo, exec, gaps: repoGaps });
				const prs = await fetchList({ kind: "pr", repo: project.repo, exec, gaps: repoGaps });
				gaps.push(...repoGaps);
				const hits = inferredByProject[project.name] || [];
				const matches = matchAgainstHits({ hits, issues, prs, stopwordSet });
				byProject[project.name] = { issues, prs, matches };
			}),
		);
	}

	return { byProject, budget: { checked, remainingAtStart, stopped }, gaps };
}
