import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	ensureScopeBackfillScopes,
	getSyncResetState,
	initTestSchema,
	MemoryStore,
} from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import {
	diagnosticDatabaseSnapshot,
	diagnosticKeySnapshot,
	expectedDiagnosticScopes,
	seedSigningStatusFixture,
	selectSigningContext,
	signingContexts,
} from "../../core/src/sync-status-test-fixtures.js";
import { createApp } from "./index.js";

describe("viewer actual runtime signer diagnostics", () => {
	for (const endpoint of ["/api/sync/status", "/api/sync/peers"]) {
		it.each(signingContexts)(
			`${endpoint} reports only authorized received scopes with %s, read-only`,
			async (context) => {
				// Arrange: generated keys and real v1 cache evidence, without reset boundaries.
				const root = mkdtempSync(join(tmpdir(), "viewer-status-signer-test-"));
				const dbPath = join(root, "mem.sqlite");
				const rawDb = connect(dbPath);
				initTestSchema(rawDb);
				rawDb.close();
				const store = new MemoryStore(dbPath);
				vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
				const configPath = join(root, "config.json");
				writeFileSync(configPath, JSON.stringify({ sync_enabled: false }));
				vi.stubEnv("CODEMEM_CONFIG", configPath);
				vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", "");
				vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", "");
				vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUP", "");
				vi.stubGlobal(
					"fetch",
					vi.fn(() => {
						throw new Error("Unexpected network request");
					}),
				);
				try {
					const fixture = await seedSigningStatusFixture(store.db, root);
					vi.stubEnv("CODEMEM_KEYS_DIR", selectSigningContext(store.db, fixture, context));
					// Full status still attempts a legacy default INSERT OR IGNORE; initialize
					// that existing lane before measuring diagnostic scope/reset writes.
					getSyncResetState(store.db);
					ensureScopeBackfillScopes(store.db, "2026-01-01T00:00:00.000Z");
					const beforeDb = diagnosticDatabaseSnapshot(store.db);
					const beforeKeys = diagnosticKeySnapshot(root);
					const beforeChanges = store.db.prepare("SELECT total_changes() AS total").get();
					if (endpoint === "/api/sync/peers") store.db.pragma("query_only = ON");
					const app = createApp({ storeFactory: () => store });

					// Act: request the public route entirely in-process, without a server/network.
					const response = await app.request(endpoint);
					const body = (await response.json()) as {
						items?: Array<{
							peer_device_id: string;
							per_scope_sync: Array<{ scope_id: string; bootstrapped: boolean }>;
						}>;
						peers?: Array<{
							peer_device_id: string;
							per_scope_sync: Array<{ scope_id: string; bootstrapped: boolean }>;
						}>;
					};
					const peers = body.items ?? body.peers ?? [];

					// Assert: denied signers cannot convert retained cursors into managed received claims.
					expect(response.status).toBe(200);
					expect(
						peers
							.find((peer) => peer.peer_device_id === "peer-device")
							?.per_scope_sync.map(({ scope_id, bootstrapped }) => ({ scope_id, bootstrapped })),
					).toEqual(expectedDiagnosticScopes(context));
					expect(peers.find((peer) => peer.peer_device_id === "direct-peer")).toMatchObject({
						per_scope_sync: [],
					});
					expect(diagnosticDatabaseSnapshot(store.db)).toEqual(beforeDb);
					expect(store.db.prepare("SELECT total_changes() AS total").get()).toEqual(beforeChanges);
					expect(diagnosticKeySnapshot(root)).toEqual(beforeKeys);
					expect(fetch).not.toHaveBeenCalled();
				} finally {
					vi.unstubAllEnvs();
					vi.unstubAllGlobals();
					store.db.pragma("query_only = OFF");
					store.close();
					rmSync(root, { recursive: true, force: true });
				}
			},
		);
	}
});
