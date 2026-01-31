import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
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
    sourcemap: true,
    minify: false,
  },
});
