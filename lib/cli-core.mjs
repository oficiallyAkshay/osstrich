/**
 * lib/cli-core.mjs — the osstrich CLI's real work: discover (inventory ->
 * rank -> infer -> upstream -> verdict -> build), the standalone phases,
 * scrub, recheck, record, and build. `bin/osstrich.mjs` reaches this
 * lazily, through `lib/cli-dispatch.mjs`, only for the four public
 * subcommands (discover, build, scrub, recheck); `inventory`, `rank`,
 * `infer`, `upstream`, and `record` stay reachable by calling `main()`
 * here directly (this package's own test suite does), matching every
 * subcommand the private core this was ported from supported.
 *
 * DEPENDENCY SHAPE
 * -----------------
 * `main(argv, deps)` accepts EITHER the "resolved" deps shape (every
 * module and I/O boundary as its own key — see `defaultDeps()` below, and
 * this package's own tests, which fake individual pieces of it) OR the
 * thinner shape `bin/osstrich.mjs` actually builds (`fs`, `env`, `exec`,
 * `prompts`, `homedir`, `cwd`, `stdout`, `stderr`) — `lib/cli-dispatch.mjs`
 * hands this file that thinner shape unchanged, so `main()` recognizes it
 * (no `collectInventory` key yet) and calls `defaultDeps()` itself to fill
 * in the rest before dispatching.
 *
 * NEVER `console.*`
 * -------------------
 * Every line this file prints goes through `deps.stdout.write` /
 * `deps.stderr.write` — the same stream convention `lib/commands/*.mjs`
 * already uses (the private core this was ported from called `deps.stdout`
 * as a function; that convention is adapted here to match the rest of this
 * package).
 *
 * FAILURES GO THROUGH `OsstrichError`
 * -------------------------------------
 * A judgment-stage failure (no agent configured, a stage that failed, a
 * verdict.json that doesn't validate) throws `OsstrichError('AGENT', ...)`
 * with a hint. `main()` catches it (and, defensively, anything else) at the
 * top level, prints the exact same "osstrich <command>: FAILED — message" +
 * hint shape `bin/osstrich.mjs`'s own `formatFailure` prints for every
 * other command, and returns 2 — so a direct caller of this file's `main()`
 * (this package's own tests) gets a returned exit code, never an unhandled
 * rejection, while `bin/osstrich.mjs`'s outer try/catch would produce the
 * identical text if this error ever escaped that far instead.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import nodeFs from 'node:fs';
import os from 'node:os';
import { z } from 'zod';

import { loadConfig } from './config.mjs';
import { OsstrichError, formatFailure } from './errors.mjs';
import { markPhase } from './status.mjs';
import { runAgentStage } from './agent.mjs';
import { pickCandidates } from './picker.mjs';
import { overlapVerdictGate, build as buildPrompt, slugFor } from './prompts.mjs';

import { collectInventory } from './inventory.mjs';
import { rankProjects, renderRankMarkdown } from './rank.mjs';
import { inferNextSteps } from './infer.mjs';
import { shortlistUpstream, deriveRepoStopwords } from './upstream.mjs';
import { scrubText, scrubPaths } from './scrub.mjs';
import { extractClaims, recheckClaims } from './recheck.mjs';
import { openRun, writePartial, finishRun } from './run.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** `--slug`/`--dir` values land in a filesystem path (`runsDir/<slug>...`);
 * this is the only guard against a typo'd or crafted `--slug ../../elsewhere`
 * silently writing run partials outside the intended run directory. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const USAGE = `usage: osstrich <command> [options]

commands:
  discover [--slug <slug>] [--bottom <n>] [--resume] [--headless] [--table]
      Run inventory -> rank -> infer -> upstream in one run directory. With
      --table, stop after writing verdict-template.md and skip the
      judgment stages entirely — exits 0 either way (candidates are
      output, not a failure). Otherwise run the verdict agent stage, pick
      funded candidates (--headless takes the single best one; no TTY
      behaves as --headless; an interactive terminal gets a multiselect),
      then run one build agent stage per picked candidate, sequential.
      A --resume run prints one line per phase it skips because that
      phase's partial is already present.

  inventory [--dir <runDir>] [--slug <slug>] [--resume]
  rank      [--dir <runDir>] [--slug <slug>] [--resume] [--bottom <n>]
  infer     [--dir <runDir>] [--slug <slug>] [--resume]
  upstream  [--dir <runDir>] [--slug <slug>] [--resume]
      Run exactly one phase. rank/infer/upstream read the inventory partial
      (and, for upstream, the infer partial) from the same run directory —
      pass --dir to point at one already opened by a prior call, or omit it
      to open a fresh (or --resume the newest) run for --slug.

  build [<owner/repo#n | issue URL | PR URL>]
      With a target: open a new run directory named for it and run the
      build agent stage against it directly. Without one: read the newest
      run directory's verdict.json and build the oldest funded row not
      already built.

  scrub <file|dir>...
  scrub --text "<body>"
      Print every export-safety finding (internal names, hosts, paths,
      the personal email) found in the given paths or literal text.
      Exit code 0 on a clean scan, 1 when any finding is printed, 2 when the
      scan itself failed (never treat a failed scan as clean) or on --help /
      an unrecognized flag.

  recheck <file|dir>...
      Extract tracked upstream claims from the given markdown files/dirs and
      print the fired / contradicted / unconfirmable / current buckets.

  record --dir <runDir> [--projects_inventoried <n>] [--bottom_n <n>]
         [--candidates <n>] [--funded <n>] [--deferred <n>]
         [--give_back_only <n>] [--gate_migrated <n>] [--gate_upstream <n>]
         [--prs_opened <n>] [--review_rounds <n>]
         [--fork_patches_retired <n>] [--hand_patches_retired <n>]
      Append one more run-record.jsonl line to an existing run directory
      with whichever counts the session now knows.
`;

const VerdictRowSchema = z.object({
  name: z.string(),
  repo: z.string(),
  ruling: z.enum(['fund', 'defer', 'skip', 'give-back']),
  item: z.string(),
  need: z.string(),
  evidence: z.array(z.enum(['reproduction', 'patch', 'production', 'measurement'])),
  gate: z.enum(['upstream', 'migrate']).nullable(),
  combinedRank: z.number(),
});
const VerdictSchema = z.object({ rows: z.array(VerdictRowSchema) });

/** Dynamically import `config.hooks.runEnd` (a path already resolved by
 * `loadConfig`) and return its default export, or `null` when no hook is
 * configured. A hook module that fails to import is treated the same as no
 * hook — `finishRun` never needs to know the difference between "not
 * configured" and "configured but broken at import time." */
