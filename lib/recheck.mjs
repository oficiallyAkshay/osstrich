/**
 * shared/osstrich-recheck.mjs — re-verify every "retire once X ships" claim
 * against live GitHub state.
 *
 * WHY THIS EXISTS
 * ----------------
 * §57: a doc note phrased "retire / unpin / obsolete once upstream X ships
 * or merges" is a claim with an expiration nobody is watching — it can fire
 * (or already be false) silently. That rule was written after a fork's own
 * gotchas file asserted three patches were "each also opened as an upstream
 * PR," and a direct check found that false for at least one of them.
 * `references/self-learning.md`'s "Keep the tracking claims honest" section
 * makes re-checking these claims part of every osstrich run, not a someday
 * cleanup.
 *
 * This module is the deterministic half of that check: `extractClaims`
 * finds every line in a set of files that names a GitHub PR/issue/release
 * URL or reads like a conditional retire-claim, and `recheckClaims` asks
 * `gh api` what actually happened, bucketing each claim into what to do
 * with it next. It never judges prose beyond the fixed patterns below —
 * the caller (an agent session, the osstrich CLI) decides what a
 * "contradicted" or "unconfirmable" claim means for the doc it came from.
 *
 * BUCKETS
 * --------
 *  fired         — a `condition: true` claim whose artifact already
 *                   merged/closed/published. The claim's action can happen
 *                   now.
 *  contradicted   — the line asserts "open"/"merged"/"opened" and the live
 *                   state disagrees. The line is stale regardless of
 *                   `condition`.
 *  unconfirmable  — no URL to check at all (§57's own failure mode: a
 *                   condition claim written without a checkable artifact),
 *                   or the `gh api` call itself failed (404, network,
 *                   rate-limited).
 *  current        — everything else: the claim still accurately describes
 *                   live state, nothing to do.
 *
 * RATE LIMIT
 * -----------
 * `gh api rate_limit` is checked once per `recheckClaims` call, before any
 * per-claim fetch — a run over many doc files could carry dozens of URLs,
 * and burning the last of a shared token's core quota on a re-check pass
 * would starve whatever else in this pipeline needs `gh` next. Falling
 * below RATE_LIMIT_FLOOR stops the whole batch (every URL claim goes to
 * `unconfirmable`) rather than racing the remaining quota against
 * concurrency.
 */

import { execFile as nodeExecFile } from "node:child_process";
import nodeFs from "node:fs";
import { promisify } from "node:util";
import { execGh, mapWithConcurrency } from "./fs.mjs";

/** Default async exec — same execFile-shaped, injectable contract as
 * `shared/audit-signal-pack.mjs` and `shared/osstrich-scrub.mjs`. */
const defaultExecFileAsync = promisify(nodeExecFile);

/** At most this many `gh api` calls in flight at once — enough to overlap
 * network latency across a doc's worth of URLs without opening as many
 * connections as there are claims (GitHub's abuse-rate limiting cares
 * about burst concurrency, not just calls per run). */
export const RECHECK_CONCURRENCY = 4;

/** Below this many remaining core-quota calls, stop the batch rather than
 * spend the last of a shared token's budget on a re-check pass — chosen
 * well above RECHECK_CONCURRENCY so a false read (a slightly stale
 * `rate_limit` response) can't immediately exhaust the floor mid-batch. */
export const RATE_LIMIT_FLOOR = 100;

/** A per-RUN ceiling on how many claims one `recheckClaims` call will ever
 * fire a `gh api` call for — independent of (and checked before) the
 * rate-limit floor above. Without this, a file that legitimately (or was
 * crafted to) reference thousands of GitHub URLs could burn nearly an
 * entire shared token's quota in one recheck pass, starving every other
 * `gh`-dependent step in the same pipeline. Claims past the ceiling land in
 * `unconfirmable` with reason "call budget exhausted", never silently
 * dropped. */
const RECHECK_MAX_CALLS_DEFAULT = 200;

/** A GitHub PR/issue/release-tag URL, anywhere in a line. Capture groups:
 * 1 owner, 2 repo, 3 the path segment (`pull` | `issues` | `releases/tag`),
 * 4 the number or tag. Stops at whitespace or a closing bracket/paren so a
 * URL embedded in Markdown (`[text](url)`) or prose (`url.`) doesn't pull
 * in trailing punctuation. */
