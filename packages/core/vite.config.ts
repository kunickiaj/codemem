import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	build: {
		target: "node24",
		lib: {
			entry: {
				index: resolve(import.meta.dirname, "src/index.ts"),
				"semantic-worker-entry": resolve(
					import.meta.dirname,
					"src/semantic/semantic-worker-entry.ts",
				),
				"recipient-policy-contract": resolve(
					import.meta.dirname,
					"src/recipient-policy-contract.ts",
				),
				"internal/cloudflare-coordinator": resolve(
					import.meta.dirname,
					"src/internal/cloudflare-coordinator.ts",
				),
			},
			formats: ["es"],
			fileName: (_format, entryName) => `${entryName}.js`,
		},
		rollupOptions: {
			// The executor resolves its worker beside its emitted module, including shared chunks.
			output: { chunkFileNames: "[name]-[hash].js" },
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
		exclude: [
			...configDefaults.exclude,
			...(process.env.CI_PACKAGE_TEST === "1" ? ["**/*.perf.test.ts"] : []),
		],
	},
});
