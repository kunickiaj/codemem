import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		maxWorkers: process.env.CI ? 1 : undefined,
		projects: [
			"packages/*/vite.config.ts",
			{
				extends: true,
				resolve: {
					alias: {
						"@codemem/core": resolve(import.meta.dirname, "packages/core/src/index.ts"),
					},
					conditions: ["source"],
				},
				test: {
					name: "release-eval",
					environment: "node",
					include: ["scripts/eval/release/**/*.test.ts", "scripts/eval/release-eval.test.ts"],
				},
			},
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