async function loadRunEndHook(hookPath) {
  if (!hookPath) return null;
  try {
    const mod = await import(pathToFileURL(hookPath).href);
    return typeof mod.default === 'function' ? mod.default : null;
  } catch {
    return null;
  }
}

/**
 * The real, wired-up `deps` this CLI runs against. `overrides` supplies
 * whatever `bin/osstrich.mjs` (or a test) already has — `fs`, `env`,
 * `exec`, `prompts`, `homedir`, `cwd`, `stdout`, `stderr`, `isTTY` — and
 * every real Node default fills in the rest, so `defaultDeps()` with no
 * arguments at all is the same "real wiring" contract the private core
 * this was ported from exposed.
 */
export async function defaultDeps(overrides = {}) {
  const fs = overrides.fs ?? nodeFs;
  const env = overrides.env ?? process.env;
  const homedir = overrides.homedir ?? os.homedir();
  // `cwd` is this package's own name for the repo osstrich runs against;
  // `repoRoot` is accepted as the same thing (the name the private core
  // this was ported from used for its own `defaultDeps({ repoRoot })`).
  const cwd = overrides.cwd ?? overrides.repoRoot ?? process.cwd();
  const exec = overrides.exec;
  const stdout = overrides.stdout ?? { write: (s) => process.stdout.write(s) };
  const stderr = overrides.stderr ?? { write: (s) => process.stderr.write(s) };
  const prompts = overrides.prompts;
  const fetchFn = overrides.fetch ?? globalThis.fetch;
  const isTTY = overrides.isTTY ?? Boolean(process.stdin && process.stdin.isTTY);

  const config = loadConfig({ repoRoot: cwd, fs, env, homedir });
  const stopwords = [...config.stopwords, ...deriveRepoStopwords({ repoRoot: cwd, fs })];
  const scanOptions = {
    skipDirs: config.skipDirs,
    ignore: config.ignore,
    stopwords,
    maxFileBytes: config.maxFileBytes,
    hostsFile: config.hosts,
  };

  return {
    collectInventory: (args) =>
      collectInventory({ ...args, skipDirs: scanOptions.skipDirs, hostsFile: scanOptions.hostsFile, maxFileBytes: scanOptions.maxFileBytes }),
    rankProjects,
    renderRankMarkdown,
    inferNextSteps: (args) => inferNextSteps({ ...args, skipDirs: scanOptions.skipDirs, ignore: scanOptions.ignore }),
    shortlistUpstream: (args) => shortlistUpstream({ ...args, stopwords: scanOptions.stopwords }),
    scrubText,
    scrubPaths,
    extractClaims,
    recheckClaims,
    openRun,
    writePartial,
    finishRun,
    runAgentStage,
    pickCandidates,
    fs,
    exec,
    fetch: fetchFn,
    stdout,
    stderr,
    prompts,
    homedir,
    cwd,
    env,
    isTTY,
    runsDir: config.stateDir,
    repoRoot: cwd,
    classificationPath: config.classification,
    termsPath: config.scrubTerms,
    configPath: config.configPath,
    onRunEnd: await loadRunEndHook(config.hooks.runEnd),
    agentCommand: config.agent.command,
    agentModel: config.agent.model,
    skillDir: path.join(PACKAGE_ROOT, 'skill'),
  };
}

