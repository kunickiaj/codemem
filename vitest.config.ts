import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		maxWorkers: process.env.CI ? 1 : undefined,
		projects: ["packages/*/vite.config.ts"],
	},
});
