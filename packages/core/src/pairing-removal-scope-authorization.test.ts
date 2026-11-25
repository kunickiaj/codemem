import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorScope } from "./coordinator-store-contract.js";
import { ensureMemoryRetirementDeliverySchema } from "./memory-retirement-delivery-schema.js";
import { removePairingState } from "./pairing-removal.js";
import {
	getEffectiveCachedScopeAuthorization,
	refreshScopeMembershipCache,
} from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import { scopeAuthorizationFailureReason } from "./sync-scope-protocol.js";
import { initTestSchema } from "./test-utils.js";

const COORDINATOR = "server-a";
const LOCAL = "device-local";
const REMOVED = "device-removed";
const KEEP = "device-keep";
const SCOPE_A = cacheScope({ scope_id: "scope-a", group_id: "group-a" });
const SCOPE_B = cacheScope({ scope_id: "scope-b", group_id: "group-b" });
const SCOPES = [SCOPE_A, SCOPE_B];

let db: InstanceType<typeof Database>;

/** One coordinator answer: the members each scope's group currently grants. */
type Grants = Partial<Record<string, string[]>>;

function refreshGroup(scope: CoordinatorScope, members: string[], gate?: Promise<void>) {
	return refreshScopeMembershipCache(db, {
		coordinatorId: COORDINATOR,
		groupIds: [scope.group_id ?? ""],
		now: new Date(cacheTime),
		fetchers: {
			async listScopes() {
				return { version: 1, items: [scope] };
			},
			async getScopeSnapshot() {
				await gate;
				return cacheWireSnapshot(
					scope,
					members.map((deviceId) => cacheMember(scope, deviceId)),
				);
			},
		},
	});
}

async function refresh(grants: Grants) {
	for (const scope of SCOPES) {
		const members = grants[scope.scope_id];
		if (!members) continue;
		const result = await refreshGroup(scope, members);
		expect(result.status).toBe("refreshed");
	}
}

function authorized(deviceId: string, scopeId: string): boolean {
	const authorization = getEffectiveCachedScopeAuthorization(db, { deviceId, scopeId });
	return scopeAuthorizationFailureReason(authorization) === null;
}

function access(deviceId: string) {
	return Object.fromEntries(
		SCOPES.map(({ scope_id }) => [scope_id, authorized(deviceId, scope_id)]),
	);
}

const EVERYWHERE = { "scope-a": true, "scope-b": true };
const NOWHERE = { "scope-a": false, "scope-b": false };
const ALL_MEMBERS = { "scope-a": [LOCAL, REMOVED, KEEP], "scope-b": [LOCAL, REMOVED, KEEP] };

beforeEach(async () => {
	db = new Database(":memory:");
	initTestSchema(db);
	ensureMemoryRetirementDeliverySchema(db);
	await refresh(ALL_MEMBERS);
	expect(access(REMOVED)).toEqual(EVERYWHERE);
});

afterEach(() => db.close());

describe("removing a device ends its cached scope authorization", () => {
	it.each(["removed", "local", "revoked"] as const)(
		"reason %s denies the device on every cached scope and leaves other devices authorized",
		(reason) => {
			removePairingState(db, { localDeviceId: LOCAL, reason, deviceIds: [REMOVED] });

			expect(access(REMOVED)).toEqual(NOWHERE);
			expect(access(KEEP)).toEqual(EVERYWHERE);
			expect(access(LOCAL)).toEqual(EVERYWHERE);
		},
	);

	it.each(["disconnect", "policy"] as const)(
		"reason %s keeps the cached authorization",
		(reason) => {
			removePairingState(
				db,
				reason === "policy"
					? {
							localDeviceId: LOCAL,
							reason,
							pairings: [{ deviceId: REMOVED, coordinatorId: COORDINATOR, groupId: "group-a" }],
						}
					: { localDeviceId: LOCAL, reason, deviceIds: [REMOVED] },
			);

			expect(access(REMOVED)).toEqual(EVERYWHERE);
		},
	);

	it("never ends the cached authorization of the device it runs on", () => {
		removePairingState(db, { localDeviceId: LOCAL, reason: "local", deviceIds: [LOCAL] });

		expect(access(LOCAL)).toEqual(EVERYWHERE);
	});

	it("a later refresh restores only the scopes the coordinator still grants", async () => {
		// Arrange: the coordinator removed the device from group A only.
		removePairingState(db, { localDeviceId: LOCAL, reason: "removed", deviceIds: [REMOVED] });

		// Act
		await refresh({ "scope-a": [LOCAL, KEEP], "scope-b": [LOCAL, REMOVED, KEEP] });

		// Assert
		expect(access(REMOVED)).toEqual({ "scope-a": false, "scope-b": true });
		expect(access(KEEP)).toEqual(EVERYWHERE);
	});

	it("a refresh that was in flight during the removal cannot restore the older answer", async () => {
		// Arrange: the coordinator answered before the removal reached this machine.
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const inFlight = refreshGroup(SCOPE_A, [LOCAL, REMOVED, KEEP], gate);

		// Act
		removePairingState(db, { localDeviceId: LOCAL, reason: "removed", deviceIds: [REMOVED] });
		release();
		const result = await inFlight;

		// Assert: the stale answer writes nothing, and a fresh one still works.
		expect(result.status).toBe("stale");
		expect(access(REMOVED)).toEqual(NOWHERE);
		expect(access(KEEP)).toEqual(EVERYWHERE);
		await refresh({ "scope-a": [LOCAL, KEEP] });
		expect(access(REMOVED)).toEqual(NOWHERE);
		expect(access(KEEP)).toEqual(EVERYWHERE);
	});

	it("a failed removal leaves the cached authorization and refresh state unchanged", () => {
		const state = () => ({
			evidence: db.prepare("SELECT * FROM scope_membership_authorization_evidence").all(),
			cache: db.prepare("SELECT * FROM scope_membership_cache_state").all(),
		});
		const before = state();
		db.prepare(
			`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
			 revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES (?, 'identity-a', 'Laptop', 'active', 'test', '1', 'user_managed', 'key:removed', ?, ?)`,
		).run(REMOVED, cacheTime, cacheTime);
		db.exec(`CREATE TRIGGER fail_binding_end BEFORE UPDATE ON identity_devices
			BEGIN SELECT RAISE(ABORT, 'binding update failed'); END`);

		expect(() =>
			removePairingState(db, { localDeviceId: LOCAL, reason: "removed", deviceIds: [REMOVED] }),
		).toThrow("binding update failed");

		expect(state()).toEqual(before);
		expect(access(REMOVED)).toEqual(EVERYWHERE);
	});
});
