import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

	return {
		plugins: [
			cloudflareTest({
				wrangler: {
					configPath: "./wrangler.jsonc",
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
			setupFiles: ["./test/apply-migrations.ts"],
		},
	};
});