/** Minimal `--flag value` / `--flag` (boolean) / positional argv parser —
 * this CLI's needs (a handful of named flags, a list of file/dir
 * positionals) don't justify a dependency. A value is only consumed for a
 * flag when the next token doesn't itself look like a flag, so a trailing
 * boolean flag never swallows the next positional. */
function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function phaseLine(deps, phase, counts, partialPath) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  deps.stdout.write(`[${new Date(now).toISOString()}] osstrich ${phase}: ${counts} → ${partialPath}\n`);
}

/** Printed instead of `phaseLine` when `--resume` finds a phase's partial
 * already present and skips redoing the work — one line per skipped
 * phase, so a resumed run's transcript accounts for every phase even when
 * nothing actually ran. */
function skipLine(deps, phase) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  deps.stdout.write(`[${new Date(now).toISOString()}] osstrich ${phase}: skipped (partial present)\n`);
}

/** Print every entry of a phase's own `gaps[]` (distinct from
 * `inventory.json`'s own carried-through gaps, which the CLI never
 * re-prints) — one line per gap, right after that phase's summary line. */
function printPhaseGaps(deps, verb, gaps) {
  for (const gap of gaps || []) {
    deps.stdout.write(`osstrich ${verb} gap: ${JSON.stringify(gap)}\n`);
  }
}

function readPartial(fs, dir, phase) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${phase}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function readOptionalFile(fs, filePath) {
  try {
    return { text: fs.readFileSync(filePath, 'utf8') };
  } catch {
    return { text: '' };
  }
}

/** Run one phase's work and persist its partial, skipping the work
 * entirely when `resume` is set and a partial already exists — the same
 * skip rule `discover` and every standalone phase command share, printing
 * one `skipped (partial present)` line so a resumed run's transcript
 * accounts for the phase even when nothing ran.
 *
 * `readExisting`/`write` let a phase whose on-disk shape isn't a bare
 * `<phase>.json` (the verdict phase writes only `verdict-template.md`, no
 * JSON companion) plug into the same resume contract as every other
 * phase — see `cmdDiscover`'s verdict step. Both default to the ordinary
 * JSON-partial behavior every other phase already uses. */
async function ensurePhase({ dir, deps, phase, verb, resume, run, readExisting, write }) {
  if (resume) {
    const existing = readExisting ? readExisting() : readPartial(deps.fs, dir, phase);
    if (existing) {
      skipLine(deps, verb ?? phase);
      return { data: existing, ranNow: false };
    }
  }
  const data = await run();
  if (write) {
    await write(data);
  } else {
    await deps.writePartial(dir, phase, data, { fs: deps.fs });
  }
  return { data, ranNow: true };
}