const CLAIM_URL_RE = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(pull|issues|releases\/tag)\/([^\s)\]]+)/;

/** A note's own heading line, `# <owner>/<repo>` — the primary source for
 * resolving a bare `#<n>` reference in that same file (see `resolveBareRef`
 * below). Matches the exact shape every `.claude/skills/osstrich/
 * references/repos/*.md` file opens with. */
const HEADING_REPO_RE = /^#\s+([\w.-]+)\/([\w.-]+)\s*$/;

/** Any `github.com/<owner>/<repo>/...` URL, used only to derive the fallback
 * "nearest earlier URL's repo" when a file has no heading match — deliberately
 * looser than CLAIM_URL_RE (no `pull|issues|releases/tag` requirement) since
 * any GitHub URL naming the repo is evidence enough for the fallback. */
const GENERIC_GH_URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\//;

/** A bare "PR #<n>" / "pull #<n>" / "issue #<n>" reference — the word
 * immediately precedes the `#<n>`, per §57's own real-world example ("unpin
 * once an official release contains PR #185"). Captures 1: the word, 2: the
 * number. */
const WORD_HASH_RE = /\b(pr|pull request|pull|issue)\b\s*#(\d+)\b/i;

/** An explicit `<owner>/<repo>#<n>` reference with no "PR"/"issue" word
 * attached — ambiguous on its face (GitHub uses the same `#<n>` shorthand
 * for both issues and PRs), so `recheckOneClaim` tries it as a PR first and
 * falls back to an issue lookup on a 404 (see `RECHECKING AMBIGUOUS
 * REFERENCES` below). */
const OWNER_REPO_HASH_RE = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/;

/** The note's own repo, read once per file from its first `# <owner>/<repo>`
 * heading line — the primary resolution target for a bare `#<n>` reference
 * elsewhere in that file. Returns `null` when no such heading exists (the
 * caller then falls back to the nearest earlier GitHub URL, tracked per
 * line as the file is scanned). */
function resolveHeadingRepo(lines) {
	for (const line of lines) {
		const m = line.match(HEADING_REPO_RE);
		if (m) return `${m[1]}/${m[2]}`;
	}
	return null;
}

/**
 * Resolve a line's bare PR/issue/`<owner>/<repo>#<n>` reference (when the
 * line carries no full URL of its own) to a synthesized GitHub URL, using
 * `repo` (the note's heading repo, or the nearest earlier URL's repo) for
 * the two forms that don't name their own owner/repo. Returns `null` when
 * the line matches neither shape, or when a bare-number form matches but no
 * `repo` is available to resolve it against.
 */
function resolveBareReference(lineText, repo) {
	const wordMatch = lineText.match(WORD_HASH_RE);
	if (wordMatch) {
		if (!repo) return null;
		const word = wordMatch[1].toLowerCase();
		const kind = word === "issue" ? "issue" : "pr";
		const path = kind === "pr" ? "pull" : "issues";
		return { url: `https://github.com/${repo}/${path}/${wordMatch[2]}`, kind, ambiguous: false };
	}
	const ownerRepoMatch = lineText.match(OWNER_REPO_HASH_RE);
	if (ownerRepoMatch) {
		return { url: `https://github.com/${ownerRepoMatch[1]}/pull/${ownerRepoMatch[2]}`, kind: "pr", ambiguous: true };
	}
	return null;
}

/**
 * A line reads like a conditional retire-claim ("retire once X ships",
 * "unpin when the release lands", "opened as an upstream PR", "tracked for
 * upstream") — the exact shape named in the build plan and mirroring
 * §57's own three real-world examples. Internal only — nothing overrides
 * this pattern today, so it isn't a caller-facing option.
 */
const CONDITION_RE =
	/\b(retire|unpin|remove|drop|obsolete)\b.*\b(once|when|after)\b|\b(once|when|after)\b.*\b(ships|merges|lands|is released)\b|opened as an upstream (pr|pull request)|tracked (for|toward) upstream/i;

/** A line asserting the artifact's own state ("still open", "already
 * merged", "opened as ..."), checked in this ORDER — "merged" beats
 * "opened"/"open" because a line can plausibly contain more than one of
 * these words ("opened as an upstream PR, not yet merged"). Internal only —
 * nothing overrides this list today. */
