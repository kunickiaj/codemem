import { defineConfig } from "vitest/config";

export default defineConfig({
	build: {
		ssr: "src/index.ts",
		rollupOptions: {
			external: [/^@codemem\//, /^node:/, "better-sqlite3", "sqlite-vec"],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "viewer-server",
	},
});
