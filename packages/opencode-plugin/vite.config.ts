import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "opencode-plugin",
		exclude: [
			...configDefaults.exclude,
			...(process.env.CI_PACKAGE_TEST === "1" ? ["**/*.perf.test.ts"] : []),
		],
	},
});
