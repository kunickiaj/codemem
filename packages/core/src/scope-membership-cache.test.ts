import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { CoordinatorScope, CoordinatorScopeMembership } from "./coordinator-store-contract.js";
import type { Database as CoreDatabase } from "./db.js";
import {
	getCachedScopeAuthorization,
	listCachedScopesForDevice,
	refreshScopeMembershipCache,
	upsertCachedScopeMemberships,
} from "./scope-membership-cache.js";
import { initTestSchema } from "./test-utils.js";

function now(offsetMs = 0): string {
	return new Date(Date.UTC(2026, 4, 1, 12, 0, 0, offsetMs)).toISOString();
}

function scope(overrides: Partial<CoordinatorScope> = {}): CoordinatorScope {
	return {
		scope_id: "scope-acme",
		label: "Acme Work",
		kind: "team",
		authority_type: "coordinator",
		coordinator_id: "coord-a",
		group_id: "team-a",
		manifest_issuer_device_id: null,
		membership_epoch: 3,
		manifest_hash: "hash-scope",
		status: "active",
		created_at: now(),
		updated_at: now(),
		...overrides,
	};
}

function membership(
	overrides: Partial<CoordinatorScopeMembership> = {},
): CoordinatorScopeMembership {
	return {
		scope_id: "scope-acme",
		device_id: "device-a",
		role: "member",
		status: "active",
		membership_epoch: 3,
		coordinator_id: "coord-a",
		group_id: "team-a",
		manifest_issuer_device_id: null,
		manifest_hash: "hash-member",
		signed_manifest_json: null,
		updated_at: now(),
		...overrides,
	};
}