const DEFAULT_ASSERTION_WORDS = [
	{ name: "merged", re: /\bmerged\b/ },
	{ name: "open", re: /\bopened\b/ },
	{ name: "open", re: /\bopen\b/ },
];

function assertedState(text) {
	const lower = String(text || "").toLowerCase();
	for (const { name, re } of DEFAULT_ASSERTION_WORDS) {
		if (re.test(lower)) return name;
	}
	return null;
}

/**
 * Scan `files` for claim-worthy lines: any line naming a GitHub PR/issue/
 * release URL, reading like a conditional retire-claim, or naming a bare
 * PR/issue number (`PR #<n>`, `issue #<n>`, `<owner>/<repo>#<n>`) that
 * resolves to a checkable URL (or any combination of these). A plain line
 * with none of these is not returned — this module only ever reports on
 * lines that name something checkable or something that SHOULD have named
 * something checkable.
 *
 * BARE NUMBER RESOLUTION. A line with no full URL match but a `PR #<n>` /
 * `pull #<n>` / `issue #<n>` reference resolves against the file's OWN
 * repo — read once from its first `# <owner>/<repo>` heading line, falling
 * back to the nearest earlier `github.com/<owner>/<repo>/` URL in the same
 * file when there's no heading. An explicit `<owner>/<repo>#<n>` reference
 * (no PR/issue word attached) names its own repo and needs no fallback, but
 * is ambiguous about kind — GitHub uses the same `#<n>` shorthand for both
 * — so it resolves tentatively to a PR url with `ambiguous: true` set on
 * the claim; `recheckOneClaim` is the one that actually falls back to an
 * issue lookup on a 404 (see that function's doc).
 *
 * @param {object} args
 * @param {string[]} args.files paths to read
 * @param {object} [args.fs] injected `node:fs`-shaped module
 * @returns {Array<{file: string, line: number, text: string, url: string|null, kind: "pr"|"issue"|"release"|"none", condition: boolean, ambiguous?: boolean}>}
 */
export function extractClaims({ files, fs = nodeFs }) {
	const claims = [];
	for (const file of files || []) {
		let contents;
		try {
			contents = fs.readFileSync(file, "utf8");
		} catch {
			// Missing/unreadable file — skip it rather than fail the whole
			// extraction; the caller's file list may include stale paths.
			continue;
		}
		const lines = contents.split("\n");
		const headingRepo = resolveHeadingRepo(lines);
		let fallbackRepo = null;

		lines.forEach((lineText, index) => {
			const urlMatch = lineText.match(CLAIM_URL_RE);
			const condition = CONDITION_RE.test(lineText);

			let url = urlMatch ? urlMatch[0] : null;
			let kind = urlMatch ? (urlMatch[3] === "pull" ? "pr" : urlMatch[3] === "issues" ? "issue" : "release") : "none";
			let ambiguous = false;

			if (!urlMatch) {
				const resolved = resolveBareReference(lineText, headingRepo || fallbackRepo);
				if (resolved) {
					url = resolved.url;
					kind = resolved.kind;
					ambiguous = resolved.ambiguous;
				}
			}

			// Track the nearest-earlier-URL fallback for lines further down —
			// after resolving THIS line's own reference, never before, so a
			// line's own URL is never used to resolve its own bare number
			// (it would already have matched CLAIM_URL_RE if that were meant).
			const genericGh = lineText.match(GENERIC_GH_URL_RE);
			if (genericGh) fallbackRepo = `${genericGh[1]}/${genericGh[2]}`;

			if (!url && !condition) return;
			const claim = { file, line: index + 1, text: lineText.trim(), url, kind, condition };
			if (ambiguous) claim.ambiguous = true;
			claims.push(claim);
		});
	}
	return claims;
}

function parseClaimUrl(url) {
	const m = String(url || "").match(CLAIM_URL_RE);
	if (!m) return null;
	const [, owner, repo, pathSegment, id] = m;
	const kind = pathSegment === "pull" ? "pr" : pathSegment === "issues" ? "issue" : "release";
	return { owner, repo, kind, id };
}

