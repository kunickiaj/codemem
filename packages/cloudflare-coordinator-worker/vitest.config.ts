import { createPublicKey, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
	// A disposable relay service key generated per run. No key material is committed.
	const { privateKey: relayPrivateKey } = generateKeyPairSync("ed25519");
	const relayServiceKey = relayPrivateKey
		.export({ format: "der", type: "pkcs8" })
		.toString("base64");
	// Node derives the client-facing SSH public key independently of the Worker's WebCrypto import.
	const relayPublicWire = Buffer.concat([
		Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
		createPublicKey(relayPrivateKey).export({ format: "der", type: "spki" }).subarray(-32),
	]);

	return {
		resolve: {
			alias: {
				"@codemem/core/internal/cloudflare-coordinator": path.resolve(
					import.meta.dirname,
					"../core/src/internal/cloudflare-coordinator.ts",
				),
				"@codemem/core/internal/relay-host": path.resolve(
					import.meta.dirname,
					"../core/src/internal/relay-host.ts",
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
				// Test-only entry adds the quota Durable Object without changing production config.
				main: path.resolve(import.meta.dirname, "test/relay-quota-do-worker.ts"),
				miniflare: {
					durableObjects: {
						RELAY_QUOTA_TEST: { className: "RelayQuotaTestObject", useSQLite: true },
						RELAY_REALM_TEST: { className: "RelayRealmTestObject", useSQLite: true },
						RELAY_REALM_PRODUCTION: { className: "RelayRealm", useSQLite: true },
					},
					bindings: {
						CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
						TEST_MIGRATIONS: migrations,
						// Relay settings for the test realm object only. Production sets none of these.
						CODEMEM_RELAY_AUTHORITY_URL: "https://coordinator.example.test/sync",
						CODEMEM_RELAY_GROUPS: JSON.stringify(["relay-test-group", "relay-other-group"]),
						CODEMEM_RELAY_SERVICE_KEY: relayServiceKey,
						RELAY_TEST_SERVICE_PUBLIC_KEY: `ssh-ed25519 ${relayPublicWire.toString("base64")}`,
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
				"**/test/relay-quota-do-worker.ts",
				"**/test/relay-quota-do-object.ts",
				"**/test/relay-realm-do-object.ts",
			],
		},
	};
});
