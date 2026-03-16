import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// CLI uses Vite SSR mode for build (--ssr flag in package.json build script).
	// Library mode tree-shakes program.parse() away. This lib config is retained
	// for vitest integration; actual build uses SSR via the CLI flag.
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
