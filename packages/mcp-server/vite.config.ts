import { defineConfig } from "vitest/config";

export default defineConfig({
	build: {
		lib: {
			entry: "src/index.ts",
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {
			external: [/^@codemem\//, /^node:/, /^@modelcontextprotocol\//, "zod", "better-sqlite3"],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "mcp-server",
	},
});
