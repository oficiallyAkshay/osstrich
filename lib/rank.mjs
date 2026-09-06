/**
 * shared/osstrich-rank.mjs — the osstrich skill's D2 "rank" phase
 * (`.claude/skills/osstrich/references/discover.md` → D2 · Rank). Pure
 * arithmetic over data already collected by `shared/osstrich-inventory.mjs`
 * plus one piece of data the caller owns for itself: the classification
 * file (config key `classification`).
 *
 * WHAT "RANK" MEANS HERE. Two ranks per project, ascending — rank 1 is the
 * LEAST popular project by that measure, matching discover.md's framing
 * ("Two ranks per project, ascending (least popular first)"). Ties share a
 * rank using standard competition ranking (1, 1, 3, not 1, 1, 2) — the next
 * distinct value's rank is its 1-based position in the ascending-sorted
 * list, counting every tied entry ahead of it. `combined` is the average of
 * the two, except a project with no download figure at all (a binary, a
 * GitHub Action, a container image, a host install) keeps its star rank
 * alone — there is nothing to average against.
 *
 * Community-first ordering (discover.md D2): community projects rank ahead
 * of company / company-adjacent ones in the final ordering, regardless of
 * combined rank — UNLESS the classification table's Override column is
 * non-empty for that row, in which case the override wins and the row stays
 * in the community-first group. A project the table doesn't mention at all is
 * "unclassified", which sorts with community (never silently defaults to
 * company — that would bury it).
 *
 * UNRANKABLE ROWS NEVER SORT TO THE BOTTOM BY ACCIDENT. A container image
 * (`kind === "image"`) never carries stars or downloads at all, and any
 * other row with BOTH `stars` and `weeklyDownloads` null (a binary or
 * action whose GitHub lookup never resolved) has no popularity signal
 * either — ranking either as "least popular" would bury real low-signal
 * projects underneath rows that were never measured in the first place. A
 * THIRD class: a project whose upstream repo lookup itself failed (the
 * inventory's `gaps` array carries a `source: "github-metadata"` entry for
 * that `repo` whose error text says 404/Not Found) cannot receive a
 * contribution at all — ranking it by downloads alone (its npm registry
 * lookup can still have succeeded even though GitHub 404s) would let a
 * dead-repo project outrank real, reachable candidates. A FOURTH class: a
 * hand-patch row (`kind === "patch"`, `osstrich-inventory.mjs`'s
 * `<repo>#patch-N` rows) is a need signal against a project we already run
 * under a different row, not a project of its own — ranking it alongside
 * real projects would double-count that project's popularity contribution
 * and could plant a fake bottom-N entry with no rank of its own to inherit.
 * All four classes are pulled out before ranking and returned separately in
 * `unranked: [{ name, reason }]` (`reason` is `"image"`, `"no popularity
 * data"`, `"upstream repo not found"`, or `"hand patch (a need signal, not
 * a project)"`); `rows`, `bottom`, and `unclassified` all describe the
 * ranked remainder only. A row with null `stars` but a real
 * `weeklyDownloads` figure and a repo that DID resolve is NOT unranked —
 * see the existing null-stars note below.
 *
 * NO I/O. This module never touches disk or the network — `inventory` and
 * `classificationMarkdown` are both handed in already read. That is what
 * makes it side-effect-free at import and trivially unit-testable.
 */

/** A markdown pipe-table row split into trimmed cells, leading/trailing "|" stripped. */
function splitTableRow(line) {
	let body = line.trim();
	if (body.startsWith("|")) body = body.slice(1);
	if (body.endsWith("|")) body = body.slice(0, -1);
	return body.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
	return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * Parses the classification file's (config key `classification`) table
 * into a lookup keyed by the lowercased `owner/repo` string. Returns an
 * empty map for a missing/empty/malformed table — scenario 13 in
 * `scouts/scenarios.md` says a consumer repo without this file yet loses
 * nothing: every project just comes back "unclassified", which is exactly
 * the same outcome a present-but-empty table would produce.
 */
function parseClassificationTable(classificationMarkdown) {
	const byRepo = new Map();
	if (typeof classificationMarkdown !== "string" || classificationMarkdown.length === 0) return byRepo;

	const lines = classificationMarkdown.split(/\r?\n/);
	let columnIndex = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) continue;
		const cells = splitTableRow(trimmed);

		if (!columnIndex) {
			const lower = cells.map((c) => c.toLowerCase());
			const projectIdx = lower.indexOf("project");
			const classIdx = lower.indexOf("class");
			if (projectIdx === -1 || classIdx === -1) continue; // not the header row yet
			columnIndex = {
				project: projectIdx,
				class: classIdx,
				reason: lower.indexOf("reason"),
				override: lower.indexOf("override"),
				lastVerified: lower.indexOf("last verified"),
			};
			continue;
		}

		if (isSeparatorRow(cells)) continue;

		const project = cells[columnIndex.project];
		if (!project) continue;
		byRepo.set(project.toLowerCase(), {
			class: cells[columnIndex.class] || "unclassified",
			reason: columnIndex.reason >= 0 ? cells[columnIndex.reason] || "" : "",
			override: columnIndex.override >= 0 ? cells[columnIndex.override] || "" : "",
			lastVerified: columnIndex.lastVerified >= 0 ? cells[columnIndex.lastVerified] || "" : "",
		});
	}

	return byRepo;
}

