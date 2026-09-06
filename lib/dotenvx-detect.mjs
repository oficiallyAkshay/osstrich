// Whether the target repo already uses dotenvx's encrypted-.env workflow.
// Shared by `init` (to decide what hint to print) and `env set` (to decide
// whether to shell out to `dotenvx set` instead of hand-editing .env).
import path from 'node:path';

export function detectDotenvxUsage({ fs, repoRoot }) {
  const keysFile = path.join(repoRoot, '.env.keys');
  if (fs.existsSync(keysFile)) return true;

  const envFile = path.join(repoRoot, '.env');
  if (fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf8').includes('DOTENV_PUBLIC_KEY')) {
    return true;
  }

  const pkgFile = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (Object.prototype.hasOwnProperty.call(deps, '@dotenvx/dotenvx')) return true;
    } catch {
      // A malformed package.json just means this signal is inconclusive.
    }
  }

  return false;
}
