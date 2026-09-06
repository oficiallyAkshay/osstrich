// Loads `<repoRoot>/.env` (dotenvx-aware: handles an encrypted file
// transparently the same way `dotenvx run` would) and returns a merged env
// object. Never mutates process.env — callers decide what to do with the
// result.
import path from 'node:path';
import { config as dotenvxConfig } from '@dotenvx/dotenvx';

export function loadEnv({ repoRoot, fs, env }) {
  const merged = { ...env };
  const envPath = path.join(repoRoot, '.env');
  if (!fs.existsSync(envPath)) return merged;

  // `strict` is left at its default (off): a missing or partially-readable
  // .env should never crash the CLI, it should just mean fewer vars.
  dotenvxConfig({ path: envPath, processEnv: merged, quiet: true });
  return merged;
}
