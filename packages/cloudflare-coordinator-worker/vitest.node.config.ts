import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@codemem/core/internal/cloudflare-coordinator": resolve(
				import.meta.dirname,
				"../core/src/internal/cloudflare-coordinator.ts",
			),
			"@codemem/core/internal/relay-host": resolve(
				import.meta.dirname,
				"../core/src/internal/relay-host.ts",
			),
			"@codemem/core": resolve(import.meta.dirname, "../core/src/index.ts"),
		},
		conditions: ["source"],
	},
	test: {
		environment: "node",
		name: "cloudflare-coordinator-worker-node",
		setupFiles: ["../core/src/test-environment-isolation.ts"],
		// PR test selection (`--changed`) runs everything when one of these changes.
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			"**/vitest.*.config.*",
			"**/test-environment-isolation.ts",
			"**/pnpm-lock.yaml",
			"**/pnpm-workspace.yaml",
			"**/tsconfig*.json",
		],
	},
});
