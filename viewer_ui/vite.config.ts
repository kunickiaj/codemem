import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  build: {
    outDir: resolve(__dirname, "../codemem/viewer_static"),
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
  // In prod builds, explicitly strip any existing sourcemap URL hints.
  plugins:
    mode === "development"
      ? []
      : [
          {
            name: "strip-sourcemap-url",
            generateBundle(_options, bundle) {
              for (const asset of Object.values(bundle)) {
                if (asset.type === "chunk" && asset.fileName === "app.js") {
                  asset.code = asset.code.replace(
                    /^\s*\/\/#\s*sourceMappingURL=.*$/gm,
                    "",
                  );
                }
              }
            },
          },
        ],
  esbuild: {
    legalComments: "none",
  },
}));
