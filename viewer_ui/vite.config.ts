import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  build: {
    outDir: resolve(__dirname, "../opencode_mem/viewer_static"),
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/app.ts"),
      name: "OpencodeMemViewer",
      formats: ["iife"],
      fileName: () => "app.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    // Sourcemaps in development only; avoid shipping debug payload by default.
    sourcemap: mode === "development",
    minify: false,
  },
}));