/** Standard competition ranking ("1224 ranking"), ascending: ties share a rank, the next distinct value skips ahead by the tie's size; `null`/`undefined` entries pass through as `null`. */
function competitionRank(values) {
	const present = values.filter((v) => v !== null && v !== undefined);
	const sorted = [...present].sort((a, b) => a - b);
	const rankByValue = new Map();
	sorted.forEach((v, i) => {
		if (!rankByValue.has(v)) rankByValue.set(v, i + 1);
	});
	return values.map((v) => (v === null || v === undefined ? null : rankByValue.get(v)));
}

/**
 * `rankProjects(inventory, classificationMarkdown, opts)` → the D2 phase.
 *
 * `inventory` is `inventory.json`'s shape, `{ projects: [...], gaps, ... }`
 * — but a bare array of project rows is also accepted (the CLI's own
 * pipeline always hands in the object; tests and any other caller that
 * already narrowed to `.projects` should not have to re-wrap it).
 *
 * Stars with no GitHub repo at all, but a REAL downloads figure (an npm
 * package whose registry lookup succeeded but whose GitHub lookup didn't)
 * are treated as the least popular value in the pool (`-1`, below any real
 * star count) rather than excluded — a project we can measure by downloads
 * alone still belongs in the ranking, at the bottom of the stars half.
 * Downloads, by contrast, are genuinely inapplicable for a binary/action/
 * host install, which is why `weeklyDownloads == null` skips the download
 * half of the average entirely per the contract below. A row with NEITHER
 * measure at all (see UNRANKABLE ROWS above) is excluded before any of
 * this runs, not fed in as a `-1`/`null` pair.
 *
 * `opts.classificationMissing`/`opts.classificationPath`: this module does
 * no I/O (see NO I/O above), so it cannot tell "the classification file
 * doesn't exist" apart from "it exists and is empty" from
 * `classificationMarkdown` alone — both parse to the same empty table.
 * A caller that DOES know (it already tried the read) passes
 * `classificationMissing: true` plus the path it tried, and this function
 * records that as one `gaps: [{ source: "classification", file,
 * error }]` entry in its own result, naming how many projects that leaves
 * unclassified — rather than the file coming back missing forever without
 * a single signal anywhere that it was ever supposed to exist.
 */
/**
 * Phase 1 — pull out the four unrankable classes (see the module doc's
 * "UNRANKABLE ROWS" section), rank the rest by stars/downloads, and decorate
 * every ranked row with its classification-table class/override. Returns
 * `{ decorated, unranked, unclassified }`; `orderAndSlice` below turns
 * `decorated` into the final community-first ordering.
 */
