/**
 * shared/osstrich-run.mjs — run-directory lifecycle for `osstrich`: open an
 * attempt directory, write each phase's partial as the pipeline goes, and
 * append the closing record line.
 *
 * WHY A DIRECTORY, NOT A DATABASE ROW
 * -------------------------------------
 * `osstrich discover` is a long chain (inventory → rank → infer → upstream)
 * that reads live GitHub state and can be interrupted or re-run mid-way
 * (`.claude/skills/osstrich/references/discover.md` "the gate" and Decision
 * 6 in the build plan). Plain JSON files on disk, one per phase, are
 * trivially resumable and trivially diffable across attempts — no schema,
 * no migration, and every partial survives a crash by construction (each
 * `writePartial` call is a single synchronous write, never buffered across
 * phases). A caller's own durable ledger row, if it has one (see
 * `onRunEnd` below), is layered on TOP of this for cross-run observability;
 * the directory itself is the source of truth for what a given run
 * actually produced.
 *
 * ATTEMPT NUMBERING
 * ------------------
 * `<runsDir>/<YYYY-MM-DD>-<slug>-attempt-<N>/`, N counted per (date, slug)
 * pair starting at 1 — a re-run of the same slug on the same day gets its
 * own numbered directory rather than overwriting the first attempt's
 * partials, so a bad run is never silently clobbered.
 *
 * RESUME
 * ------
 * `resume: true` skips the "make a new attempt" step and reuses the newest
 * existing attempt directory for `slug` (newest by date, then by attempt
 * number — a run resumed the day after it started still finds it). A caller
 * (`scripts/osstrich.mjs`) tells which phases already have a partial by
 * reading each phase's own `<phase>.json` straight out of that directory,
 * never from this function's return value.
 *
 * INJECTABLE SEAMS
 * -----------------
 * `fs` defaults to real `node:fs` (synchronous calls throughout — every
 * write here is small, and synchronous keeps `progress.json` never
 * momentarily inconsistent with the phase file it describes); `now`
 * defaults to `Date.now`. Both are overridden by this package's own test
 * suite for this module.
 *
 * WHY `onRunEnd`, NOT A HARDCODED SIDE EFFECT
 * -----------------------------------------------
 * This module never names a database, a ledger, or any other consumer-repo
 * concept — its only durable output is `run-record.jsonl`. A caller that
 * wants a run's close to also do something else (write a row to its own
 * observability store, ping a webhook) hands `finishRun` an `onRunEnd`
 * callback; `.osstrich.json`'s `hooks.runEnd` is how the CLI resolves one.
 * The callback is awaited but never allowed to take the CLI down with it —
 * a throwing hook is caught and recorded as a `hook_error` gap line
 * alongside (never instead of) the run's own JSONL record, which is the
 * thing that must never be lost.
 */

import * as nodeFs from "node:fs";
import path from "node:path";

const ATTEMPT_DIR_RE = /^(\d{4}-\d{2}-\d{2})-(.+)-attempt-(\d+)$/;
const PROGRESS_FILE = "progress.json";
const RECORD_FILE = "run-record.jsonl";

/** The plan's nine session-supplied record fields (`finishRun`'s `record`
 * argument) — everything not in this list is filled from `progress.json`
 * or the run directory's own name, never from `record`. */
const RECORD_FIELDS = [
	"projects_inventoried",
	"bottom_n",
	"candidates",
	"funded",
	"deferred",
	"give_back_only",
	"gate_migrated",
	"gate_upstream",
	"prs_opened",
	"review_rounds",
	"fork_patches_retired",
	"hand_patches_retired",
];

function isoDate(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}

/** Every existing `<date>-<slug>-attempt-<N>` directory under `runsDir` for
 * this exact `slug`. An unreadable/missing `runsDir` reads as "none yet" —
 * the first `openRun` call for a brand-new runs root must not throw. */
function listAttempts(runsDir, slug, fs) {
	let entries;
	try {
		entries = fs.readdirSync(runsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const entry of entries) {
		if (typeof entry.isDirectory === "function" && !entry.isDirectory()) continue;
		const m = entry.name.match(ATTEMPT_DIR_RE);
		if (!m || m[2] !== slug) continue;
		out.push({ name: entry.name, date: m[1], attempt: Number(m[3]) });
	}
	return out;
}

function readProgress(dir, fs) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, PROGRESS_FILE), "utf8"));
	} catch {
		return { started_at: null, phases: {} };
	}
}

function writeProgress(dir, progress, fs) {
	fs.writeFileSync(path.join(dir, PROGRESS_FILE), `${JSON.stringify(progress, null, 2)}\n`);
}

/**
 * @param {object} args
 * @param {string} args.runsDir
 * @param {string} args.slug
 * @param {() => number} [args.now]
 * @param {typeof import("node:fs")} [args.fs]
 * @param {boolean} [args.resume] — reuse the newest existing attempt for
 *   `slug` instead of creating a new one; falls back to creating a fresh
 *   attempt when none exists yet.
 * @returns {{dir: string}}
 */
