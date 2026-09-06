// The two judgment-stage prompts a headless coding agent runs under
// lib/agent.mjs's runAgentStage: the discover pipeline's verdict gate, and
// the build stage that both `discover` (per funded row) and `osstrich
// build <target>` reuse. No external template files — every word here is
// the whole prompt.
import path from 'node:path';

function slugPiece(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Exported so lib/cli-core.mjs derives the exact same `build-<slug>.md`
// name this module's own `build()` prompt tells the agent to write — one
// slugger, never two that could quietly drift apart.
export function slugFor(target) {
  if (target && typeof target === 'object') {
    return slugPiece(target.name || target.repo || 'target').slice(0, 64) || 'target';
  }
  const text = String(target ?? 'target');
  let m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(text);
  if (m) return slugPiece(`${m[1]}-${m[2]}-${m[3]}`).slice(0, 64) || 'target';
  m = /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/.exec(text);
  if (m) return slugPiece(`${m[1]}-${m[2]}-${m[3]}`).slice(0, 64) || 'target';
  return slugPiece(text).slice(0, 64) || 'target';
}

/**
 * D4's overlap + gate judgment: read the run's own phase partials, rule
 * fund/defer/skip/give-back per project, and write the machine-readable
 * verdict plus a human-skimmable table.
 */
export function overlapVerdictGate({ runDir, skillDir }) {
  return `Read ${path.join(skillDir, 'SKILL.md')} and ${path.join(skillDir, 'references/discover.md')} for how this judgment works — the gate (is there a different way of using the library that makes the upstream fix optional?), the fund/defer/skip/give-back rules, and the evidence boxes.

This run directory's own phase output is already on disk — read it, don't re-derive it:
  ${path.join(runDir, 'inventory.json')}
  ${path.join(runDir, 'rank.md')}
  ${path.join(runDir, 'inferred.json')}
  ${path.join(runDir, 'shortlist.json')}

For every bottom-N project with an upstream match in shortlist.json, rule:
  fund      — one of our own next steps overlaps this item AND at least one evidence box is ticked
  defer     — overlap exists but no evidence box ticked, or the fix is out of proportion
  skip      — no overlap and nothing worth giving back
  give-back — no overlap, but the item is worth offering anyway (only when nothing above funds)

Then apply the gate to every funded or give-back row: is there a different way of using the library, verified against its own source (never an identifier's name), that makes the upstream fix optional? If yes, set gate to "migrate" — the deliverable becomes our own migration, not an upstream PR. If the fix genuinely requires upstream, set gate to "upstream". Rows that are deferred or skipped carry gate: null.

Write ${path.join(runDir, 'verdict.json')} as exactly this shape, one row per project judged:
{"rows":[{"name": "<project name>", "repo": "<owner/repo>", "ruling": "fund"|"defer"|"skip"|"give-back", "item": "<the upstream issue/PR or gap, one line>", "need": "<our own next step this overlaps, one line>", "evidence": ["reproduction"|"patch"|"production"|"measurement", ...], "gate": "upstream"|"migrate"|null, "combinedRank": <number, from rank.md's combined rank for this project>}]}

Also write ${path.join(runDir, 'verdict.md')}: the same rows as a markdown table (project, fixes for us, gives back, cost, owner, ruling) for a human to skim — verdict.json is the one this run reads back, verdict.md is the one a person reads.`;
}

/**
 * Runs one contribution — investigate, build, test, open the PR — against
 * either a named target (an `osstrich build <target>` invocation) or a
 * verdict row `discover` picked. The gate (same question as above) lives
 * inside this prompt too: a build stage that discovers the fix is better
 * done as our own migration reports that instead of opening a PR.
 */
export function build({ runDir, skillDir, target }) {
  const slug = slugFor(target);
  const targetDescription =
    target && typeof target === 'object'
      ? [
          'Target (a funded row from this run\'s own verdict):',
          `  name: ${target.name}`,
          `  repo: ${target.repo}`,
          `  item: ${target.item}`,
          `  need: ${target.need}`,
          `  evidence: ${JSON.stringify(target.evidence ?? [])}`,
          `  gate: ${target.gate ?? 'none'}`,
        ].join('\n')
      : `Target: ${target}`;

  return `Read ${path.join(skillDir, 'references/investigate.md')}, ${path.join(skillDir, 'references/build-and-test.md')}, and ${path.join(skillDir, 'references/pr-etiquette.md')} for the full plan-to-PR process: frame the target, scout the target repo's own conventions, reproduce the defect live before writing the fix, build the smallest tested patch, then write and post the PR in the maintainer's own norms.

${targetDescription}

Before building anything, re-check the gate: is there a different way of using the library, verified against its source, that makes the upstream fix unnecessary? If yes, do that migration in OUR repo instead and never open an upstream PR — record that outcome in the file below. Otherwise proceed to the upstream contribution.

No code before a stated green-light on your short plan (target repo, symptom, suspected root cause). Every PR body, commit, and branch name is scrubbed for personal/internal information before anything is pushed anywhere external — see pr-etiquette.md → Scrubbing.

When you open a pull request, its body MUST include this exact marker line so the run is traceable back to here:
Opened with osstrich · run ${path.basename(runDir)}

Write ${path.join(runDir, `build-${slug}.md`)} when this stage is done. Its FIRST line must be exactly \`prs_opened: N\` — the number of pull requests this stage actually opened (0 if the gate sent this to a migration instead, or if nothing was opened yet) — followed by whatever summary of the work is useful.`;
}
