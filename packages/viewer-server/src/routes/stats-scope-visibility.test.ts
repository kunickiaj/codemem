import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, recordAutomaticRecall, recordRetrievalAttempt } from "@codemem/core";
import { expect, it, vi } from "vitest";
import { ed25519KeyId } from "../../../core/src/coordinator-ed25519-key-id.js";
import {
	refreshScopeMembershipCache,
	upsertCachedScopeMemberships,
} from "../../../core/src/scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "../../../core/src/scope-membership-cache-test-fixtures.js";
import {
	ensureDeviceIdentity,
	fingerprintPublicKey,
	generateKeypair,
	loadPublicKey,
	resolveKeyPaths,
} from "../../../core/src/sync-identity.js";
import { insertTestSession } from "../../../core/src/test-utils.js";
import { statsRoutes } from "./stats.js";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFileSync: vi.fn(() => {
		throw new Error("External subprocess disabled in tests");
	}),
}));

async function seedManagedStatsProof(store: MemoryStore, keysDir: string) {
	ensureDeviceIdentity(store.db, { keysDir, deviceId: store.deviceId });
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Missing fixture signing key");
	const snapshot = cacheWireSnapshot(cacheScope(), [cacheMember(cacheScope(), store.deviceId)]);
	const item = snapshot.items[0];
	if (!item) throw new Error("Missing fixture enrollment");
	item.enrollment.public_key = publicKey;
	item.enrollment.fingerprint = fingerprintPublicKey(publicKey);
	item.key_id = (await ed25519KeyId(publicKey)) ?? "";
	expect(
		await refreshScopeMembershipCache(store.db, {
			coordinatorId: "server-a",
			groupIds: ["group-a"],
			now: new Date(cacheTime),
			fetchers: {
				listScopes: async () => ({ version: 1, items: [snapshot.scope] }),
				getScopeSnapshot: async () => snapshot,
			},
		}),
	).toMatchObject({ status: "refreshed" });
	store.db
		.prepare(`INSERT INTO replication_scopes
		(scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
		SELECT 'unproven', label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at
		FROM replication_scopes WHERE scope_id = 'scope-a'`)
		.run();
	upsertCachedScopeMemberships(store.db, [
		cacheMember(cacheScope({ scope_id: "unproven" }), store.deviceId),
	]);
}

function seedStatsSignals(store: MemoryStore): number[] {
	return ["local-default", "scope-a", "unproven"].map((scopeId, index) => {
		const sessionId = insertTestSession(store.db);
		const importKey = `stats-replica-${index}`;
		const id = Number(
			store.db
				.prepare(`INSERT INTO memory_items
			(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at,
			 metadata_json, rev, visibility, scope_id, origin_device_id, import_key, actor_id)
			VALUES (?, 'discovery', 'Stats fixture', 'body', 0.5, '', 1, ?, ?, '{}', 1, 'shared', ?, 'foreign', ?, ?)`)
				.run(sessionId, cacheTime, cacheTime, scopeId, importKey, store.actorId).lastInsertRowid,
		);
		store.db
			.prepare(`INSERT INTO usage_events
			(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
			VALUES (?, 'pack', 20, 0, 10, ?, ?)`)
			.run(sessionId, cacheTime, JSON.stringify({ pack_item_ids: [id] }));
		const attemptId = `018f2db4-f9d3-7a22-8d18-${(index + 1).toString().padStart(12, "0")}`;
		recordRetrievalAttempt(store.db, {
			attemptId,
			startedAt: cacheTime,
			source: "opencode",
			requestId: `stats-request-${index}`,
			surface: "prompt_pack",
			trigger: "automatic",
			recorderVersion: "test",
			deliveryStatus: "not_attempted",
			retrievalStatus: "succeeded",
			candidateCount: 1,
			selectedCount: 1,
			outputTokens: 20,
			exposures: [
				{
					rank: 1,
					disposition: "selected",
					handoffStatus: "not_attempted",
					memoryId: id,
					memoryImportKey: importKey,
				},
			],
		});
		expect(
			recordAutomaticRecall(store.db, attemptId, String(index + 1).repeat(64), {
				v: 1,
				candidateItems: 1,
				duplicatesOmitted: 0,
				beforeTokens: 20,
				afterTokens: 20,
				missingRetainedMetadata: false,
				invalidRetainedMetadata: false,
				packMetadata: "valid",
			}).ok,
		).toBe(true);
		return id;
	});
}

it.each([false, true])(
	"stats uses verified runtime scope context (wrong key: %s)",
	async (wrongKey) => {
		// Arrange: same actor labels on foreign replicas never replace current scope proof.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(cacheTime));
		const directory = mkdtempSync(join(tmpdir(), "codemem-stats-scopes-"));
		const keysDir = join(directory, "keys");
		const runtimeKeysDir = wrongKey ? join(directory, "replacement-keys") : keysDir;
		const store = new MemoryStore(join(directory, "test.sqlite"), { keysDir: runtimeKeysDir });
		try {
			await seedManagedStatsProof(store, keysDir);
			const ids = seedStatsSignals(store);
			if (wrongKey) generateKeypair(...resolveKeyPaths(runtimeKeysDir));
			const app = statsRoutes(() => store);
			// Act
			const statsResponse = await app.request("/api/stats");
			const stats = await statsResponse.json();
			const usageResponse = await app.request("/api/usage");
			const usage = await usageResponse.json();
			// Assert: database totals, usage events, and recall health agree with normal reads.
			const expectedCount = wrongKey ? 1 : 2;
			expect(statsResponse.status).toBe(200);
			expect(usageResponse.status).toBe(200);
			expect(stats.database.memory_items).toBe(expectedCount);
			expect(stats.automatic_recall.freshEvaluations).toBe(expectedCount);
			// Usage totals intentionally remain global; only recent packs are scope-filtered.
			expect(usage.totals.count).toBe(3);
			expect(
				usage.recent_packs
					.map(
						(row: { metadata_json: { pack_item_ids: number[] } }) =>
							row.metadata_json.pack_item_ids[0],
					)
					.sort(),
			).toEqual(ids.slice(0, expectedCount).sort());
			expect(store.get(ids[1] ?? 0) !== null).toBe(!wrongKey);
			expect(store.get(ids[2] ?? 0)).toBeNull();
			expect(store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get()).toEqual({
				count: 3,
			});
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
			vi.useRealTimers();
		}
	},
);