export function openRun({ runsDir, slug, now = Date.now, fs = nodeFs, resume = false }) {
	const attempts = listAttempts(runsDir, slug, fs);

	if (resume && attempts.length > 0) {
		attempts.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.attempt - a.attempt));
		return { dir: path.join(runsDir, attempts[0].name) };
	}

	const date = isoDate(now());
	let attempt = attempts.filter((a) => a.date === date).length + 1;
	// The parent (`runsDir`) creation stays idempotent (`recursive: true`,
	// never throws if it already exists) — only the per-attempt leaf
	// directory needs the exists-check below, since that's the thing two
	// racing callers must never both "successfully" claim.
	fs.mkdirSync(runsDir, { recursive: true });
	let dir = path.join(runsDir, `${date}-${slug}-attempt-${attempt}`);
	// `mkdirSync` WITHOUT `recursive` throws EEXIST when the directory is
	// already there — that's what lets a second racing caller notice another
	// process just claimed this attempt number and advance instead of
	// silently overwriting its partials (see module doc's ATTEMPT NUMBERING).
	for (;;) {
		try {
			fs.mkdirSync(dir, { recursive: false });
			break;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			attempt += 1;
			dir = path.join(runsDir, `${date}-${slug}-attempt-${attempt}`);
		}
	}
	writeProgress(dir, { started_at: new Date(now()).toISOString(), phases: {} }, fs);
	return { dir };
}

/**
 * Write `<dir>/<fileBase>.json`, plus `<dir>/<fileBase>.md` when
 * `data.markdown` is a string (the rank phase's rendered table, the
 * discover verdict — anything with a human-readable rendering alongside
 * its JSON), and record both paths against `phase` in `progress.json` so
 * `openRun({resume:true})` can find them later.
 *
 * `fileBase` (defaults to `phase`) is the on-disk name a phase's partial
 * is written under when it differs from the phase's own tracking key — the
 * discover verdict phase tracks as `"verdict"` in `progress.json` (so
 * `--resume` can find it) but writes `verdict-template.md`, a name
 * `discover.md` documents as distinct from the later judgment stage's own
 * `verdict.json`/`verdict.md`. `writeJson: false` skips the `.json` file
 * entirely for a phase, like the verdict template, that is pure markdown
 * with no JSON companion.
 *
 * @param {string} dir
 * @param {string} phase
 * @param {object} data
 * @param {{fs?: typeof import("node:fs"), fileBase?: string, writeJson?: boolean}} [opts]
 * @returns {{jsonPath: string|null, mdPath: string|null}}
 */
export function writePartial(dir, phase, data, { fs = nodeFs, fileBase = phase, writeJson = true } = {}) {
	let jsonPath = null;
	if (writeJson) {
		jsonPath = path.join(dir, `${fileBase}.json`);
		fs.writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
	}

	let mdPath = null;
	if (data && typeof data.markdown === "string") {
		mdPath = path.join(dir, `${fileBase}.md`);
		fs.writeFileSync(mdPath, data.markdown);
	}

	const progress = readProgress(dir, fs);
	progress.phases = progress.phases || {};
	progress.phases[phase] = { path: jsonPath, md_path: mdPath, written_at: new Date().toISOString() };
	writeProgress(dir, progress, fs);

	return { jsonPath, mdPath };
}

/**
 * Append one line to `<dir>/run-record.jsonl`. Called more than once across
 * a run's lifetime is BY DESIGN: `discover` calls it once with the four
 * counts it knows at close, and the session's later `osstrich record`
 * invocation calls it again on the same directory once the funded/deferred
 * verdict is decided — each call is one more line, a running log of what
 * was known when, never a read-modify-write of a single row.
 *
 * `onRunEnd(record, {dir})`, when supplied, is awaited AFTER the JSONL line
 * is already durably written — see module doc's "WHY onRunEnd" section. A
 * throwing (or rejecting) hook never propagates out of `finishRun`, and
 * never risks the line that already landed: it is caught and recorded as
 * one more `run-record.jsonl` line (`{run_id, gap: "hook_error: ..."}`)
 * rather than losing the failure silently.
 *
 * @param {string} dir
 * @param {object} record — the session-supplied counts; see RECORD_FIELDS.
 * @param {object} [opts]
 * @param {typeof import("node:fs")} [opts.fs]
 * @param {() => number} [opts.now]
 * @param {(record: object, ctx: {dir: string}) => (void|Promise<void>)} [opts.onRunEnd]
 * @returns {Promise<string>} the path written to
 */
export async function finishRun(dir, record, { fs = nodeFs, now = Date.now, onRunEnd = null } = {}) {
	const progress = readProgress(dir, fs);
	const runId = path.basename(dir);
	const nowIso = new Date(now()).toISOString();

	const line = { run_id: runId, started_at: progress.started_at || null, finished_at: nowIso };
	for (const field of RECORD_FIELDS) {
		line[field] = record?.[field] ?? null;
	}
	// The CLI's own three fields default to 0 (it always knows them by the
	// time it calls finishRun); the session-filled ones default to null —
	// "not yet decided" is a different fact than "zero of these."
	for (const field of ["projects_inventoried", "bottom_n", "candidates"]) {
		if (line[field] === null) line[field] = 0;
	}

	const recordPath = path.join(dir, RECORD_FILE);
	fs.appendFileSync(recordPath, `${JSON.stringify(line)}\n`);

	if (onRunEnd) {
		try {
			await onRunEnd(line, { dir });
		} catch (e) {
			fs.appendFileSync(recordPath, `${JSON.stringify({ run_id: runId, gap: `hook_error: onRunEnd failed: ${e?.message || e}` })}\n`);
		}
	}

	return recordPath;
}