function endpointFor({ owner, repo, kind, id }) {
	if (kind === "pr") return `repos/${owner}/${repo}/pulls/${id}`;
	if (kind === "issue") return `repos/${owner}/${repo}/issues/${id}`;
	return `repos/${owner}/${repo}/releases/tags/${id}`;
}

/**
 * Whether any of a repo's recent releases postdates a merge — the truthful
 * answer to "has this PR's fix actually shipped yet," as opposed to merely
 * "did it merge." A prerelease or draft entry never counts: neither is a
 * release a consumer would actually pick up. Soft-fails to `false` on any
 * `exec` error (rate limit, network, no releases at all) — this is a
 * best-effort enrichment on top of `fired`, which a merged PR already earns
 * regardless (see `liveStateFor` below), never a reason to fail the claim.
 */
async function releasePublishedAfter({ owner, repo, mergedAtIso, exec }) {
	try {
		const { stdout } = await execGh(exec, ["api", `repos/${owner}/${repo}/releases?per_page=5`]);
		const releases = JSON.parse(stdout || "[]");
		if (!Array.isArray(releases)) return false;
		const mergedAtMs = new Date(mergedAtIso).getTime();
		return releases.some((r) => {
			if (r?.prerelease || r?.draft) return false;
			if (!r?.published_at) return false;
			return new Date(r.published_at).getTime() > mergedAtMs;
		});
	} catch {
		return false;
	}
}

/** Reduce one `gh api` payload down to the three facts this module cares
 * about, plus `fired` — whether a `condition: true` claim's artifact has
 * already merged/closed/published (build plan's exact wording).
 *
 * For a PR, `published` used to be hardcoded `false` — a merged PR "fires"
 * regardless (the claim's action, e.g. "unpin," can happen the moment it
 * merges), but a caller that cares whether the fix actually SHIPPED in a
 * release needs a truthful answer, not a placeholder. `owner`/`repo`/`exec`
 * are only required when `merged` is true — nothing extra is fetched for an
 * still-open or closed-unmerged PR.
 */
async function liveStateFor(kind, data, { exec, owner, repo } = {}) {
	if (kind === "pr") {
		const merged = Boolean(data?.merged_at);
		const published = merged && exec ? await releasePublishedAfter({ owner, repo, mergedAtIso: data.merged_at, exec }) : false;
		return { open: data?.state === "open", merged, published, fired: merged };
	}
	if (kind === "issue") {
		const isClosed = data?.state === "closed";
		return { open: data?.state === "open", merged: false, published: false, fired: isClosed };
	}
	// release: a successful fetch of the tag means it exists, i.e. published.
	const published = Boolean(data?.published_at);
	return { open: false, merged: false, published, fired: published };
}

function contradicts(assertion, state) {
	if (assertion === "merged") return !state.merged;
	if (assertion === "open") return !state.open;
	return false;
}

/**
 * Re-check one claim's live GitHub state. `claim.ambiguous` (set by
 * `extractClaims` for a bare `<owner>/<repo>#<n>` reference with no PR/issue
 * word attached) means the number could name either a PR or an issue —
 * GitHub's own UI shorthand doesn't disambiguate either. When that's set
 * and the initial PR-endpoint lookup fails, retry the SAME number against
 * the issues endpoint before giving up; a normal PR-URL claim (an explicit
 * `/pull/<n>` URL, or a bare "PR #<n>"/"pull #<n>" reference) never gets
 * this fallback — its failure is a real 404, not a kind mismatch.
 */
