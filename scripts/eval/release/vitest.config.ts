import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { EVAL_TEST_INCLUDE } from "../test-includes.js";

export default defineConfig({
	root: resolve(import.meta.dirname, "../../.."),
	resolve: {
		alias: { "@codemem/core": resolve(import.meta.dirname, "../../../packages/core/src/index.ts") },
		conditions: ["source"],
	},
	test: {
		name: "release-eval",
		environment: "node",
		include: EVAL_TEST_INCLUDE,
	},
});
