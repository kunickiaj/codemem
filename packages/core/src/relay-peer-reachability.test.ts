import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import * as coordinatorRuntime from "./coordinator-runtime.js";
import { sharedManagedScopes } from "./coordinator-runtime.js";
import { RELAY_LOGICAL_ORIGIN } from "./relay-client-config.js";
import type { RelayPeerClient } from "./relay-peer-client.js";
import { createRelayPeerReachability, relayPeerScopes } from "./relay-peer-reachability.js";
import * as scopeMembershipCache from "./scope-membership-cache.js";
import { cacheTime, refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { syncDaemonTick } from "./sync-daemon.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { runSyncPass } from "./sync-orchestration.js";
import { initTestSchema } from "./test-utils.js";

vi.mock("./sync-orchestration.js", () => ({ runSyncPass: vi.fn() }));

const COORDINATOR = "https://coord.example";
const SCOPES = [
	{ scopeId: "space-b", groupId: "group-2", kind: "team" },
	{ scopeId: "space-a", groupId: "group-1", kind: "managed_project" },
	{ scopeId: "space-c", groupId: "group-1", kind: "managed_project" },
	{ scopeId: "space-d", groupId: "group-1", kind: "user" },
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
	for (const { scopeId, groupId, kind } of SCOPES) {
		db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
			VALUES (?, 'Space', ?, 'coordinator', ?, ?, 1, 'active', ?, ?)`).run(
			scopeId,
			kind,
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

let db: InstanceType<typeof Database>;
const groupOne = { name: "group-1" } as unknown as RelayPeerClient;
const groupTwo = { name: "group-2" } as unknown as RelayPeerClient;
const clients = new Map([
	["group-1", groupOne],
	["group-2", groupTwo],
]);

function prepareLaterPeer() {
	db.prepare("DELETE FROM sync_peers").run();
	for (const peer of ["loner", "peer"]) {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id,pinned_fingerprint,public_key,created_at) VALUES (?,?,?,?)",
		).run(peer, fingerprintPublicKey(CANONICAL_PUBLIC_KEY), CANONICAL_PUBLIC_KEY, cacheTime);
	}
	const config = {
		...coordinatorRuntime.readCoordinatorSyncConfig({}),
		syncCoordinatorUrl: COORDINATOR,
		syncCoordinatorGroups: ["group-1", "group-2"],
		syncCoordinatorAdminSecret: null,
	};
	vi.spyOn(coordinatorRuntime, "readCoordinatorSyncConfig").mockReturnValue(config);
	const resolver = createRelayPeerReachability({
		coordinatorId: COORDINATOR,
		clientForGroup: (groupId) => clients.get(groupId),
		clients: () => [...clients.values()],
	});
	vi.mocked(runSyncPass).mockImplementation(async (_db, peer) => {
		if (peer === "loner") vi.setSystemTime(Date.now() + 61000);
		return { ok: true, opsIn: 0, opsOut: 0 };
	});
	return { config, resolver };
}

beforeEach(async () => {
	vi.mocked(runSyncPass).mockReset();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(cacheTime));
	db = new Database(":memory:");
	initTestSchema(db);
	await seedSharedSpaces(db);
});
afterEach(() => {
	db.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("relay peer reachability", () => {
	// space-b is a coordinator team Space and space-d another kind, so relay carries the
	// first and skips the second, while Project-only callers still see only space-a.
	it("lists every shared Project and team Space in scope ID order", () => {
		expect(relayPeerScopes(db, "peer", COORDINATOR)).toEqual([
			{ scopeId: "space-a", groupId: "group-1" },
			{ scopeId: "space-b", groupId: "group-2" },
		]);
		expect(relayPeerScopes(db, "peer", "https://other.example")).toEqual([]);
		const projectsOnly = sharedManagedScopes(db, {
			localDeviceId: "local",
			peerDeviceId: "peer",
			coordinatorId: COORDINATOR,
			peerGroupIds: null,
			peerPublicKey: CANONICAL_PUBLIC_KEY,
		});
		expect(projectsOnly.scopes).toEqual([{ scopeId: "space-a", groupId: "group-1" }]);
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

describe("daemon relay permission revalidation", () => {
	it("revalidates a later peer's relay route after an earlier peer takes over a minute", async () => {
		const { config, resolver } = prepareLaterPeer();
		expect(relayPeerScopes(db, "peer", COORDINATOR)).toHaveLength(2);
		const refresh = vi
			.spyOn(scopeMembershipCache, "refreshConfiguredScopeMembershipCache")
			.mockImplementation(async (_db, _config, options) => {
				expect(options?.onlyIfStale).toBe(true);
				if (relayPeerScopes(db, "peer", COORDINATOR).length > 0)
					return { status: "skipped", coordinatorId: COORDINATOR, groups: [] };
				await refreshTestScopeRows(db, {}, { now: new Date() });
				return { status: "refreshed", coordinatorId: COORDINATOR, groups: [] };
			});
		await syncDaemonTick(db, "/fixture/keys", undefined, undefined, ":memory:", resolver);
		const later = vi.mocked(runSyncPass).mock.calls.find(([, peer]) => peer === "peer");
		expect(later).toBeDefined();
		expect(later?.[2]?.reachability).toEqual(
			expect.objectContaining({ scopeId: "space-a", relay: groupOne }),
		);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(refresh).toHaveBeenLastCalledWith(db, config, {
			keysDir: "/fixture/keys",
			dbPath: ":memory:",
			onlyIfStale: true,
		});
		expect(relayPeerScopes(db, "peer", COORDINATOR)).toHaveLength(2);
	});

	it.each(["stale", "partial", "throw"] as const)(
		"limits a %s on-demand refresh to one failure per tick and keeps direct fallback",
		async (status) => {
			const { resolver } = prepareLaterPeer();
			db.prepare(
				"INSERT INTO sync_peers(peer_device_id,pinned_fingerprint,public_key,created_at) VALUES ('after-peer',?,?,?)",
			).run(fingerprintPublicKey(CANONICAL_PUBLIC_KEY), CANONICAL_PUBLIC_KEY, cacheTime);
			vi.spyOn(console, "error").mockImplementation(() => {});
			const refresh = vi
				.spyOn(scopeMembershipCache, "refreshConfiguredScopeMembershipCache")
				.mockImplementation(async () => {
					if (Date.now() - Date.parse(cacheTime) <= 60000)
						return { status: "skipped", coordinatorId: COORDINATOR, groups: [] };
					if (status === "throw") throw new Error("fixture refresh unavailable");
					return { status, coordinatorId: COORDINATOR, groups: [] };
				});
			await syncDaemonTick(db, undefined, undefined, undefined, undefined, resolver);
			expect(refresh).toHaveBeenCalledTimes(2);
			expect(vi.mocked(runSyncPass).mock.calls.map(([, peer]) => peer)).toEqual([
				"loner",
				"peer",
				"after-peer",
			]);
			expect(
				vi.mocked(runSyncPass).mock.calls.every(([, , options]) => !options?.reachability),
			).toBe(true);
			await syncDaemonTick(db, undefined, undefined, undefined, undefined, resolver);
			expect(refresh).toHaveBeenCalledTimes(3);
		},
	);

	it("keeps a peer direct-only when revalidation removes its membership", async () => {
		const { resolver } = prepareLaterPeer();
		vi.spyOn(scopeMembershipCache, "refreshConfiguredScopeMembershipCache").mockImplementation(
			async () => {
				if (relayPeerScopes(db, "peer", COORDINATOR).length > 0)
					return { status: "skipped", coordinatorId: COORDINATOR, groups: [] };
				db.prepare("DELETE FROM scope_memberships WHERE device_id='peer'").run();
				await refreshTestScopeRows(db, {}, { now: new Date() });
				return { status: "refreshed", coordinatorId: COORDINATOR, groups: [] };
			},
		);
		await syncDaemonTick(db, undefined, undefined, undefined, undefined, resolver);
		const later = vi.mocked(runSyncPass).mock.calls.find(([, peer]) => peer === "peer");
		expect(later).toBeDefined();
		expect(later?.[2]?.reachability).toBeUndefined();
		expect(relayPeerScopes(db, "peer", COORDINATOR)).toEqual([]);
	});
});
