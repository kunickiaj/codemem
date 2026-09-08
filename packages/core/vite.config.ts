import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	build: {
		lib: {
			entry: {
				index: resolve(import.meta.dirname, "src/index.ts"),
				"internal/cloudflare-coordinator": resolve(
					import.meta.dirname,
					"src/internal/cloudflare-coordinator.ts",
				),
			},
			formats: ["es"],
			fileName: (_format, entryName) => `${entryName}.js`,
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
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "core",
		// Run the frozen baseline through scripts/eval/run-automatic-recall-baseline.mjs.
		exclude: [...configDefaults.exclude, "**/automatic-recall-pre-policy.eval.test.ts"],
	},
});
