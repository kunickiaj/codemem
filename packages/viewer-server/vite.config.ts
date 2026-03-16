import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Library mode for now. Will switch to full app mode with dev server
// when we build out the viewer UI integration and sync daemon.
export default defineConfig({
	build: {
		lib: {
			entry: resolve(import.meta.dirname, "src/index.ts"),
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {
			external: [/^@codemem\//, /^node:/],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "viewer-server",
	},
});
