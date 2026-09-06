// The .osstrich.json config contract. Every key is optional; loadConfig
// fills in defaults, expands ~ and ${VAR} / ${VAR:-default} in string
// values, resolves relative paths against repoRoot, and lets a handful of
// env vars win over whatever the file says.
import path from 'node:path';
import { z } from 'zod';
import { OsstrichError } from './errors.mjs';

/** Directories no repo-wide osstrich scan should ever descend into, absent
 * a consumer's own `skipDirs` override. */
export const DEFAULT_SKIP_DIRS = ['node_modules', '.git', 'coverage', 'dist', 'build'];
const DEFAULT_MAX_FILE_BYTES = 262144;
const DEFAULT_STATE_DIR = '~/.osstrich';

/** A named CONFIG-code error for anything wrong with `.osstrich.json` or its
 * resolved values — malformed JSON, a schema mismatch, or a stateDir that
 * resolves inside the repo. Always an `OsstrichError` too (`code ===
 * 'CONFIG'`), so existing `instanceof OsstrichError` checks keep working. */
export class OsstrichConfigError extends OsstrichError {
  constructor(message, opts) {
    super('CONFIG', message, opts);
    this.name = 'OsstrichConfigError';
  }
}

const ConfigSchema = z.object({
  stateDir: z.string().optional(),
  classification: z.string().optional(),
  scrubTerms: z.string().optional(),
  hosts: z.string().optional(),
  ignore: z.array(z.string()).optional(),
  skipDirs: z.array(z.string()).optional(),
  stopwords: z.array(z.string()).optional(),
  maxFileBytes: z.number().optional(),
  hooks: z
    .object({
      runEnd: z.string().nullable().optional(),
    })
    .optional(),
  agent: z
    .object({
      command: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
    })
    .optional(),
});

function configFilePath(repoRoot) {
  return path.join(repoRoot, '.osstrich.json');
}

function readRawConfig(filePath, fs) {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new OsstrichConfigError(`Malformed JSON in ${filePath}: ${err.message}`, {
      cause: err,
      hint: `Fix or remove ${filePath} and re-run.`,
    });
  }
}

function validate(raw, filePath) {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new OsstrichConfigError(`Invalid config in ${filePath}: ${result.error.message}`, {
      cause: result.error,
      hint: `Check the types of the keys in ${filePath}.`,
    });
  }
  return result.data;
}

// Expand a leading `~` (home directory) and `${VAR}` / `${VAR:-default}`
// references against `env`. Order matters: tilde first, then env vars, so
// `${HOME}` style references still resolve correctly either way.
export function expandString(value, { env, homedir }) {
  let out = value;
  if (out === '~') {
    out = homedir;
  } else if (out.startsWith('~/')) {
    out = path.join(homedir, out.slice(2));
  }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_match, name, _hasDefault, def) => {
    const envValue = env[name];
    if (envValue !== undefined && envValue !== '') return envValue;
    return def !== undefined ? def : '';
  });
  return out;
}

function resolvePath(value, repoRoot) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

// discover.md's run-directory invariant is "never inside the repo" — a
// run's partials can carry upstream issue/PR text, not just our own code,
// so they must never land somewhere `git add .` could pick them up. A
// relative stateDir resolves against repoRoot by construction (see
// `resolvePath` above), which would silently violate that invariant instead
// of catching it — so the resolved stateDir is checked here instead: it
// must be absolute AND neither equal to nor nested inside repoRoot.
function resolveStateDir(rawValue, { env, homedir, repoRoot }) {
  const expanded = expandString(rawValue, { env, homedir });
  if (typeof expanded !== 'string' || expanded === '') return expanded;
  if (!path.isAbsolute(expanded)) {
    throw new OsstrichConfigError(
      `invalid stateDir ${JSON.stringify(rawValue)} (resolved to ${JSON.stringify(expanded)}): state dir must be absolute and outside the repository`,
    );
  }
  const normalizedRepoRoot = path.resolve(repoRoot);
  const normalizedState = path.resolve(expanded);
  if (normalizedState === normalizedRepoRoot || normalizedState.startsWith(`${normalizedRepoRoot}${path.sep}`)) {
    throw new OsstrichConfigError(
      `invalid stateDir ${JSON.stringify(rawValue)} (resolved to ${JSON.stringify(normalizedState)}): state dir must be absolute and outside the repository`,
    );
  }
  return normalizedState;
}

export function loadConfig({ repoRoot, fs, env, homedir }) {
  const filePath = configFilePath(repoRoot);
  const raw = readRawConfig(filePath, fs);
  const data = validate(raw, filePath);

  const ctx = { env, homedir, repoRoot };
  const stateDir = env.OSSTRICH_STATE_DIR
    ? resolveStateDir(env.OSSTRICH_STATE_DIR, ctx)
    : resolveStateDir(data.stateDir ?? DEFAULT_STATE_DIR, ctx);

  const resolveOptionalFile = (key, defaultRelPath) => {
    const rawValue = data[key] ?? defaultRelPath;
    const resolved = resolvePath(expandString(rawValue, { env, homedir }), repoRoot);
    return fs.existsSync(resolved) ? resolved : null;
  };

  const classification = resolveOptionalFile('classification', '.osstrich/classification.md');
  const scrubTerms = resolveOptionalFile('scrubTerms', '.osstrich/scrub-terms.txt');
  const hosts = resolveOptionalFile('hosts', '.osstrich/hosts.md');

  const runEndRaw = data.hooks?.runEnd ?? null;
  const hooks = {
    runEnd: runEndRaw ? expandString(runEndRaw, { env, homedir }) : null,
  };

  const agentCommandRaw = env.OSSTRICH_AGENT || data.agent?.command || null;
  const agentModelRaw = env.OSSTRICH_MODEL || data.agent?.model || null;
  const agent = {
    command: agentCommandRaw ? expandString(agentCommandRaw, { env, homedir }) : null,
    model: agentModelRaw ? expandString(agentModelRaw, { env, homedir }) : null,
  };

  return {
    repoRoot,
    configPath: filePath,
    stateDir,
    classification,
    scrubTerms,
    hosts,
    ignore: data.ignore ?? [],
    skipDirs: data.skipDirs ?? [...DEFAULT_SKIP_DIRS],
    stopwords: data.stopwords ?? [],
    maxFileBytes: data.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    hooks,
    agent,
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function saveConfig({ repoRoot, fs, patch }) {
  const filePath = configFilePath(repoRoot);
  const raw = readRawConfig(filePath, fs);
  const merged = deepMerge(raw, patch);
  validate(merged, filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
