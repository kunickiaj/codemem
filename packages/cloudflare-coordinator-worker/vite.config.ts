import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { testWorkerExecArgv } from "../core/test-worker-v8-flags.ts";

export default defineConfig({
	resolve: {
		alias: {
			"@codemem/core/internal/cloudflare-coordinator": resolve(
				import.meta.dirname,
				"../core/src/internal/cloudflare-coordinator.ts",
			),
			"@codemem/core/internal/relay-host": resolve(
				import.meta.dirname,
				"../core/src/internal/relay-host.ts",
			),
			"@codemem/core": resolve(import.meta.dirname, "../core/src/index.ts"),
		},
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
		// Core from source starts semantic worker threads; see test-worker-v8-flags.ts.
		execArgv: testWorkerExecArgv(),
		setupFiles: ["../core/src/test-environment-isolation.ts"],
		include: ["src/**/*.test.ts"],
	},
});
