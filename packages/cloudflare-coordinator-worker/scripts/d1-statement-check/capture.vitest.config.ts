import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const core = resolve(import.meta.dirname, "../../../core");

/** Runs the core coordinator tests with statement capture switched on. */
export default defineConfig({
	resolve: {
		alias: {
			// The capture job imports the Worker verifier without building Core first.
			"@codemem/core/internal/cloudflare-coordinator": resolve(
				core,
				"src/internal/cloudflare-coordinator.ts",
			),
			// Viewer-server modules that some captured tests import read this subpath too.
			"@codemem/core/internal/relay-runtime": resolve(core, "src/internal/relay-runtime.ts"),
		},
	},
	test: {
		name: "d1-statement-capture",
		root: core,
		include: ["src/coordinator-*.test.ts", "src/linked-legacy-*.test.ts", "src/owner-*.test.ts"],
		// These tests run statements as they were before their read-set ports, to compare
		// answers. The coordinator no longer runs those statements, so they are not checked.
		exclude: [
			...configDefaults.exclude,
			"src/coordinator-device-self-bind-equivalence.test.ts",
			"src/coordinator-account-change-equivalence.test.ts",
			"src/coordinator-owner-negative-equivalence.test.ts",
			"src/coordinator-owner-producer-equivalence.test.ts",
			"src/coordinator-recipient-owner-equivalence.test.ts",
			"src/coordinator-auth-controller-equivalence.test.ts",
			"src/coordinator-device-ownership-evidence-equivalence.test.ts",
			"src/coordinator-legacy-owner-resolution-commit-equivalence.test.ts",
			"src/coordinator-account-historical-revoke-equivalence.test.ts",
			"src/coordinator-legacy-completion-owner-proof-equivalence.test.ts",
		],
		// The root config's worker cap does not apply to this standalone config. Unlike the
		// root config, capture uses all 4 vCPUs of a standard runner: on a 4-CPU Linux
		// container this run took 341s with 4 workers against 368s and 389s with 3.
		maxWorkers: process.env.CI ? 4 : undefined,
		setupFiles: [
			resolve(core, "src/test-environment-isolation.ts"),
			resolve(import.meta.dirname, "capture-setup.ts"),
		],
		// Capture needs every test to reach its statements; the suite's own run enforces speed.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
