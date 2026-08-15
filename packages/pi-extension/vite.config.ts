import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Thin client: no @codemem/core runtime import. Core is test-only (via alias)
// for envelope-mapping assertions against the real adapter.
export default defineConfig({
	resolve: {
		alias: {
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
			external: [
				/^@earendil-works\//,
				/^node:/,
				"typebox",
				// Never bundle core — runtime must stay thin.
				/^@codemem\//,
			],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "pi-extension",
	},
});
