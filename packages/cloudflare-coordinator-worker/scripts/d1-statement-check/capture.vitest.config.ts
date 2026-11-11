import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const core = resolve(import.meta.dirname, "../../../core");

/** Runs the core coordinator tests with statement capture switched on. */
export default defineConfig({
	test: {
		name: "d1-statement-capture",
		root: core,
		include: ["src/coordinator-*.test.ts", "src/linked-legacy-*.test.ts", "src/owner-*.test.ts"],
		// This test runs the self-bind statement as it was before its port, to compare
		// answers. The coordinator no longer runs that statement, so it is not checked.
		exclude: [...configDefaults.exclude, "src/coordinator-device-self-bind-equivalence.test.ts"],
		// The root config's worker cap does not apply to this standalone config.
		maxWorkers: process.env.CI ? 3 : undefined,
		setupFiles: [resolve(import.meta.dirname, "capture-setup.ts")],
		// Capture needs every test to reach its statements; the suite's own run enforces speed.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
