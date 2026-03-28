import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		conditions: ["source"],
	},
	build: {
		lib: {
			entry: "src/index.ts",
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {
			external: [/^node:/, /^better-sqlite3$/],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "cloudflare-coordinator-worker",
		include: ["src/**/*.test.ts"],
	},
});