async function recheckOneClaim({ claim, exec }) {
	const parsed = parseClaimUrl(claim.url);
	if (!parsed) {
		return { bucket: "unconfirmable", entry: { ...claim, reason: "could not parse artifact url" } };
	}
	let effectiveKind = parsed.kind;
	let endpoint = endpointFor(parsed);
	let data;
	try {
		const { stdout } = await execGh(exec, ["api", endpoint]);
		data = JSON.parse(stdout || "{}");
	} catch (e) {
		if (claim.ambiguous && parsed.kind === "pr") {
			const issueEndpoint = endpointFor({ ...parsed, kind: "issue" });
			try {
				const retry = await execGh(exec, ["api", issueEndpoint]);
				data = JSON.parse(retry.stdout || "{}");
				effectiveKind = "issue";
				endpoint = issueEndpoint;
			} catch {
				// Neither the PR nor the issue endpoint resolved — report the
				// ORIGINAL (pulls) failure, since that's the lookup this
				// number most likely meant.
				return { bucket: "unconfirmable", entry: { ...claim, reason: `gh api ${endpoint} failed: ${e.message}` } };
			}
		} else {
			// Covers both a real 404 (gh exits non-zero) and any other exec
			// failure (timeout, auth) — both read the same to a caller: this
			// claim's live state could not be confirmed right now.
			return { bucket: "unconfirmable", entry: { ...claim, reason: `gh api ${endpoint} failed: ${e.message}` } };
		}
	}

	const state = await liveStateFor(effectiveKind, data, { exec, owner: parsed.owner, repo: parsed.repo });
	// Per the module's own BUCKETS doc, a contradicted assertion is "stale
	// regardless of condition" — so the contradiction check must run BEFORE
	// the `fired` short-circuit below, not after it. `state.fired` is
	// computed the same way either way, so a claim that lands in
	// `contradicted` still carries its true `live.fired` value.
	const assertion = assertedState(claim.text);
	if (assertion && contradicts(assertion, state)) {
		return { bucket: "contradicted", entry: { ...claim, live: state, asserted: assertion } };
	}
	if (claim.condition && state.fired) {
		return { bucket: "fired", entry: { ...claim, live: state } };
	}
	return { bucket: "current", entry: { ...claim, live: state } };
}

/**
 * Re-check every claim's live GitHub state and bucket it — see module doc
 * for the four buckets. Never throws: every failure mode (bad url, `gh`
 * error, low rate limit) lands a claim in `unconfirmable` with a `reason`
 * instead.
 *
 * @param {object} args
 * @param {Array} args.claims from `extractClaims`
 * @param {Function} [args.exec] injected execFile-shaped runner
 * @param {number} [args.maxCalls] per-run ceiling on `gh api` calls — see
 *   RECHECK_MAX_CALLS_DEFAULT's doc. Claims past this ceiling are bucketed
 *   `unconfirmable` ("call budget exhausted") without ever calling `exec`.
 * @returns {Promise<{fired: Array, contradicted: Array, unconfirmable: Array, current: Array, budget: {used: number, max: number}}>}
 */
export async function recheckClaims({ claims, exec = defaultExecFileAsync, maxCalls = RECHECK_MAX_CALLS_DEFAULT }) {
	const result = { fired: [], contradicted: [], unconfirmable: [], current: [] };
	const withUrl = [];
	for (const claim of claims || []) {
		if (!claim.url) {
			if (claim.condition) {
				result.unconfirmable.push({ ...claim, reason: "no checkable artifact" });
			}
			continue;
		}
		withUrl.push(claim);
	}

	if (withUrl.length === 0) {
		result.budget = { used: 0, max: maxCalls };
		return result;
	}

	// MED-4: a per-run ceiling, checked BEFORE the rate-limit probe — a file
	// naming thousands of claims must never spend even the one rate_limit
	// call, let alone the per-claim calls, past what this run is allowed.
	const toCheck = withUrl.slice(0, maxCalls);
	for (const claim of withUrl.slice(maxCalls)) {
		result.unconfirmable.push({ ...claim, reason: "call budget exhausted" });
	}
	result.budget = { used: toCheck.length, max: maxCalls };
	if (toCheck.length === 0) return result;

	let remaining;
	try {
		const { stdout } = await execGh(exec, ["api", "rate_limit"]);
		remaining = JSON.parse(stdout || "{}")?.resources?.core?.remaining;
	} catch (e) {
		for (const claim of toCheck) {
			result.unconfirmable.push({ ...claim, reason: `could not check gh api rate limit: ${e.message}` });
		}
		return result;
	}

	if (typeof remaining !== "number" || remaining < RATE_LIMIT_FLOOR) {
		for (const claim of toCheck) {
			result.unconfirmable.push({ ...claim, reason: `gh api core rate limit too low to recheck (remaining ${remaining})` });
		}
		return result;
	}

	await mapWithConcurrency(toCheck, RECHECK_CONCURRENCY, async (claim) => {
		const { bucket, entry } = await recheckOneClaim({ claim, exec });
		result[bucket].push(entry);
	});

	return result;
}
