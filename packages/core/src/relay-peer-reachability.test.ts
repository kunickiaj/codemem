import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { RELAY_LOGICAL_ORIGIN } from "./relay-client-config.js";
import type { RelayPeerClient } from "./relay-peer-client.js";
import { createRelayPeerReachability, relayPeerScopes } from "./relay-peer-reachability.js";
import { cacheTime, refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const COORDINATOR = "https://coord.example";
const SCOPES = [
	{ scopeId: "space-b", groupId: "group-2" },
	{ scopeId: "space-a", groupId: "group-1" },
	{ scopeId: "space-c", groupId: "group-1" },
];

async function seedSharedSpaces(db: InstanceType<typeof Database>): Promise<void> {
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES ('local', ?, ?, ?)",
	).run(CANONICAL_PUBLIC_KEY, fingerprintPublicKey(CANONICAL_PUBLIC_KEY), cacheTime);
	for (const peer of ["peer", "loner"]) {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES (?, ?, ?, ?)",
		).run(peer, fingerprintPublicKey(CANONICAL_PUBLIC_KEY), CANONICAL_PUBLIC_KEY, cacheTime);
	}
	for (const { scopeId, groupId } of SCOPES) {
		db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
			VALUES (?, 'Project', 'managed_project', 'coordinator', ?, ?, 1, 'active', ?, ?)`).run(
			scopeId,
			COORDINATOR,
			groupId,
			cacheTime,
			cacheTime,
		);
		// "space-c" is local-only, so the loner shares nothing and the peer shares two Spaces.
		const members = scopeId === "space-c" ? ["local"] : ["local", "peer"];
		for (const deviceId of members) {
			db.prepare(
				"INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at) VALUES (?, ?, 'member', 'active', 1, ?)",
			).run(scopeId, deviceId, cacheTime);
		}
	}
	await refreshTestScopeRows(db);
	for (const groupId of ["group-1", "group-2"]) {
		db.prepare(`INSERT OR REPLACE INTO scope_membership_cache_state(
			coordinator_id, group_id, last_refresh_at, last_success_at, last_error, updated_at
		) VALUES (?, ?, ?, ?, NULL, ?)`).run(COORDINATOR, groupId, cacheTime, cacheTime, cacheTime);
	}
}

describe("relay peer reachability", () => {
	let db: InstanceType<typeof Database>;
	const groupOne = { name: "group-1" } as unknown as RelayPeerClient;
	const groupTwo = { name: "group-2" } as unknown as RelayPeerClient;
	const clients = new Map([
		["group-1", groupOne],
		["group-2", groupTwo],
	]);

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(cacheTime));
		db = new Database(":memory:");
		initTestSchema(db);
		await seedSharedSpaces(db);
	});
	afterEach(() => {
		db.close();
		vi.useRealTimers();
	});

	it("lists every shared managed Space in scope ID order", () => {
		expect(relayPeerScopes(db, "peer", COORDINATOR)).toEqual([
			{ scopeId: "space-a", groupId: "group-1" },
			{ scopeId: "space-b", groupId: "group-2" },
		]);
		expect(relayPeerScopes(db, "peer", "https://other.example")).toEqual([]);
	});

	it("rotates shared Spaces across ticks and routes each through its group's client", () => {
		// Arrange.
		const resolver = createRelayPeerReachability({
			coordinatorId: COORDINATOR,
			clientForGroup: (groupId) => clients.get(groupId),
			clients: () => [...clients.values()],
		});
		// Act: three daemon ticks.
		const routes = [0, 1, 2].map(() => resolver.forPeer(db, "peer"));
		// Assert.
		expect(routes).toEqual([
			{ scopeId: "space-a", logicalOrigin: RELAY_LOGICAL_ORIGIN, relay: groupOne },
			{ scopeId: "space-b", logicalOrigin: RELAY_LOGICAL_ORIGIN, relay: groupTwo },
			{ scopeId: "space-a", logicalOrigin: RELAY_LOGICAL_ORIGIN, relay: groupOne },
		]);
		expect(resolver.clients()).toEqual([groupOne, groupTwo]);
	});

	it("gives no relay route to a peer without a shared managed Space or group client", () => {
		const resolver = createRelayPeerReachability({
			coordinatorId: COORDINATOR,
			clientForGroup: (groupId) => (groupId === "group-2" ? groupTwo : undefined),
			clients: () => [groupTwo],
		});
		expect(resolver.forPeer(db, "loner")).toBeUndefined();
		expect(resolver.forPeer(db, "unknown")).toBeUndefined();
		// Only the Space whose group has a client rotates.
		expect([resolver.forPeer(db, "peer"), resolver.forPeer(db, "peer")]).toEqual([
			{ scopeId: "space-b", logicalOrigin: RELAY_LOGICAL_ORIGIN, relay: groupTwo },
			{ scopeId: "space-b", logicalOrigin: RELAY_LOGICAL_ORIGIN, relay: groupTwo },
		]);
	});
});
