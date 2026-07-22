import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { CoordinatorScope, CoordinatorScopeMembership } from "./coordinator-store-contract.js";
import type { Database as CoreDatabase } from "./db.js";
import {
	clearRecipientPolicyDenyOverlay,
	putRecipientPolicyDenyOverlay,
} from "./recipient-policy-reconciliation.js";
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

	it("hydrates the cache through enrolled-device coordinator endpoints without an admin secret", async () => {
		const local = setup();
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-scope-cache-keys-"));
		const previousFetch = globalThis.fetch;
		try {
			const seenUrls: string[] = [];
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				seenUrls.push(url);
				expect(init?.body ?? null).toBeNull();
				const headers = new Headers(init?.headers);
				expect(headers.get("X-Opencode-Device")).toBeTruthy();
				expect(headers.get("X-Opencode-Signature")).toBeTruthy();
				expect(headers.get("X-Opencode-Timestamp")).toBeTruthy();
				expect(headers.get("X-Opencode-Nonce")).toBeTruthy();
				if (url.endsWith("/v1/scopes?group_id=team-a")) {
					return new Response(JSON.stringify({ items: [scope()] }), { status: 200 });
				}
				if (url.endsWith("/v1/scopes/scope-acme/members?group_id=team-a")) {
					return new Response(JSON.stringify({ items: [membership()] }), { status: 200 });
				}
				return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
			}) as typeof fetch;

			const result = await refreshScopeMembershipCache(local, {
				groupIds: ["team-a"],
				coordinatorId: "https://coord.example.test",
				remoteUrl: "https://coord.example.test",
				adminSecret: null,
				keysDir,
				now: new Date(now()),
			});

			expect(result).toMatchObject({ status: "refreshed" });
			expect(seenUrls).toEqual([
				"https://coord.example.test/v1/scopes?group_id=team-a",
				"https://coord.example.test/v1/scopes/scope-acme/members?group_id=team-a",
			]);
			expect(
				getCachedScopeAuthorization(local, { deviceId: "device-a", scopeId: "scope-acme" }),
			).toMatchObject({ authorized: true, state: "authorized" });
		} finally {
			globalThis.fetch = previousFetch;
			rmSync(keysDir, { recursive: true, force: true });
		}
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

	it("keeps an exact policy deny ahead of stale active membership until foundation clearing", async () => {
		const local = setup();
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now()),
			fetchers: {
				listScopes: async () => [scope(), scope({ scope_id: "scope-oss" })],
				listMemberships: async (_groupId, scopeId) => [
					membership({ scope_id: scopeId }),
					membership({ scope_id: scopeId, device_id: "device-b" }),
				],
			},
		});
		putRecipientPolicyDenyOverlay(local, {
			canonicalProjectIdentity: "project:acme",
			scopeId: "scope-acme",
			deviceId: "device-a",
			generation: 7,
			reasonCode: "pending_revoke",
			now: now(1),
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

		expect(
			getCachedScopeAuthorization(local, {
				deviceId: "device-a",
				scopeId: "scope-acme",
				now: new Date(now(60_000)),
			}),
		).toMatchObject({ authorized: false, state: "policy_denied", freshness: "stale" });
		expect(
			getCachedScopeAuthorization(local, { deviceId: "device-a", scopeId: "scope-oss" }),
		).toMatchObject({ authorized: true, state: "authorized" });
		expect(
			getCachedScopeAuthorization(local, { deviceId: "device-b", scopeId: "scope-acme" }),
		).toMatchObject({ authorized: true, state: "authorized" });
		expect(
			listCachedScopesForDevice(local, "device-a").memberships.map((item) => item.scope_id),
		).toEqual(["scope-oss"]);
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now(3)),
			fetchers: {
				listScopes: async () => [scope({ membership_epoch: 8 }), scope({ scope_id: "scope-oss" })],
				listMemberships: async (_groupId, scopeId) =>
					scopeId === "scope-acme"
						? [membership({ device_id: "device-b", membership_epoch: 8 })]
						: [
								membership({ scope_id: scopeId }),
								membership({ scope_id: scopeId, device_id: "device-b" }),
							],
			},
		});
		expect(
			getCachedScopeAuthorization(local, { deviceId: "device-a", scopeId: "scope-acme" }),
		).toMatchObject({ authorized: false, state: "policy_denied" });

		expect(
			clearRecipientPolicyDenyOverlay(local, {
				canonicalProjectIdentity: "project:acme",
				scopeId: "scope-acme",
				deviceId: "device-a",
				verifiedGeneration: 8,
			}),
		).toBe(true);
		expect(
			getCachedScopeAuthorization(local, { deviceId: "device-a", scopeId: "scope-acme" }),
		).toMatchObject({ authorized: false, state: "revoked" });
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

	it("allows regrant only when the membership epoch advances", async () => {
		const local = setup();
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now()),
			fetchers: {
				listScopes: async () => [scope({ membership_epoch: 9 })],
				listMemberships: async () => [membership({ membership_epoch: 8, status: "revoked" })],
			},
		});
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now(1)),
			fetchers: {
				listScopes: async () => [scope({ membership_epoch: 9 })],
				listMemberships: async () => [membership({ membership_epoch: 9, status: "active" })],
			},
		});

		expect(
			getCachedScopeAuthorization(local, {
				deviceId: "device-a",
				scopeId: "scope-acme",
				now: new Date(now(2)),
			}),
		).toMatchObject({ authorized: true, state: "authorized" });
	});

	it("detects stale membership epochs without listing the scope as authorized", async () => {
		const local = setup();
		await refreshScopeMembershipCache(local, {
			groupIds: ["team-a"],
			coordinatorId: "coord-a",
			now: new Date(now()),
			fetchers: {
				listScopes: async () => [scope({ membership_epoch: 5 })],
				listMemberships: async () => [membership({ membership_epoch: 3 })],
			},
		});

		expect(
			getCachedScopeAuthorization(local, {
				deviceId: "device-a",
				scopeId: "scope-acme",
			}),
		).toMatchObject({
			authorized: false,
			state: "stale_epoch",
			epoch: { membership_epoch: 3, required_epoch: 5, stale: true },
		});
		expect(listCachedScopesForDevice(local, "device-a").memberships).toEqual([]);
	});

	it("includes revocation limitation payloads for revoked memberships", () => {
		const local = setup();
		upsertCachedScopeMemberships(local, [membership({ membership_epoch: 8, status: "revoked" })]);

		const authorization = getCachedScopeAuthorization(local, {
			deviceId: "device-a",
			scopeId: "scope-acme",
		});

		expect(authorization.revocation).toEqual({
			scope_id: "scope-acme",
			device_id: "device-a",
			membership_epoch: 8,
			prevents_future_sync: true,
			deletes_already_copied_data: false,
			message:
				"Revocation blocks future sync for this Space. It does not remove data already copied to the revoked device; offline devices, backups, copied databases, malicious peers, or old versions may retain data.",
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