function buildAndClassifyRows({ allProjects, inventoryGaps, classification }) {
	// A repo whose GitHub metadata lookup itself 404'd — its downloads figure
	// (if any) can still be real (npm and GitHub are looked up independently),
	// but there is no upstream repo left to contribute to. See the module
	// doc's "UNRANKABLE ROWS" section, third class.
	const notFoundRepos = new Set();
	for (const gap of inventoryGaps) {
		if (gap?.source !== "github-metadata") continue;
		const errorText = String(gap?.error || "");
		if (!gap.file) continue;
		if (/404|Not Found/i.test(errorText)) notFoundRepos.add(String(gap.file).toLowerCase());
	}

	const unranked = [];
	const projects = [];
	for (const project of allProjects) {
		if (project.kind === "image") {
			unranked.push({ name: project.name, reason: "image" });
			continue;
		}
		if (project.kind === "patch") {
			unranked.push({ name: project.name, reason: "hand patch (a need signal, not a project)" });
			continue;
		}
		if (project.repo && notFoundRepos.has(String(project.repo).toLowerCase())) {
			unranked.push({ name: project.name, reason: "upstream repo not found" });
			continue;
		}
		const hasStars = project.stars !== null && project.stars !== undefined;
		const hasDownloads = project.weeklyDownloads !== null && project.weeklyDownloads !== undefined;
		if (!hasStars && !hasDownloads) {
			unranked.push({ name: project.name, reason: "no popularity data" });
			continue;
		}
		projects.push(project);
	}
	unranked.sort((a, b) => a.name.localeCompare(b.name));

	const starsValues = projects.map((p) => (p.stars === null || p.stars === undefined ? -1 : p.stars));
	const starsRanks = competitionRank(starsValues);
	const downloadsValues = projects.map((p) => (p.weeklyDownloads === null || p.weeklyDownloads === undefined ? null : p.weeklyDownloads));
	const downloadsRanks = competitionRank(downloadsValues);

	const unclassified = [];
	const decorated = projects.map((project, i) => {
		const starsRank = starsRanks[i];
		const downloadsRank = downloadsRanks[i];
		const combined = project.weeklyDownloads === null || project.weeklyDownloads === undefined ? starsRank : (starsRank + downloadsRank) / 2;

		const match = project.repo ? classification.get(String(project.repo).toLowerCase()) : undefined;
		const cls = match?.class || "unclassified";
		if (!match) unclassified.push(project.name);

		return {
			...project,
			starsRank,
			downloadsRank,
			combined,
			class: cls,
			reason: match?.reason || "",
			override: match?.override || "",
		};
	});

	return { decorated, unranked, unclassified };
}

/**
 * Phase 2 — community-first ordering: community + unclassified + any
 * overridden row lead, each group sorted by combined rank ascending (least
 * popular first, per discover.md), name as the deterministic tiebreaker.
 * Returns `{ rows, bottom }`.
 */
function orderAndSlice({ decorated, bottomN }) {
	const byCombinedThenName = (a, b) => (a.combined !== b.combined ? a.combined - b.combined : a.name.localeCompare(b.name));

	const communityFirst = [];
	const companyLater = [];
	for (const row of decorated) {
		const leadsWithCommunity = row.override.length > 0 || row.class === "community" || row.class === "unclassified";
		(leadsWithCommunity ? communityFirst : companyLater).push(row);
	}
	communityFirst.sort(byCombinedThenName);
	companyLater.sort(byCombinedThenName);

	const rows = [...communityFirst, ...companyLater];
	const bottom = rows.slice(0, bottomN).map((row) => row.name);
	return { rows, bottom };
}

export function rankProjects(inventory, classificationMarkdown, { bottomN = 10, classificationMissing = false, classificationPath = null } = {}) {
	const allProjects = Array.isArray(inventory) ? inventory : Array.isArray(inventory?.projects) ? inventory.projects : [];
	const inventoryGaps = Array.isArray(inventory?.gaps) ? inventory.gaps : [];
	const classification = parseClassificationTable(classificationMarkdown);
	const gaps = [];

	const { decorated, unranked, unclassified } = buildAndClassifyRows({ allProjects, inventoryGaps, classification });
	const { rows, bottom } = orderAndSlice({ decorated, bottomN });

	if (classificationMissing) {
		gaps.push({
			source: "classification",
			file: classificationPath,
			error: `classification file missing; ${unclassified.length} projects unclassified`,
		});
	}

	return { rows, bottom, unclassified, unranked, gaps };
}

function formatMetric(value) {
	return value === null || value === undefined ? "—" : String(value);
}

/**
 * Renders `rankProjects`'s result as the `rank.md` the CLI writes to the
 * run directory. Row order is `result.rows`'s own order (already the final
 * community-first-then-company ordering) — this function never re-sorts.
 * When `result.unranked` is non-empty, a short second table lists those
 * rows (already name-sorted by `rankProjects`) with their exclusion
 * `reason` — they carry no stars/downloads/class to show in the main
 * table's columns.
 */
export function renderRankMarkdown(result) {
	const header = "| Rank | Name | Kind | Ours → Latest | Stars | Downloads | Class | Override |";
	const separator = "|---|---|---|---|---|---|---|---|";
	const body = result.rows.map((row, i) => {
		const oursToLatest = `${formatMetric(row.ours)} → ${formatMetric(row.latest)}`;
		return `| ${i + 1} | ${row.name} | ${row.kind} | ${oursToLatest} | ${formatMetric(row.stars)} | ${formatMetric(row.weeklyDownloads)} | ${row.class} | ${row.override || "—"} |`;
	});
	const lines = [header, separator, ...body];

	if (result.unranked?.length > 0) {
		lines.push("", "Unranked — no popularity signal to rank by:", "", "| Name | Reason |", "|---|---|");
		for (const row of result.unranked) {
			lines.push(`| ${row.name} | ${row.reason} |`);
		}
	}

	return lines.join("\n");
}
