import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: {
		compilerOptions: {
			composite: false,
		},
	},
	clean: true,
	sourcemap: true,
	external: ["better-sqlite3", "sqlite-vec"],
});
