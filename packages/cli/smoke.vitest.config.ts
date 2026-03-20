import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "cli-smoke",
		hookTimeout: 30000,
		include: ["src/index.smoke.test.ts"],
		exclude: ["node_modules/**"],
	},
});
