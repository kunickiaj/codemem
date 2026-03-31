import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
					compatibilityFlags: ["nodejs_compat"],
					bindings: {
						CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
						TEST_MIGRATIONS: migrations,
					},
				},
			}),
		],
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
		},
	};
});
