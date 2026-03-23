import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./packages/core/src/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url: process.env.CODEMEM_DB ?? "./.codemem/mem.sqlite",
	},
});
