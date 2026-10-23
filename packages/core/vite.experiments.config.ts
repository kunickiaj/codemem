import { resolve } from "node:path";
import { defineConfig } from "vite";

// Separate artifact only. This config is not part of the production package build or exports.
export default defineConfig({
	build: {
		target: "node24",
		lib: {
			entry: {
				"semantic-worker-entry": resolve(
					import.meta.dirname,
					"src/experiments/semantic-worker-entry.ts",
				),
				"semantic-worker-executor": resolve(
					import.meta.dirname,
					"src/experiments/semantic-worker-executor.ts",
				),
			},
			formats: ["es"],
			fileName: (_format, name) => `${name}.js`,
		},
		rollupOptions: {
			external: [
				"@codemem/embeddings",
				"better-sqlite3",
				"sqlite-vec",
				"drizzle-orm",
				/^drizzle-orm\//,
				/^node:/,
			],
		},
		outDir: "dist/experiments",
		emptyOutDir: true,
	},
});
