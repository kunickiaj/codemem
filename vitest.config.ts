import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Standard GitHub-hosted runners for public repos have 4 vCPUs; keep one
		// free for the main process and SQLite I/O.
		maxWorkers: process.env.CI ? 3 : undefined,
		projects: [
			"packages/*/vite.config.ts",
			{
				extends: true,
				test: {
					name: "e2e-unit",
					environment: "node",
					include: ["e2e/**/*.test.ts"],
				},
			},
		],
	},
});
