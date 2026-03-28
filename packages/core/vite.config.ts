import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

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
				"better-sqlite3",
				"sqlite-vec",
				"@xenova/transformers",
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
	},
});
