import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const core = resolve(import.meta.dirname, "../../../core");

/** Runs the core coordinator tests with statement capture switched on. */
export default defineConfig({
	test: {
		name: "d1-statement-capture",
		root: core,
		include: ["src/coordinator-*.test.ts", "src/linked-legacy-*.test.ts", "src/owner-*.test.ts"],
		setupFiles: [resolve(import.meta.dirname, "capture-setup.ts")],
		// Capture needs every test to reach its statements; the suite's own run enforces speed.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
