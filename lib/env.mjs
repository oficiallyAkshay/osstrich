// Loads `<repoRoot>/.env` (dotenvx-aware: handles an encrypted file
// transparently the same way `dotenvx run` would) and returns a merged env
// object. Never mutates process.env — callers decide what to do with the
// result. Only the settings osstrich itself reads (FILE_VARS) come over from
// the file: the merged env reaches the headless agent, which reads strangers'
// issue text, so any other secret in the file stays out. Variables already in
// `env` pass through unchanged.
import path from 'node:path';
import { config as dotenvxConfig } from '@dotenvx/dotenvx';
import { PROVIDER_VAR } from './agent-registry.mjs';

export const READ_VARS = ['OSSTRICH_STATE_DIR', 'OSSTRICH_MODEL', 'OSSTRICH_AGENT', 'GH_TOKEN'];
const FILE_VARS = [...READ_VARS, ...Object.values(PROVIDER_VAR)];

export function loadEnv({ repoRoot, fs, env }) {
  const merged = { ...env };
  const envPath = path.join(repoRoot, '.env');
  if (!fs.existsSync(envPath)) {return merged;}

  // `strict` is left at its default (off): a missing or partially-readable
  // .env should never crash the CLI, it should just mean fewer vars. The
  // file loads into a scratch copy of `env` (so a DOTENV_PRIVATE_KEY there
  // still decrypts it), and only FILE_VARS are copied back.
  const loaded = { ...env };
  dotenvxConfig({ path: envPath, processEnv: loaded, quiet: true });
  for (const name of FILE_VARS) {
    if (Object.hasOwn(loaded, name)) {merged[name] = loaded[name];}
  }
  return merged;
}
