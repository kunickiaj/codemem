import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "cli-smoke",
		setupFiles: ["../core/src/test-environment-isolation.ts"],
		hookTimeout: 30000,
		include: ["src/index.smoke.test.ts"],
		exclude: ["node_modules/**"],
	},
});
