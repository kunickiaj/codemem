import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// CLI uses tsc for build (not Vite library mode — CLI entry points with
	// program.parse() get tree-shaken away by Rolldown). Vite config retained
	// for vitest integration only.
	build: {
		lib: {
			entry: resolve(import.meta.dirname, "src/index.ts"),
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {
			external: [/^@codemem\//, /^node:/, "commander", "chalk"],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "cli",
	},
});
