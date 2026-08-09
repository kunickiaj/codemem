import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: resolve(import.meta.dirname, "../../.."),
	resolve: {
		alias: { "@codemem/core": resolve(import.meta.dirname, "../../../packages/core/src/index.ts") },
		conditions: ["source"],
	},
	test: {
		name: "release-eval",
		environment: "node",
		include: ["scripts/eval/release/**/*.test.ts", "scripts/eval/release-eval.test.ts"],
	},
});
