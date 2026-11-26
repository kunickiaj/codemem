// Files that change how tests run rather than what they test. Vitest's import trace cannot
// see them, so pull request test selection runs every test when one of them changes.
//
// Vitest's own defaults (`**/{vitest,vite}.config.*/**`) only match files inside a directory
// named like a config, never the config file itself, and `**/vitest.*.config.*` does not
// match `vitest.config.ts`. These patterns match the files.
export const TEST_CONFIG_TRIGGERS = [
	// Root and package test configs.
	"**/vitest.config.*",
	"**/vitest.*.config.*",
	"**/vite.config.*",
	// Setup files the configs load, and modules they import.
	"**/test-environment-isolation.ts",
	"**/preact-frame-test-setup.ts",
	"**/.opencode/tests/setup.js",
	"**/ui-aliases.ts",
	"**/src/lib/account-dev-proxy.ts",
	"**/test-worker-v8-flags.ts",
	// The selection itself.
	"**/scripts/ci-changed-tests.mjs",
	"**/scripts/test-rerun-triggers.mjs",
];
