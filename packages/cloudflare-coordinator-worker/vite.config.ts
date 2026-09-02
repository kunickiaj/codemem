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
	build: {
		lib: {
			entry: "src/index.ts",
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {
			external: [/^node:/, /^better-sqlite3$/],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "cloudflare-coordinator-worker",
		include: ["src/**/*.test.ts"],
	},
});