describe("scope membership cache", () => {
	let db: CoreDatabase | null = null;

	afterEach(() => {
		db?.close();
		db = null;
	});

	function setup(): CoreDatabase {
		db = new Database(":memory:");
		initTestSchema(db);
		return db;
	}

	it("caches coordinator scopes and active memberships for deterministic device lookups", async () => {
		const local = setup();
		const result = await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now()),
			fetchers: {
				listScopes: async () => [scope()],
				listMemberships: async () => [membership()],
			},
		});

		expect(result).toMatchObject({ status: "refreshed", coordinatorId: "coord-a" });
		const cached = listCachedScopesForDevice(local, "device-a", {
			now: new Date(now(1)),
			authority: { coordinatorId: "coord-a", groupId: "team-a" },
		});
		expect(cached.freshness).toBe("fresh");
		expect(cached.memberships).toEqual([
			expect.objectContaining({
				scope_id: "scope-acme",
				device_id: "device-a",
				status: "active",
				scope: expect.objectContaining({ label: "Acme Work" }),
			}),
		]);
	});

	it("keeps cached authorization visible as stale when coordinator refresh fails", async () => {
		const local = setup();
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now()),
			fetchers: {
				listScopes: async () => [scope()],
				listMemberships: async () => [membership()],
			},
		});

		const stale = await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now(2)),
			fetchers: {
				listScopes: async () => {
					throw new Error("coordinator offline");
				},
				listMemberships: async () => [],
			},
		});

		expect(stale.status).toBe("stale");
		const cached = listCachedScopesForDevice(local, "device-a", {
			now: new Date(now(3)),
			authority: { coordinatorId: "coord-a", groupId: "team-a" },
		});
		expect(cached.freshness).toBe("stale");
		expect(cached.memberships).toHaveLength(1);

		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now(4)),
			fetchers: {
				listScopes: async () => [scope()],
				listMemberships: async () => [membership()],
			},
		});

		expect(
			listCachedScopesForDevice(local, "device-a", {
				now: new Date(now(5)),
				authority: { coordinatorId: "coord-a", groupId: "team-a" },
			}).freshness,
		).toBe("fresh");
	});

	it("filters device lookups by requested coordinator and group authority", async () => {
		const local = setup();
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a", "team-b"],
			coordinatorId: "coord-a",
			now: new Date(now()),
			fetchers: {
				listScopes: async (groupId) => [
					scope({
						scope_id: groupId === "team-a" ? "scope-acme" : "scope-oss",
						group_id: groupId,
					}),
				],
				listMemberships: async (groupId, scopeId) => [
					membership({ group_id: groupId, scope_id: scopeId }),
				],
			},
		});

		const teamA = listCachedScopesForDevice(local, "device-a", {
			authority: { coordinatorId: "coord-a", groupId: "team-a" },
		});
		const teamB = listCachedScopesForDevice(local, "device-a", {
			authority: { coordinatorId: "coord-a", groupId: "team-b" },
		});

		expect(teamA.memberships.map((item) => item.scope_id)).toEqual(["scope-acme"]);
		expect(teamB.memberships.map((item) => item.scope_id)).toEqual(["scope-oss"]);
	});

	it("normalizes missing coordinator authority from refreshed remote payloads", async () => {
		const local = setup();
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "https://coord.example",
			now: new Date(now()),
			fetchers: {
				listScopes: async () => [scope({ coordinator_id: null, group_id: null })],
				listMemberships: async () => [membership({ coordinator_id: null, group_id: null })],
			},
		});

		const authorization = getCachedScopeAuthorization(local, {
			deviceId: "device-a",
			scopeId: "scope-acme",
			now: new Date(now(1)),
		});
		expect(authorization).toMatchObject({ authorized: true, freshness: "fresh" });
		expect(authorization.membership).toMatchObject({
			coordinator_id: "https://coord.example",
			group_id: "team-a",
		});
	});

	it("distinguishes fresh no-authorization from stale unknown authorization", async () => {
		const local = setup();
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now()),
			fetchers: {
				listScopes: async () => [scope()],
				listMemberships: async () => [],
			},
		});

		const freshMiss = getCachedScopeAuthorization(local, {
			deviceId: "device-a",
			scopeId: "scope-acme",
			now: new Date(now(1)),
			authority: { coordinatorId: "coord-a", groupId: "team-a" },
		});
		expect(freshMiss).toMatchObject({
			authorized: false,
			state: "not_authorized",
			freshness: "fresh",
		});

		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now(2)),
			fetchers: {
				listScopes: async () => {
					throw new Error("coordinator offline");
				},
				listMemberships: async () => [],
			},
		});

		const staleMiss = getCachedScopeAuthorization(local, {
			deviceId: "device-a",
			scopeId: "scope-acme",
			now: new Date(now(3)),
			authority: { coordinatorId: "coord-a", groupId: "team-a" },
		});
		expect(staleMiss).toMatchObject({
			authorized: false,
			state: "not_authorized",
			freshness: "stale",
		});
	});

	it("reconciles removed memberships on a successful authoritative refresh", async () => {
		const local = setup();
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now()),
			fetchers: {
				listScopes: async () => [scope()],
				listMemberships: async () => [membership()],
			},
		});
		expect(
			getCachedScopeAuthorization(local, {
				deviceId: "device-a",
				scopeId: "scope-acme",
				now: new Date(now(1)),
			}).authorized,
		).toBe(true);

		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now(2)),
			fetchers: {
				listScopes: async () => [scope({ membership_epoch: 4 })],
				listMemberships: async () => [],
			},
		});

		expect(
			getCachedScopeAuthorization(local, {
				deviceId: "device-a",
				scopeId: "scope-acme",
				now: new Date(now(3)),
			}),
		).toMatchObject({ authorized: false, state: "revoked", freshness: "fresh" });
	});

	it("reconciles omitted scopes on a successful authoritative refresh", async () => {
		const local = setup();
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now()),
			fetchers: {
				listScopes: async () => [scope()],
				listMemberships: async () => [membership()],
			},
		});

		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now(1)),
			fetchers: {
				listScopes: async () => [],
				listMemberships: async () => [],
			},
		});

		expect(
			getCachedScopeAuthorization(local, {
				deviceId: "device-a",
				scopeId: "scope-acme",
				now: new Date(now(2)),
			}),
		).toMatchObject({ authorized: false, state: "revoked", freshness: "fresh" });
		expect(listCachedScopesForDevice(local, "device-a").memberships).toEqual([]);
	});

	it("does not let stale active grants resurrect revoked memberships", () => {
		const local = setup();
		upsertCachedScopeMemberships(local, [membership({ membership_epoch: 8, status: "revoked" })]);
		upsertCachedScopeMemberships(local, [membership({ membership_epoch: 7, status: "active" })]);

		const authorization = getCachedScopeAuthorization(local, {
			deviceId: "device-a",
			scopeId: "scope-acme",
		});
		expect(authorization).toMatchObject({
			authorized: false,
			state: "revoked",
		});
	});

	it("does not authorize active memberships when scope metadata is missing", () => {
		const local = setup();
		upsertCachedScopeMemberships(local, [membership()]);

		const authorization = getCachedScopeAuthorization(local, {
			deviceId: "device-a",
			scopeId: "scope-acme",
		});

		expect(authorization).toMatchObject({
			authorized: false,
			state: "scope_unknown",
			freshness: "unknown",
			scope: null,
		});
		expect(listCachedScopesForDevice(local, "device-a").memberships).toEqual([]);
	});

	it("does not authorize a membership from a different requested authority", async () => {
		const local = setup();
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-b"],
			coordinatorId: "coord-b",
			now: new Date(now()),
			fetchers: {
				listScopes: async () => [scope({ coordinator_id: "coord-b", group_id: "team-b" })],
				listMemberships: async () => [
					membership({ coordinator_id: "coord-b", group_id: "team-b" }),
				],
			},
		});

		const authorization = getCachedScopeAuthorization(local, {
			deviceId: "device-a",
			scopeId: "scope-acme",
			authority: { coordinatorId: "coord-a", groupId: "team-a" },
		});

		expect(authorization).toMatchObject({
			authorized: false,
			state: "not_authorized",
			scope: null,
		});
	});
});
