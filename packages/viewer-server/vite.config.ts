import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Library mode — SSR/Node target.
// Externalizes @codemem/core, hono, and node: built-ins.
export default defineConfig({
	resolve: {
		alias: {
			"@codemem/core/feed-contract": resolve(import.meta.dirname, "../core/src/feed-contract.ts"),
			"@codemem/core/recipient-policy-contract": resolve(
				import.meta.dirname,
				"../core/src/recipient-policy-contract.ts",
			),
			"@codemem/core/internal/relay-runtime": resolve(
				import.meta.dirname,
				"../core/src/internal/relay-runtime.ts",
			),
			"@codemem/core": resolve(import.meta.dirname, "../core/src/index.ts"),
		},
		conditions: ["source"],
	},
	build: {
		lib: {
			entry: resolve(import.meta.dirname, "src/index.ts"),
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {
			external: [/^@codemem\//, /^node:/, /^hono/, /^better-sqlite3/],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "viewer-server",
	},
});
