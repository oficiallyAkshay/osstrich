// A minimal in-memory stand-in for node:fs's sync API, just enough of it
// for config/status/command tests: existsSync, readFileSync, writeFileSync,
// mkdirSync, renameSync, appendFileSync, readdirSync, statSync.
import path from 'node:path';

export function createFakeFs(initialFiles = {}) {
  const files = new Map();
  const dirs = new Set(['/']);
  const mtimes = new Map();
  let counter = 0;

  // Always walks all the way to the root, even if an ancestor is already
  // tracked: a directory registered directly (via mkdirSync) must not stop
  // its own ancestors from being registered too.
  function addDirChain(dirPath) {
    let dir = dirPath;
    for (;;) {
      dirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  function ensureDirsFor(filePath) {
    addDirChain(path.dirname(filePath));
  }

  function touch(p) {
    counter += 1;
    mtimes.set(p, counter);
  }

  for (const [p, content] of Object.entries(initialFiles)) {
    ensureDirsFor(p);
    files.set(p, content);
    touch(p);
  }

  return {
    existsSync(p) {
      return files.has(p) || dirs.has(p);
    },
    readFileSync(p) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
    writeFileSync(p, content) {
      ensureDirsFor(p);
      files.set(p, content);
      touch(p);
    },
    mkdirSync(p) {
      addDirChain(p);
    },
    renameSync(from, to) {
      if (!files.has(from)) {
        const err = new Error(`ENOENT: no such file, rename '${from}' -> '${to}'`);
        err.code = 'ENOENT';
        throw err;
      }
      ensureDirsFor(to);
      files.set(to, files.get(from));
      mtimes.set(to, mtimes.get(from));
      files.delete(from);
      mtimes.delete(from);
    },
    appendFileSync(p, content) {
      ensureDirsFor(p);
      files.set(p, (files.get(p) ?? '') + content);
      touch(p);
    },
    readdirSync(p) {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const entries = new Set();
      for (const key of [...files.keys(), ...dirs]) {
        if (key !== p && key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first) entries.add(first);
        }
      }
      return [...entries];
    },
    statSync(p) {
      if (!files.has(p) && !dirs.has(p)) {
        const err = new Error(`ENOENT: no such file, stat '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return { mtimeMs: mtimes.get(p) ?? 0 };
    },
    _files: files,
  };
}
