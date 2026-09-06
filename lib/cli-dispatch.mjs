// Lazily loads lib/cli-core.mjs and hands it discover/build/scrub/recheck.
// `importCore` is injectable so tests can stub the core without touching
// the real filesystem.
export async function dispatchCore(command, argv, deps, { importCore = () => import('./cli-core.mjs') } = {}) {
  const core = await importCore();
  return core.main([command, ...argv], deps);
}
