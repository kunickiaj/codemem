import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	build: {
		lib: {
			entry: resolve(import.meta.dirname, "src/index.ts"),
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {
			external: ["better-sqlite3", "sqlite-vec", /^node:/],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "core",
	},
});
