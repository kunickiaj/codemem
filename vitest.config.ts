import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { EVAL_TEST_INCLUDE } from "./scripts/eval/test-includes.js";

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
					include: EVAL_TEST_INCLUDE,
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
