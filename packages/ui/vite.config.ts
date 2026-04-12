import { execSync } from "node:child_process";
import { resolve } from "node:path";

import preact from "@preact/preset-vite";
import type { OutputChunk, OutputOptions } from "rollup";
import { defineConfig } from "vitest/config";

function isOutputChunk(value: unknown): value is OutputChunk {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"type" in value &&
		(value as { type?: string }).type === "chunk"
	);
}

function resolveGitCommit(): string {
	try {
		return execSync("git rev-parse --short=7 HEAD", {
			cwd: __dirname,
			encoding: "utf-8",
		})
			.trim()
			.slice(0, 7);
	} catch {
		return "";
	}
}

const gitCommit = resolveGitCommit();

export default defineConfig(({ mode }) => ({
	define: {
		__CODEMEM_GIT_COMMIT__: JSON.stringify(gitCommit),
	},
	resolve: {
		alias: {
			react: "preact/compat",
			"react-dom": "preact/compat",
			"react-dom/test-utils": "preact/test-utils",
			"react/jsx-runtime": "preact/jsx-runtime",
		},
	},
	build: {
		outDir: resolve(__dirname, "../viewer-server/static"),
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
	plugins: [
		preact(),
		...(mode === "development"
			? []
			: [
					{
						name: "strip-sourcemap-url",
						generateBundle(_options: OutputOptions, bundle) {
							for (const output of Object.values(bundle)) {
								if (isOutputChunk(output) && output.fileName === "app.js") {
									output.code = output.code.replace(/^\s*\/\/#\s*sourceMappingURL=.*$/gm, "");
								}
							}
						},
					},
				]),
	],
	esbuild: {
		legalComments: "none",
	},
	test: {
		environment: "jsdom",
		name: "ui",
	},
}));
