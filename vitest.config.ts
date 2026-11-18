import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Standard GitHub-hosted runners for public repos have 4 vCPUs; keep one
		// free for the main process and SQLite I/O.
		maxWorkers: process.env.CI ? 3 : undefined,
		// PR test selection (`--changed`) runs everything when one of these changes.
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			"**/vitest.*.config.*",
			"**/test-environment-isolation.ts",
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
