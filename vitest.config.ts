import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		maxWorkers: process.env.CI ? 1 : undefined,
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
