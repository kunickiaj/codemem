import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@codemem/core": path.resolve(import.meta.dirname, "../../core/src/index.ts"),
		},
		conditions: ["source"],
	},
	test: {
		name: "cli-plugin",
		include: [".opencode/tests/**/*.test.js"],
		setupFiles: [".opencode/tests/setup.js"],
		exclude: ["node_modules/**"],
	},
});
