import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Library mode — SSR/Node target.
// Externalizes @codemem/core, hono, and node: built-ins.
export default defineConfig({
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
