import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@codemem/core/internal/relay-runtime": resolve(
				import.meta.dirname,
				"../core/src/internal/relay-runtime.ts",
			),
			"@codemem/core": resolve(import.meta.dirname, "../core/src/index.ts"),
			"@codemem/memory-tools": resolve(import.meta.dirname, "../memory-tools/src/index.ts"),
			"@codemem/server": resolve(import.meta.dirname, "../viewer-server/src/index.ts"),
		},
		conditions: ["source"],
	},
	build: {
		lib: {
			entry: {
				http: "src/http.ts",
				index: "src/index.ts",
				stdio: "src/stdio.ts",
			},
			formats: ["es"],
			fileName: (_format, entryName) => `${entryName}.js`,
		},
		rollupOptions: {
			external: [
				/^@codemem\//,
				/^node:/,
				/^@modelcontextprotocol\//,
				/^express(?:\/.*)?$/,
				"zod",
				"better-sqlite3",
			],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "mcp-server",
	},
});
