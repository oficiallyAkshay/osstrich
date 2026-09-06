// Turns a discover run's verdict rows into the set of candidates `build`
// should actually run against. Interactive sessions get a checklist over
// the funded rows; headless runs (or anything without a TTY) get the single
// best funded row, deterministically ordered.

export function isFunded(row) {
  return row.ruling === 'fund';
}

// Most evidence first; ties broken by the lower combined rank.
export function orderCandidates(rows) {
  return [...rows].sort((a, b) => {
    if (b.evidence !== a.evidence) return b.evidence - a.evidence;
    return a.combinedRank - b.combinedRank;
  });
}

function renderTable(rows, stdout) {
  stdout.write('name\truling\tevidence\trank\n');
  for (const row of rows) {
    stdout.write(`${row.name}\t${row.ruling}\t${row.evidence}\t${row.combinedRank}\n`);
  }
}

export async function pickCandidates({ rows, headless, prompts, stdout }) {
  const funded = rows.filter(isFunded);

  if (headless) {
    if (funded.length === 0) {
      stdout.write('no funded candidate\n');
      return [];
    }
    return [orderCandidates(funded)[0]];
  }

  renderTable(rows, stdout);

  if (funded.length === 0) {
    stdout.write('no funded candidate\n');
    return [];
  }

  const selection = await prompts.multiselect({
    message: 'Select candidates to build',
    options: funded.map((row) => ({
      value: row.name,
      label: `${row.name} (${row.ruling}, evidence ${row.evidence}, rank ${row.combinedRank})`,
    })),
  });

  if (prompts.isCancel(selection)) {
    return [];
  }

  const chosen = new Set(selection);
  return orderCandidates(funded.filter((row) => chosen.has(row.name)));
}
