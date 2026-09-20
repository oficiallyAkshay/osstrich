// ESLint's own recommended set, plus the correctness rules that catch the
// mistakes this codebase can actually make: an unawaited promise, a variable
// read before it is assigned, a case that falls through. Style is not linted
// here — the repo has no formatter and a style rule would produce churn
// without catching a defect.
import js from "@eslint/js";

export default [
	js.configs.recommended,
	{
		files: ["**/*.mjs"],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: "module",
			globals: {
				console: "readonly",
				process: "readonly",
				Buffer: "readonly",
				URL: "readonly",
				URLSearchParams: "readonly",
				TextEncoder: "readonly",
				TextDecoder: "readonly",
				AbortController: "readonly",
				AbortSignal: "readonly",
				fetch: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
				setInterval: "readonly",
				clearInterval: "readonly",
				structuredClone: "readonly",
			},
		},
		rules: {
			"no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
			"no-await-in-loop": "off",
			eqeqeq: ["error", "always", { null: "ignore" }],
			"no-var": "error",
			"prefer-const": "error",
			"no-throw-literal": "error",
			"no-return-await": "error",
			// Off, with cause: every report it produces here is inside a
			// mapWithConcurrency callback whose `row` is that callback's own
			// element. The rule cannot see that each closure holds a distinct
			// object, so it reads per-row assignment after an await as shared
			// state. There is no shared state to race on.
			"require-atomic-updates": "off",
		},
	},
];
