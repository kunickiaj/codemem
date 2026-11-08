import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

function executableOutput() {
	return {
		name: "executable-output",
		writeBundle(options, bundle) {
			for (const fileName of Object.keys(bundle)) {
				if (fileName.endsWith(".js")) {
					chmodSync(resolve(options.dir ?? "dist", fileName), 0o755);
				}
			}
		},
	};
}

export default defineConfig({
	resolve: {
		alias: [
			// Specific subpath first: string aliases also match `@codemem/core/...` prefixes.
			{
				find: "@codemem/core/feed-contract",
				replacement: resolve(import.meta.dirname, "../core/src/feed-contract.ts"),
			},
			{
				find: "@codemem/core/internal/relay-runtime",
				replacement: resolve(import.meta.dirname, "../core/src/internal/relay-runtime.ts"),
			},
			{ find: "@codemem/core", replacement: resolve(import.meta.dirname, "../core/src/index.ts") },
			// Exact match only: `@codemem/mcp/stdio` and `/http` keep their own resolution.
			{
				find: /^@codemem\/mcp$/,
				replacement: resolve(import.meta.dirname, "../mcp-server/src/index.ts"),
			},
		],
		conditions: ["source"],
	},
	// CLI uses Vite SSR mode for build (--ssr flag in package.json build script).
	// Library mode tree-shakes program.parse() away. This lib config is retained
	// for vitest integration; actual build uses SSR via the CLI flag.
	plugins: [executableOutput()],
	build: {
		lib: {
			entry: resolve(import.meta.dirname, "src/index.ts"),
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {
			external: [/^@codemem\//, /^@hono\//, /^node:/, "commander", "chalk", "hono"],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "cli",
		exclude: [
			"src/index.smoke.test.ts",
			"scripts/semantic-worker-installed.test.mjs",
			".opencode/**",
			"node_modules/**",
		],
	},
});
