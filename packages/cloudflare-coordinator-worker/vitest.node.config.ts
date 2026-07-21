import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@codemem/core/internal/cloudflare-coordinator": resolve(
				import.meta.dirname,
				"../core/src/internal/cloudflare-coordinator.ts",
			),
			"@codemem/core": resolve(import.meta.dirname, "../core/src/index.ts"),
		},
		conditions: ["source"],
	},
	test: {
		environment: "node",
		name: "cloudflare-coordinator-worker-node",
	},
});
