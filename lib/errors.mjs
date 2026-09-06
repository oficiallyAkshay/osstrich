// Typed error for every osstrich failure path. bin/osstrich.mjs maps
// OsstrichError -> exit 2 (plus its hint on stderr); unknown throws also
// map to 2. Codes are intentionally coarse: CONFIG, ENV, AGENT, GH, SCRUB, STATE.

export const ERROR_CODES = ['CONFIG', 'ENV', 'AGENT', 'GH', 'SCRUB', 'STATE'];

export class OsstrichError extends Error {
  constructor(code, message, { cause, hint } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OsstrichError';
    if (!ERROR_CODES.includes(code)) {
      throw new Error(`OsstrichError: unknown code "${code}"`);
    }
    this.code = code;
    this.hint = hint ?? null;
  }
}

// The one "osstrich <command>: FAILED — <message>" formatter — shared by
// bin/osstrich.mjs's outer catch and lib/cli-core.mjs's own main(), which
// print the identical text whether an OsstrichError escapes cli-core.mjs
// or is caught inside it first.
export function formatFailure(command, error) {
  const message = error instanceof Error ? error.message : String(error);
  let out = `osstrich ${command}: FAILED — ${message}\n`;
  if (error instanceof OsstrichError && error.hint) {
    out += `${error.hint}\n`;
  }
  return out;
}