/** `rank.bottom` is a plain array of project NAME strings (`lib/rank.mjs`'s
 * own contract: `rows.slice(0, bottomN).map((row) => row.name)`), never row
 * objects — the verdict template's one column we can fill by construction
 * is the name. */
function renderVerdictTemplate(names) {
  const header = '| Project | Fixes for us | Gives back | Cost | Owner | Ruling |\n|---|---|---|---|---|---|';
  if (names.length === 0) return `${header}\n`;
  const body = names.map((name) => `| ${name} |  |  |  |  |  |`).join('\n');
  return `${header}\n${body}\n`;
}

function readPrsOpened(fs, filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const firstLine = (text.split(/\r?\n/, 1)[0] || '').trim();
    const m = /^prs_opened:\s*(\d+)/.exec(firstLine);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function requireAgent(deps, command) {
  if (!deps.agentCommand) {
    throw new OsstrichError('AGENT', `${command}: no agent command configured`, { hint: 'run osstrich init' });
  }
}

/** The D1-D3 phase table `cmdDiscover` and `cmdPhase` both drive through
 * `runPhases` below. Each entry is self-contained: `prereqs` names its own
 * dependency phases (key + CLI verb, for a clear "run X first" message),
 * `run(dir, results)` computes it from the prior phases' data (`results`,
 * keyed by phase key), and `summary(data)` renders its phase-line counts,
 * always ending in `gaps=<N>` — the phase's own gaps count. `bottomN` is
 * closed over for `rank` since only `cmdDiscover`/`cmdPhase("rank")` ever
 * supply it. */
function buildPhaseTable(deps, { bottomN } = {}) {
  return [
    {
      key: 'inventory',
      verb: 'inventory',
      prereqs: [],
      run: () => deps.collectInventory({ repoRoot: deps.repoRoot, fs: deps.fs, exec: deps.exec, fetch: deps.fetch }),
      summary: (data) => `projects=${data.projects?.length ?? 0} gaps=${data.gaps?.length ?? 0}`,
    },
    {
      key: 'rank',
      verb: 'rank',
      prereqs: [{ key: 'inventory', verb: 'inventory' }],
      run: async (_dir, results) => {
        const classificationMarkdown = readOptionalFile(deps.fs, deps.classificationPath).text;
        const result = await deps.rankProjects(results.inventory, classificationMarkdown, { bottomN });
        const markdown = await deps.renderRankMarkdown(result);
        return { ...result, markdown };
      },
      summary: (data) => `bottom=${data.bottom?.length ?? 0} gaps=${data.gaps?.length ?? 0}`,
      afterRun: (data) => printPhaseGaps(deps, 'rank', data.gaps),
    },
    {
      key: 'inferred',
      verb: 'infer',
      prereqs: [{ key: 'inventory', verb: 'inventory' }],
      run: (_dir, results) => deps.inferNextSteps({ repoRoot: deps.repoRoot, fs: deps.fs, projects: results.inventory.projects || [] }),
      summary: (data) => `projects_with_hits=${Object.keys(data?.byProject || {}).length} gaps=${data.gaps?.length ?? 0}`,
    },
    {
      key: 'shortlist',
      verb: 'upstream',
      prereqs: [
        { key: 'inventory', verb: 'inventory' },
        { key: 'inferred', verb: 'infer' },
      ],
      run: (_dir, results) => deps.shortlistUpstream({ projects: results.inventory.projects || [], inferred: results.inferred?.byProject, exec: deps.exec }),
      summary: (data) => `checked=${data.budget?.checked ?? 0} gaps=${data.gaps?.length ?? 0}`,
    },
  ];
}

/** Ensure every phase in `phases`, in order, up to and including the one
 * named `upTo`, printing its phase line the moment it actually runs. A
 * phase's own `prereqs` not already in `results` (because `phases` doesn't
 * include them — the standalone `cmdPhase` case) must already have a
 * partial on disk; missing one short-circuits with `{ error }` instead of
 * running anything. `cmdDiscover` passes the full table so every prereq is
 * always satisfied by the same loop's own earlier iterations. */
async function runPhases(dir, phases, deps, upTo, { resume } = {}) {
  const upToIndex = phases.findIndex((p) => p.key === upTo);
  const results = {};
  for (let i = 0; i <= upToIndex; i++) {
    const phase = phases[i];
    for (const prereq of phase.prereqs) {
      if (results[prereq.key] !== undefined) continue;
      const existing = readPartial(deps.fs, dir, prereq.key);
      if (!existing) return { error: `${phase.verb}: missing ${prereq.key}.json in ${dir} — run ${prereq.verb} first` };
      results[prereq.key] = existing;
    }
    const { data, ranNow } = await ensurePhase({ dir, deps, phase: phase.key, verb: phase.verb, resume, run: () => phase.run(dir, results) });
    results[phase.key] = data;
    if (ranNow) {
      phaseLine(deps, phase.verb, phase.summary(data), path.join(dir, `${phase.key}.json`));
      if (phase.afterRun) phase.afterRun(data);
    }
  }
  return { results };
}

async function cmdDiscover(args, deps) {
  const { flags } = parseArgs(args);
  const slug = typeof flags.slug === 'string' ? flags.slug : 'discover';
  if (!SLUG_RE.test(slug)) {
    deps.stdout.write(USAGE);
    return 2;
  }
  const bottomN = flags.bottom !== undefined ? Number(flags.bottom) : undefined;
  const resume = Boolean(flags.resume);
  const table = Boolean(flags.table);

  deps.stdout.write(`osstrich: config ${deps.configPath || 'no config'}\n`);
  const { dir } = await deps.openRun({ runsDir: deps.runsDir, slug, fs: deps.fs, resume });

  const { results, error } = await runPhases(dir, buildPhaseTable(deps, { bottomN }), deps, 'shortlist', { resume });
  if (error) {
    deps.stdout.write(`${error}\n`);
    return 1;
  }
  const { inventory, rank, shortlist } = results;

  const candidateNames = (rank.bottom || []).filter((name) => (shortlist.byProject?.[name]?.matches?.length ?? 0) > 0);

  if (table) {
    const verdictPath = path.join(dir, 'verdict-template.md');
    const { ranNow: verdictRanNow } = await ensurePhase({
      dir,
      deps,
      phase: 'verdict',
      verb: 'verdict',
      resume,
      readExisting: () => {
        try {
          return { markdown: deps.fs.readFileSync(verdictPath, 'utf8') };
        } catch {
          return null;
        }
      },
      run: () => ({ markdown: renderVerdictTemplate(candidateNames) }),
      write: (data) => deps.fs.writeFileSync(verdictPath, data.markdown),
    });
    if (verdictRanNow) {
      const incomplete = inventory.status === 'incomplete' ? ' incomplete' : '';
      phaseLine(deps, 'verdict', `candidates=${candidateNames.length}${incomplete}`, verdictPath);
    }

    await deps.finishRun(
      dir,
      { projects_inventoried: inventory.projects?.length ?? 0, bottom_n: rank.bottom?.length ?? 0, candidates: candidateNames.length },
      { fs: deps.fs, onRunEnd: deps.onRunEnd },
    );

    // Candidates are output, not a failure — this command completed either
    // way. Exit 1 is reserved for scrub findings; exit 2 for a real failure.
    return 0;
  }

  requireAgent(deps, 'osstrich discover');

  const verdictResult = await deps.runAgentStage({
    stage: 'verdict',
    prompt: overlapVerdictGate({ runDir: dir, skillDir: deps.skillDir }),
    cwd: deps.repoRoot,
    command: deps.agentCommand,
    model: deps.agentModel,
    env: deps.env,
    runDir: dir,
    exec: deps.exec,
  });
  if (!verdictResult.ok) {
    throw new OsstrichError('AGENT', `osstrich discover: verdict stage failed, see ${verdictResult.logPath}`, {
      hint: `inspect ${verdictResult.logPath}`,
    });
  }

  let verdictRaw;
  try {
    verdictRaw = JSON.parse(deps.fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8'));
  } catch (e) {
    markPhase(dir, { stage: 'verdict', state: 'failed', error: `verdict.json unreadable: ${e.message}` }, { fs: deps.fs });
    throw new OsstrichError('AGENT', `osstrich discover: verdict.json unreadable: ${e.message}`, {
      hint: `check ${path.join(dir, 'verdict.json')}`,
    });
  }
  const parsed = VerdictSchema.safeParse(verdictRaw);
  if (!parsed.success) {
    markPhase(dir, { stage: 'verdict', state: 'failed', error: `verdict.json failed validation: ${parsed.error.message}` }, { fs: deps.fs });
    throw new OsstrichError('AGENT', `osstrich discover: verdict.json failed validation: ${parsed.error.message}`, {
      hint: `check ${path.join(dir, 'verdict.json')}`,
    });
  }
  const verdict = parsed.data;

  const pickerRows = verdict.rows.map((row) => ({ name: row.name, ruling: row.ruling, evidence: row.evidence.length, combinedRank: row.combinedRank }));
  const headless = Boolean(flags.headless) || !deps.isTTY;
  const picked = await pickCandidates({ rows: pickerRows, headless, prompts: deps.prompts, stdout: deps.stdout });
  const pickedRows = picked.map((p) => verdict.rows.find((row) => row.name === p.name)).filter(Boolean);

  let prsOpened = 0;
  for (const row of pickedRows) {
    const slug2 = slugFor(row);
    // eslint-disable-next-line no-await-in-loop -- builds run sequentially by design (see USAGE)
    const buildResult = await deps.runAgentStage({
      stage: `build-${slug2}`,
      prompt: buildPrompt({ runDir: dir, skillDir: deps.skillDir, target: row }),
      cwd: deps.repoRoot,
      command: deps.agentCommand,
      model: deps.agentModel,
      env: deps.env,
      runDir: dir,
      exec: deps.exec,
    });
    if (buildResult.ok) {
      prsOpened += readPrsOpened(deps.fs, path.join(dir, `build-${slug2}.md`));
    }
  }

  await deps.finishRun(
    dir,
    {
      projects_inventoried: inventory.projects?.length ?? 0,
      bottom_n: rank.bottom?.length ?? 0,
      candidates: verdict.rows.length,
      funded: verdict.rows.filter((r) => r.ruling === 'fund').length,
      deferred: verdict.rows.filter((r) => r.ruling === 'defer').length,
      give_back_only: verdict.rows.filter((r) => r.ruling === 'give-back').length,
      gate_migrated: verdict.rows.filter((r) => r.gate === 'migrate').length,
      gate_upstream: verdict.rows.filter((r) => r.gate === 'upstream').length,
      prs_opened: prsOpened,
    },
    { fs: deps.fs, onRunEnd: deps.onRunEnd },
  );

  return 0;
}

/** Maps a standalone CLI verb to its phase-table key (`infer`/`upstream`
 * differ from their own `inferred`/`shortlist` partial file names — see the
 * module doc's "partial file names vs. subcommand names"). */
const PHASE_KEY_FOR_VERB = { inventory: 'inventory', rank: 'rank', infer: 'inferred', upstream: 'shortlist' };

/** The four standalone single-phase subcommands (`inventory | rank | infer
 * | upstream`). Each opens (or reuses, via --dir/--resume) a run directory,
 * then runs exactly its own phase through `runPhases` — which checks that
 * phase's own prerequisite partials already exist and errors, exit 1,
 * rather than silently proceeding on missing input. */
async function cmdPhase(name, args, deps) {
  const { flags } = parseArgs(args);
  const resume = Boolean(flags.resume);
  let dir = typeof flags.dir === 'string' ? flags.dir : null;
  if (!dir) {
    const slug = typeof flags.slug === 'string' ? flags.slug : name;
    if (!SLUG_RE.test(slug)) {
      deps.stdout.write(USAGE);
      return 2;
    }
    const opened = await deps.openRun({ runsDir: deps.runsDir, slug, fs: deps.fs, resume });
    dir = opened.dir;
  }

  const bottomN = flags.bottom !== undefined ? Number(flags.bottom) : undefined;
  const targetKey = PHASE_KEY_FOR_VERB[name];
  const targetPhase = buildPhaseTable(deps, { bottomN }).find((p) => p.key === targetKey);
  const { error } = await runPhases(dir, [targetPhase], deps, targetKey, { resume });
  if (error) {
    deps.stdout.write(`${error}\n`);
    return 1;
  }
  return 0;
}

/** The only flag `scrub` recognizes. `--help` (or any other unknown flag)
 * must never fall through into "no --text, scrub zero positional paths,
 * report 0 findings" — that reads identically to a genuinely clean scan of
 * real input, so it prints the usage text and exits 2 instead of scanning
 * nothing. */
const SCRUB_ALLOWED_FLAGS = new Set(['text']);

async function cmdScrub(args, deps) {
  const { flags, positional } = parseArgs(args);
  if (Object.keys(flags).some((key) => !SCRUB_ALLOWED_FLAGS.has(key))) {
    deps.stdout.write(USAGE);
    return 2;
  }
  const termsText = readOptionalFile(deps.fs, deps.termsPath).text;
  let result;
  if (typeof flags.text === 'string') {
    result = await deps.scrubText({ text: flags.text, termsText, exec: deps.exec, fs: deps.fs, repoRoot: deps.repoRoot });
  } else {
    result = await deps.scrubPaths({ paths: positional, termsText, exec: deps.exec, fs: deps.fs, repoRoot: deps.repoRoot });
  }
  // `scrubText`/`scrubPaths` return `{ ok: false, error }` on a genuine scan
  // failure (missing gitleaks binary, timeout, malformed config) — distinct
  // from `{ ok: false, findings: [...] }` on a dirty-but-successful scan,
  // which never carries an `error`. Treating a failed scan as "0 findings,
  // exit 0" would fail the whole leak gate open; instead it prints to
  // stderr and exits 2, distinct from exit 1 ("findings present") and exit
  // 0 ("clean").
  if (result.ok === false && result.error) {
    deps.stderr.write(`osstrich scrub: FAILED — ${result.error}\n`);
    return 2;
  }
  const findings = result.findings || [];
  for (const finding of findings) deps.stdout.write(`${JSON.stringify(finding)}\n`);
  deps.stdout.write(`osstrich scrub: ${findings.length} finding(s)\n`);
  return findings.length > 0 ? 1 : 0;
}

async function cmdRecheck(args, deps) {
  const { positional } = parseArgs(args);
  const claims = await deps.extractClaims({ files: positional, fs: deps.fs });
  const result = await deps.recheckClaims({ claims, exec: deps.exec });
  for (const bucket of ['fired', 'contradicted', 'unconfirmable', 'current']) {
    const items = result?.[bucket] || [];
    deps.stdout.write(`${bucket}: ${items.length}\n`);
    for (const item of items) deps.stdout.write(`  ${JSON.stringify(item)}\n`);
  }
  return 0;
}

const RECORD_FLAG_FIELDS = [
  'projects_inventoried',
  'bottom_n',
  'candidates',
  'funded',
  'deferred',
  'give_back_only',
  'gate_migrated',
  'gate_upstream',
  'prs_opened',
  'review_rounds',
  'fork_patches_retired',
  'hand_patches_retired',
];

async function cmdRecord(args, deps) {
  const { flags } = parseArgs(args);
  if (typeof flags.dir !== 'string') {
    deps.stdout.write('record: --dir <runDir> is required\n');
    return 2;
  }
  const record = {};
  for (const field of RECORD_FLAG_FIELDS) {
    if (flags[field] !== undefined) record[field] = Number(flags[field]);
  }
  const recordPath = await deps.finishRun(flags.dir, record, { fs: deps.fs, onRunEnd: deps.onRunEnd });
  deps.stdout.write(`osstrich record: wrote ${recordPath}\n`);
  return 0;
}

/** Every existing `<date>-<slug>-attempt-<N>` directory directly under
 * `runsDir`, newest first (by directory name, which sorts correctly since
 * the date prefix is ISO and attempt numbers share a width-free but
 * monotonic suffix within a day). */
function listRunDirs(fs, runsDir) {
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (typeof entry.isDirectory === 'function' ? entry.isDirectory() : true))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

function findNewestRunWithVerdict(fs, runsDir) {
  for (const name of listRunDirs(fs, runsDir)) {
    const dir = path.join(runsDir, name);
    if (fs.existsSync(path.join(dir, 'verdict.json'))) return dir;
  }
  return null;
}

async function runBuildStage({ dir, target, deps }) {
  const slug = slugFor(target);
  const result = await deps.runAgentStage({
    stage: `build-${slug}`,
    prompt: buildPrompt({ runDir: dir, skillDir: deps.skillDir, target }),
    cwd: deps.repoRoot,
    command: deps.agentCommand,
    model: deps.agentModel,
    env: deps.env,
    runDir: dir,
    exec: deps.exec,
  });
  if (!result.ok) {
    throw new OsstrichError('AGENT', `osstrich build: build stage failed, see ${result.logPath}`, { hint: `inspect ${result.logPath}` });
  }
  const prsOpened = readPrsOpened(deps.fs, path.join(dir, `build-${slug}.md`));
  await deps.finishRun(dir, { prs_opened: prsOpened }, { fs: deps.fs, onRunEnd: deps.onRunEnd });
  return { slug };
}

async function cmdBuild(args, deps) {
  const { positional } = parseArgs(args);
  const target = positional[0];

  requireAgent(deps, 'osstrich build');

  if (target) {
    const slug = slugFor(target);
    if (!SLUG_RE.test(slug)) {
      deps.stdout.write(USAGE);
      return 2;
    }
    const { dir } = await deps.openRun({ runsDir: deps.runsDir, slug, fs: deps.fs });
    await runBuildStage({ dir, target, deps });
    return 0;
  }

  const runDir = findNewestRunWithVerdict(deps.fs, deps.runsDir);
  if (!runDir) {
    throw new OsstrichError('AGENT', 'osstrich build: no funded row left', { hint: 'run osstrich discover' });
  }
  let verdictRaw;
  try {
    verdictRaw = JSON.parse(deps.fs.readFileSync(path.join(runDir, 'verdict.json'), 'utf8'));
  } catch {
    verdictRaw = { rows: [] };
  }
  const status = (() => {
    try {
      return JSON.parse(deps.fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
    } catch {
      return { phases: [] };
    }
  })();
  const builtSlugs = new Set((status.phases || []).filter((p) => p.stage.startsWith('build-') && p.state === 'done').map((p) => p.stage.slice('build-'.length)));
  const fundedRows = (verdictRaw.rows || []).filter((r) => r.ruling === 'fund');
  const nextRow = fundedRows.find((r) => !builtSlugs.has(slugFor(r)));
  if (!nextRow) {
    throw new OsstrichError('AGENT', 'osstrich build: no funded row left', { hint: 'run osstrich discover' });
  }
  await runBuildStage({ dir: runDir, target: nextRow, deps });
  return 0;
}

/**
 * @param {string[]} argv — subcommand + its own args.
 * @param {object} rawDeps — either the resolved deps shape (see
 *   `defaultDeps()`) or the thinner shape `bin/osstrich.mjs` builds, in
 *   which case `defaultDeps(rawDeps)` fills in the rest.
 * @returns {Promise<number>} process exit code. Any throw during dispatch —
 *   including one raised while `defaultDeps()` itself resolves the rest of
 *   `deps` (a config error, say) — prints `osstrich <cmd>: FAILED —
 *   <message>` (plus the error's `hint`, if any) to stderr and resolves to
 *   2, rather than an unhandled rejection escaping `main()` before a
 *   command was ever entered.
 */
export async function main(argv, rawDeps) {
  const [command, ...rest] = argv;
  const fallbackStderr = rawDeps && rawDeps.stderr ? rawDeps.stderr : { write: (s) => process.stderr.write(s) };
  let deps;
  try {
    deps = typeof rawDeps.collectInventory === 'function' ? rawDeps : await defaultDeps(rawDeps);
  } catch (error) {
    fallbackStderr.write(formatFailure(command ?? 'run', error));
    return 2;
  }
  try {
    switch (command) {
      case 'discover':
        return await cmdDiscover(rest, deps);
      case 'inventory':
      case 'rank':
      case 'infer':
      case 'upstream':
        return await cmdPhase(command, rest, deps);
      case 'build':
        return await cmdBuild(rest, deps);
      case 'scrub':
        return await cmdScrub(rest, deps);
      case 'recheck':
        return await cmdRecheck(rest, deps);
      case 'record':
        return await cmdRecord(rest, deps);
      default:
        deps.stdout.write(USAGE);
        return 2;
    }
  } catch (error) {
    deps.stderr.write(formatFailure(command ?? 'run', error));
    return 2;
  }
}
