// A run's status.json: one record per phase, keyed by `stage`. Written
// atomically (temp file + rename) so a reader never sees a half-written
// file. `fs` is injectable for tests; every real caller lets it default to
// node:fs.
import nodeFs from 'node:fs';
import path from 'node:path';

const STATUS_FILE = 'status.json';

function resolveFs(deps) {
  return deps.fs ?? nodeFs;
}

export function statusFilePath(runDir) {
  return path.join(runDir, STATUS_FILE);
}

export function readStatus(runDir, deps = {}) {
  const fs = resolveFs(deps);
  const filePath = statusFilePath(runDir);
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

export function writeStatus(runDir, status, deps = {}) {
  const fs = resolveFs(deps);
  fs.mkdirSync(runDir, { recursive: true });
  const filePath = statusFilePath(runDir);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(status, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
  return status;
}

// Upserts one phase record (matched by `record.stage`) into the run's
// status.json and writes the whole file back atomically.
export function markPhase(runDir, record, deps = {}) {
  const current = readStatus(runDir, deps) ?? { phases: [] };
  const phases = current.phases ?? [];
  const idx = phases.findIndex((phase) => phase.stage === record.stage);
  const merged = idx === -1 ? record : { ...phases[idx], ...record };
  const nextPhases = idx === -1 ? [...phases, merged] : phases.map((phase, i) => (i === idx ? merged : phase));
  const nextStatus = { ...current, phases: nextPhases, updatedAt: new Date().toISOString() };
  return writeStatus(runDir, nextStatus, deps);
}
