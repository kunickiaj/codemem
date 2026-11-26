import { configDefaults, defineConfig } from "vitest/config";
import { TEST_CONFIG_TRIGGERS } from "./scripts/test-rerun-triggers.mjs";

export default defineConfig({
	test: {
		// Standard GitHub-hosted runners for public repos have 4 vCPUs. On a 4-CPU Linux
		// container, one parallel shard took 278-279 s with 4 workers against 344-359 s with 3.
		maxWorkers: process.env.CI ? 4 : undefined,
		// PR test selection (`--changed`) runs everything when one of these changes.
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			...TEST_CONFIG_TRIGGERS,
			"**/pnpm-lock.yaml",
			"**/pnpm-workspace.yaml",
			"**/tsconfig*.json",
			// Shared Core test fixtures read the Worker schema and migrations at runtime.
			"**/schema.sql",
			"**/migrations/**",
		],
		projects: [
			"packages/*/vite.config.ts",
			{
				extends: true,
				test: {
					name: "e2e-unit",
					setupFiles: ["./packages/core/src/test-environment-isolation.ts"],
					environment: "node",
					include: ["e2e/**/*.test.ts"],
				},
			},
		],
	},
});
