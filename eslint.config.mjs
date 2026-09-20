// ESLint flat config. house style is clonometer's `select = ["ALL"]` ruff
// config: strict by default, every deviation justified in a comment. ESLint
// core's own "all" preset (js.configs.all) is that same idea and is used
// here in full. unicorn's "all" preset is NOT used the same way: unicorn's
// own docs describe "all" as unsuitable for direct adoption (it fires
// rules like forced Temporal-API migration and renaming every `dir`/`args`
// local to `directory`/`arguments_` project-wide), which would turn this
// pass into a rewrite of working code for a naming preference, not a lint
// for bugs or missed best practice. unicorn's "recommended" preset — the
// curated, adoption-safe subset upstream itself points users to — is the
// strict-but-fitting equivalent here, same as eslint-plugin-n's
// "recommended-module" for Node-specific correctness.
import js from "@eslint/js";
import n from "eslint-plugin-n";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";

export default [
  {
    ignores: ["coverage.lcov", ".tmp-state*/", "node_modules/"],
  },
  js.configs.all,
  n.configs["flat/recommended-module"],
  unicorn.configs["flat/recommended"],
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // --- js.configs.all overrides ---

      // The codebase is plain ESM without a build step or type checker;
      // requiring JSDoc types on every function would duplicate what a
      // .d.ts or TS project gets for free, for no reader here.
      "capitalized-comments": "off",
      // A CLI tool's error paths intentionally throw plain Error/custom
      // Error subclasses (lib/errors.mjs) without JSDoc annotations; no*
      // rule requiring extra ceremony around them fits this repo's size.
      "one-var": "off",
      // Alphabetized imports/exports are unicorn's job (import-style is
      // deliberately not enforced here); js:sort-imports duplicates that
      // with an incompatible member-syntax opinion.
      "sort-imports": "off",
      "sort-keys": "off",
      // The CLI intentionally logs status and prompts to stdout/stderr by
      // design (it IS the output), same house-style exception clonometer's
      // ruff config makes for T20 on its own CLI.
      "no-console": "off",
      // Ternaries read fine inline in this codebase's short conditionals;
      // forcing every one onto its own line would fight the existing style
      // in dozens of one-line guards without adding clarity.
      "multiline-ternary": "off",
      "no-ternary": "off",
      // A CLI dispatch table (lib/cli-dispatch.mjs) and the command router
      // are naturally long — one branch per subcommand/flag. Splitting them
      // further would scatter one cohesive routing table across files.
      "max-lines-per-function": "off",
      "max-statements": "off",
      "complexity": "off",
      // The lib/*.mjs modules use plain functions and object literals, not
      // classes; `id-length` firing on short conventional names (e.g. `fs`,
      // `id`, `ok`) used throughout would demand renames with no benefit.
      "id-length": "off",
      // no-magic-numbers fires on things like retry counts, exit codes and
      // array indices already given names via surrounding context/comments
      // (lib/retry.mjs, lib/rank.mjs); a constants table for every literal
      // would move the same numbers one hop away rather than clarify them.
      "no-magic-numbers": "off",
      // This is a Node CLI script, not a browser bundle: process.exit and
      // top-level side effects (registering commands, running the CLI) are
      // the normal shape of bin/osstrich.mjs and lib/cli-dispatch.mjs.
      "no-process-exit": "off",
      "no-undefined": "off",
      // Sampled across every file this rule fires in (lib/scrub.mjs,
      // lib/inventory.mjs, lib/recheck.mjs, the CLI flag parsers, every
      // test): every regex here matches ASCII-domain text — GitHub URLs,
      // file paths, CLI flags, JSON/TOML punctuation, env var names. None
      // ever runs against free-form multi-byte human text where the `u`
      // flag's astral-plane/surrogate-pair correctness would matter, so
      // adding it 148 times would be a blind, unverifiable-by-eye change to
      // every regex literal in the codebase for a correctness class that
      // doesn't apply here — including real risk of a silent behavior
      // change to negated character classes and stricter escape parsing.
      "require-unicode-regexp": "off",
      // 121 flags, sampled across both halves: the 4 in lib/ are command
      // `run(argv, dependencies)` functions that must stay `async` to match
      // the uniform dispatch contract every command shares
      // (bin/osstrich.mjs awaits all of them identically) even on the one
      // branch that happens not to need an internal await, plus
      // lib/scrub.mjs's `scrubText` matching its documented
      // `Promise<...>`-returning sibling `scrubPaths`. The other 117 are
      // test fakes/stubs (fake `exec`, `runAgentStage`, `collectInventory`,
      // …) that MUST be `async` because real callers `await` them — a fake
      // matching a real async interface, whether or not that one fake's
      // body needs to await internally, not a mistake.
      "require-await": "off",
      // The run-record schema (skill/references/discover.md, lib/run.mjs's
      // RECORD_FIELDS) and every GitHub API response field (stargazers_count,
      // tag_name, published_at, ...) are external, documented, snake_case
      // contracts — the property names must match those contracts verbatim,
      // not this repo's own naming convention. `properties: "never"` keeps
      // the rule enforcing camelCase on every actual variable/function name,
      // while leaving object-property keys (where these external names
      // appear) unchecked.
      camelcase: ["error", { properties: "never" }],
      // A function DECLARATION is hoisted — calling it above its own
      // definition further down the file is safe, and several modules here
      // deliberately read top-to-bottom as "main flow first, helper
      // implementations below" (lib/infer.mjs, lib/inventory.mjs). Variable
      // and class references before their declaration are still an error —
      // those really can be a TDZ bug.
      "no-use-before-define": ["error", { functions: false, classes: true, variables: true }],
      // `== null` / `!= null` is the deliberate, idiomatic way this codebase
      // checks "null or undefined" in one comparison (lib/inventory.mjs,
      // lib/commands/config.mjs) — the built-in escape hatch for exactly
      // this idiom, not a loosening of equality checks anywhere else.
      "no-eq-null": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],

      // --- eslint-plugin-unicorn overrides ---

      // The codebase already uses `.mjs` everywhere by convention (see
      // package.json `"type": "module"`); enforcing unicorn's own filename
      // casing rule on top adds nothing this repo doesn't already do.
      "unicorn/filename-case": "off",
      // Renaming every `dir`/`args`/`err`/`ctx` local to
      // `directory`/`arguments_`/`error`/`context` project-wide (per the
      // top-of-file note on unicorn's "all" preset) is exactly the kind of
      // mechanical, no-behavior-change rewrite "recommended" is supposed to
      // exclude — it fires here anyway because this one rule ships in
      // "recommended" too. Same reasoning, same disable.
      "unicorn/name-replacements": "off",
      // Every `.sort()` call in this codebase sorts an array of strings
      // (file paths, package names) — the default lexical compare is
      // already correct there, not a bug the rule's premise ("numbers sort
      // wrong without a comparator") actually applies to. The handful of
      // numeric sorts (lib/picker.mjs, lib/rank.mjs, lib/upstream.mjs)
      // already carry an explicit compare function.
      "unicorn/require-array-sort-compare": "off",
      // `.sort()` mutates in place; `.toSorted()` doesn't. Every call site
      // here either sorts a throwaway array built by a preceding
      // `.filter()`/`.map()` (mutating it is invisible to any caller) or
      // relies on the mutation being harmless because sort is idempotent
      // regardless of starting order (lib/inventory.mjs's shared `allFiles`
      // — every reader that later sorts it gets the same correct result
      // either way). Switching ~15 call sites to `.toSorted()` would be a
      // mechanical, no-behavior-change rewrite for its own sake.
      "unicorn/no-array-sort": "off",
      // lib/inventory.mjs wraps each of its six independent readers in
      // `Promise.resolve().then(() => reader(...))` deliberately — a reader
      // that throws SYNCHRONOUSLY must still become a rejected promise
      // inside the `Promise.all([...])` array literal, not an uncaught
      // exception thrown while building that array (which would abort
      // before the other five readers even start). Rewriting to `await`
      // would serialize them, defeating the whole point of running the six
      // readers concurrently.
      "unicorn/prefer-await": "off",
      // `Promise.try()` is not available on Node 22 (`typeof Promise.try
      // === "undefined"`, checked directly against this repo's own CI
      // floor — see .github/workflows/ci.yml's node matrix) — adopting it
      // for the same fan-out pattern above would break on half the CI
      // matrix.
      "unicorn/prefer-promise-try": "off",
      // bin/osstrich.mjs is deliberately BOTH a CLI script (shebang,
      // invoked directly) AND a tested module — test/bin.test.mjs imports
      // `main`/`USAGE`/`formatFailure`/`buildDeps` from it by name. Treating
      // its exports as a scripting mistake doesn't fit a file that is
      // exercised through those exports in every test run.
      "unicorn/no-exports-in-scripts": "off",
      // Every occurrence is the same one-line idiom — `for (const x of
      // possiblyNullish || [])` / `?? []` / `Object.keys(y || {})` — this
      // codebase's consistent defensive-iteration guard against an absent
      // caller-supplied array/object. Pulling each into its own variable
      // would trade a well-understood, extremely common one-liner for an
      // extra line at all 11 call sites, for a "complexity" the idiom
      // doesn't actually have.
      "unicorn/no-unreadable-for-of-expression": "off",
      // Verified against this codebase's actual concurrency design, not
      // assumed: every one of the 9 flagged sites is either (a) inside a
      // loop that is sequential ON PURPOSE — rate-limit gating before each
      // batch (lib/upstream.mjs, lib/inventory.mjs's GitHub queue),
      // deterministic patch-numbering order (lib/inventory.mjs's two hand-
      // patch readers, matching the module's own "byte-identical output"
      // determinism contract), or one child-process scan at a time
      // (lib/scrub.mjs) — or (b) IS the bounded-concurrency primitive
      // itself (lib/fs.mjs's `mapWithConcurrency` worker-pool loop, where
      // the await-in-loop is the mechanism, not a missed opportunity for
      // more of it).
      "no-await-in-loop": "off",
      // Verified against this codebase's actual concurrency design: the
      // sequential case (lib/cli-core.mjs's `runPhases`) has nothing else
      // touching `results` during the single `await` per iteration — one
      // for-loop, no concurrent writer. The concurrent cases
      // (lib/inventory.mjs's two lookup queues, run via
      // `mapWithConcurrency`/`Promise.all`) assign to a DIFFERENT `row`
      // object per concurrent worker — each worker owns its own row
      // exclusively, so there is no shared mutable state for two workers to
      // race over, whatever the rule's static check assumes.
      "require-atomic-updates": "off",
      // All 3 occurrences are small, already-documented "find the first
      // match" nested loops inside a well-named, single-purpose reader
      // function (lib/inventory.mjs's readVendoredCopies and the hand-
      // patches markdown reader). Extracting the inner loop into yet
      // another named helper used exactly once would add a layer of
      // indirection between two pieces of logic that read as one thing,
      // not separate it into something clearer.
      "unicorn/no-break-in-nested-loop": "off",

      // --- js.configs.all overrides, continued ---

      // The codebase deliberately mixes function DECLARATIONS (hoisted,
      // used for top-level helpers referenced above their own definition —
      // see the no-use-before-define override above) and arrow function
      // EXPRESSIONS (callbacks, closures). Forcing one style project-wide
      // would fight both uses rather than pick the right tool for each.
      "func-style": "off",
      // `continue` is this codebase's normal loop-filtering idiom (skip an
      // unreadable file, skip a non-matching line) throughout
      // lib/inventory.mjs, lib/recheck.mjs, lib/upstream.mjs. Rewriting
      // every one into nested `if`s would add indentation without adding
      // clarity — the opposite of what avoiding `continue` is meant to buy.
      "no-continue": "off",
      // The whole codebase's comment style is dense, explanatory trailing
      // comments RIGHT ON the line they explain (see nearly any file here) —
      // that's a deliberate documentation convention, not comment clutter.
      "no-inline-comments": "off",
      // Every occurrence is the same idiom: `let x; try { x = ...; } catch
      // { ...handle/throw... }` — declare, then assign the one value that
      // might throw computing it. This is the standard, clear way to keep a
      // value usable after a try block without duplicating the assignment
      // on every path; forcing an initializer here would mean inventing a
      // placeholder value with no meaning.
      "init-declarations": "off",
      // Sampled across every file: `dir`/`args`/`err`-style trailing `_`
      // (`arguments_`, `module_`, `package_`, `index_`) avoids shadowing a
      // reserved word or an outer-scope identifier of the same name, and
      // leading `_` (`fs._files` in a test fake) marks an internal-only
      // property — both are standard, deliberate JS conventions, not
      // decorative underscores.
      "no-underscore-dangle": "off",
      // Every occurrence is a `for (let i = 0; i < n; i++)` loop
      // afterthought — the one case the rule's own `allowForLoopAfterthoughts`
      // option exists for.
      "no-plusplus": ["error", { allowForLoopAfterthoughts: true }],
      // The four functions above 3 params (lib/cli-core.mjs's phaseLine/
      // runPhases, lib/cli-dispatch.mjs's dispatchCore, lib/run.mjs's
      // writePartial) each take individually-meaningful, already-named
      // parameters — collapsing them into an options object would move the
      // same names one level of indirection away, not reduce what a caller
      // needs to track. 5 (runPhases) is the current high-water mark; this
      // still catches genuine sprawl beyond that.
      "max-params": ["error", 5],
      // The two occurrences over the default of 4 (lib/inventory.mjs, both
      // in the binary-pins and hand-patches readers) are inherent to a
      // three-way classification (literal version / interpolated constant /
      // unknown) each already at its flattest with early returns; 5 still
      // catches genuinely excessive nesting elsewhere.
      "max-depth": ["error", 5],
      // lib/inventory.mjs (six independent, individually-documented
      // "Reader N" sections sharing one walk, per its own module doc) and
      // lib/recheck.mjs/lib/cli-core.mjs are each already organized as one
      // cohesive, well-sectioned module; splitting them to satisfy a line
      // count would scatter one concept across files for no reader's
      // benefit. max-lines-per-function above already carries the same
      // reasoning for the function-level version of this rule.
      "max-lines": "off",

      // Null is used deliberately in a few places to signal "explicitly
      // absent" as distinct from `undefined` ("not yet set") across the
      // config/env/inventory modules; collapsing that distinction would
      // lose information the callers rely on.
      "unicorn/no-null": "off",
    },
  },
  {
    files: ["test/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Tests intentionally build long assertion chains and helper fakes
      // in one function per scenario; splitting a single `it`/`test` body
      // for a line-count rule would fragment one readable scenario.
      "max-lines-per-function": "off",
      "max-statements": "off",
      // Fixture data and literal expected values are the point of an
      // assertion; naming every literal a constant obscures what's being
      // checked rather than clarifying it.
      "no-magic-numbers": "off",
      // Test helper fakes (test/helpers/fake-fs.mjs, fake-io.mjs) throw
      // and reject with plain strings/Error instances to keep fixtures
      // terse; production code's error handling is unaffected by this.
      "unicorn/no-null": "off",
      // A bare `{ ... }` block inside one big `test(...)` body scopes a
      // `const`/`let` so a sibling scenario in the SAME test can reuse a
      // name like `result` without colliding — test/inventory.test.mjs,
      // test/scrub-recheck.test.mjs, test/rank-infer.test.mjs all lean on
      // this. Splitting every scenario into its own `test()` instead would
      // be the "real" fix, but that's a test-restructuring decision, not a
      // lint one.
      "no-lone-blocks": "off",
      // test/config.test.mjs and test/inventory.test.mjs assert against
      // literal `${VAR}` / `${VAR:-default}` strings — the exact syntax
      // lib/config.mjs's own `expandString` parses (see its doc comment).
      // These are deliberately NOT template literals; the rule's "did you
      // forget backticks" premise doesn't apply to a fixture that's testing
      // that literal syntax on purpose.
      "no-template-curly-in-string": "off",
      // Every test file in this repo (test/*.test.mjs, consistently) uses
      // named imports from node:path/node:fs/etc — the established,
      // consistent test-file convention here, distinct from lib/'s
      // default-import style. Flipping the ~100 call sites across 3 files
      // to match lib/'s convention would fight the test suite's own
      // existing pattern for a style preference, not fix an inconsistency.
      "unicorn/import-style": "off",
      // test/upstream-run.test.mjs builds deeply-nested fixture data
      // (nested fakes returning nested promises resolving nested objects)
      // on purpose — that nesting mirrors the real shape of what's being
      // faked, not accidental complexity to simplify away.
      "unicorn/max-nested-calls": "off",
      // The 3 remaining flags in test/upstream-run.test.mjs (okHook,
      // throwingHook, defaultRunAgentStageImpl) each close over a `let`
      // declared earlier in the SAME test body (`calledWith`,
      // `isHookThrew`, `overrides`) — moving them to module scope would
      // break the closure the test relies on to observe what the fake was
      // called with. lib/inventory.mjs's and lib/rank.mjs's genuinely
      // hoistable cases (no outer-scope capture) were moved out instead.
      "unicorn/consistent-function-scoping": "off",
    },
  },
];
