import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "opencode-plugin",
		setupFiles: ["../core/src/test-environment-isolation.ts"],
	},
});
