import { defineConfig } from "vitest/config";

export default defineConfig({
	build: {
		lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
		rollupOptions: { external: ["@xenova/transformers", /^node:/] },
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: { name: "embeddings", include: ["src/**/*.test.ts"] },
});
