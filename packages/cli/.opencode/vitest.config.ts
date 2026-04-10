import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "cli-plugin",
		include: [".opencode/tests/**/*.test.js"],
		setupFiles: [".opencode/tests/setup.js"],
		exclude: ["node_modules/**"],
	},
});
