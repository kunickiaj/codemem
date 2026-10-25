import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

	return {
		resolve: {
			alias: {
				"@codemem/core/internal/cloudflare-coordinator": path.resolve(
					import.meta.dirname,
					"../core/src/internal/cloudflare-coordinator.ts",
				),
				"@codemem/core": path.resolve(import.meta.dirname, "../core/src/index.ts"),
			},
			conditions: ["source"],
		},
		plugins: [
			cloudflareTest({
				wrangler: {
					configPath: path.resolve(import.meta.dirname, "wrangler.jsonc"),
				},
				miniflare: {
					bindings: {
						CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
						TEST_MIGRATIONS: migrations,
					},
				},
			}),
		],
		test: {
			include: ["test/**/*.integration.test.ts"],
			setupFiles: ["./test/apply-migrations.ts"],
			// Migrations and Wrangler config load outside the import graph, so PR test
			// selection (`--changed`) runs everything when they change.
			forceRerunTriggers: [
				...configDefaults.forceRerunTriggers,
				"**/vitest.*.config.*",
				"**/pnpm-lock.yaml",
				"**/pnpm-workspace.yaml",
				"**/tsconfig*.json",
				"**/migrations/**",
				"**/wrangler.jsonc",
				"**/test/apply-migrations.ts",
			],
		},
	};
});
