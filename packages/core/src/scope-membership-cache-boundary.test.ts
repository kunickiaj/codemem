import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	getCachedScopeAuthorization,
	refreshScopeMembershipCache,
} from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import { verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

const baseUrl = "https://coordinator.example.test";
type Wire = ReturnType<typeof cacheWireSnapshot>;
function withEnrollment(wire: Wire, fields: Record<string, unknown>) {
	return {
		...wire,
		items: wire.items.map((item) => ({ ...item, enrollment: { ...item.enrollment, ...fields } })),
	};
}
const badSnapshots: Array<[string, (wire: Wire) => unknown]> = [
	["malformed key", (wire) => withEnrollment(wire, { public_key: "private SQL fixture-token" })],
	["missing version", ({ authorization_version: _version, ...wire }) => wire],
	["string version", (wire) => ({ ...wire, authorization_version: "1" })],
	["unknown version", (wire) => ({ ...wire, authorization_version: 2 })],
	["raw array", (wire) => wire.items.map((item) => item.membership)],
	["missing items", ({ items: _items, ...wire }) => wire],
	["foreign scope", (wire) => ({ ...wire, scope: { ...wire.scope, scope_id: "foreign" } })],
	["foreign group", (wire) => ({ ...wire, scope: { ...wire.scope, group_id: "foreign" } })],
	["duplicate device", (wire) => ({ ...wire, items: [...wire.items, wire.items[0]] })],
	[
		"foreign member source",
		(wire) => ({
			...wire,
			items: wire.items.map((item) => ({
				...item,
				membership: { ...item.membership, coordinator_id: "foreign" },
			})),
		}),
	],
	["foreign enrollment group", (wire) => withEnrollment(wire, { group_id: "foreign" })],
	["different enrollment device", (wire) => withEnrollment(wire, { device_id: "foreign" })],
	["invalid identity type", (wire) => withEnrollment(wire, { identity_id: 42 })],
	[
		"wrong canonical key id",
		(wire) => ({ ...wire, items: wire.items.map((item) => ({ ...item, key_id: "0".repeat(64) })) }),
	],
	["wrong exact-text fingerprint", (wire) => withEnrollment(wire, { fingerprint: "0".repeat(64) })],
	[
		"stale member epoch",
		(wire) => ({
			...wire,
			items: wire.items.map((item) => ({
				...item,
				membership: { ...item.membership, membership_epoch: 1 },
			})),
		}),
	],
];

let db: Database.Database;
let keysDir: string;
const options = () => ({
	groupIds: ["group-a"],
	remoteUrl: baseUrl,
	coordinatorId: baseUrl,
	keysDir,
	now: new Date(cacheTime),
});
beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	keysDir = mkdtempSync(join(tmpdir(), "codemem-current-cache-"));
	vi.spyOn(Date, "now").mockReturnValue(Date.parse(cacheTime));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	vi.restoreAllMocks();
	db.close();
	rmSync(keysDir, { recursive: true, force: true });
});
function serve(catalog: unknown, snapshots: Record<string, unknown>) {
	vi.mocked(fetch).mockImplementation(async (input) => {
		const url = new URL(String(input));
		const body =
			url.pathname === "/v1/scopes" ? catalog : snapshots[url.pathname.split("/")[3] ?? ""];
		return new Response(JSON.stringify(body), { status: 200 });
	});
}
function rows() {
	return {
		scopes: db.prepare("SELECT * FROM replication_scopes ORDER BY scope_id").all(),
		members: db.prepare("SELECT * FROM scope_memberships ORDER BY scope_id, device_id").all(),
	};
}
function authorization(scopeId = "scope-a") {
	return getCachedScopeAuthorization(db, {
		deviceId: "device-a",
		scopeId,
		authority: { coordinatorId: baseUrl, groupId: "group-a" },
		now: new Date(cacheTime),
	});
}
async function seed() {
	serve({ version: 1, items: [cacheScope()] }, { "scope-a": cacheWireSnapshot() });
	expect((await refreshScopeMembershipCache(db, options())).status).toBe("refreshed");
}

it.each(["server-a", "foreign"])(
	"legacy persisted source %s cannot freeze a valid empty current roster",
	async (source) => {
		// Arrange: legacy cache rows used the server ID, not the configured cache URL.
		await seed();
		db.prepare(
			"UPDATE replication_scopes SET coordinator_id = 'server-a' WHERE scope_id = 'scope-a'",
		).run();
		db.prepare("UPDATE scope_memberships SET coordinator_id = ? WHERE scope_id = 'scope-a'").run(
			source,
		);
		const previous = rows();
		serve(
			{ version: 1, items: [cacheScope()] },
			{ "scope-a": cacheWireSnapshot(cacheScope(), []) },
		);
		// Act
		const first = await refreshScopeMembershipCache(db, {
			...options(),
			now: new Date(Date.parse(cacheTime) + 1000),
		});
		const repeated = await refreshScopeMembershipCache(db, {
			...options(),
			now: new Date(Date.parse(cacheTime) + 2000),
		});
		// Assert
		if (source === "foreign") {
			expect([first.status, repeated.status]).toEqual(["stale", "stale"]);
			expect(rows()).toEqual(previous);
			expect(authorization().cacheStates[0]?.last_success_at).toBe(cacheTime);
			return;
		}
		expect([first.status, repeated.status]).toEqual(["refreshed", "refreshed"]);
		expect(authorization()).toMatchObject({
			authorized: false,
			state: "revoked",
			freshness: "fresh",
			scope: { coordinator_id: baseUrl },
			membership: {
				coordinator_id: baseUrl,
				group_id: "group-a",
				membership_epoch: 3,
				status: "revoked",
			},
		});
	},
);

it("same-epoch revival stays denied and stale without freezing later validated omissions", async () => {
	// Arrange: A and B start active; an unrelated manual scope remains outside the cache authority.
	const scope = cacheScope();
	const refresh = async (devices: string[], offset: number) => {
		serve(
			{ version: 1, items: [scope] },
			{
				"scope-a": cacheWireSnapshot(
					scope,
					devices.map((deviceId) => cacheMember(scope, deviceId)),
				),
			},
		);
		return refreshScopeMembershipCache(db, {
			...options(),
			now: new Date(Date.parse(cacheTime) + offset),
		});
	};
	const initial = await refresh(["device-a", "device-b"], 0);
	db.prepare(
		"INSERT INTO replication_scopes SELECT 'manual', label, kind, 'manual', NULL, NULL, manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at FROM replication_scopes WHERE scope_id = 'scope-a'",
	).run();
	db.prepare(
		"INSERT INTO scope_memberships SELECT 'manual', device_id, role, status, membership_epoch, NULL, NULL, manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at FROM scope_memberships WHERE scope_id = 'scope-a' AND device_id = 'device-a'",
	).run();
	const manualRows = () => ({
		scope: db.prepare("SELECT * FROM replication_scopes WHERE scope_id = 'manual'").get(),
		member: db.prepare("SELECT * FROM scope_memberships WHERE scope_id = 'manual'").get(),
	});
	const manualBefore = manualRows();
	// Act: B-only revokes A, attempted A revival cannot prevent a later omission from revoking B.
	const bOnly = await refresh(["device-b"], 1000);
	const restored = await refresh(["device-a", "device-b"], 2000);
	const aAfterRevival = authorization();
	const bAfterRevival = getCachedScopeAuthorization(db, {
		deviceId: "device-b",
		scopeId: "scope-a",
	});
	const aOnly = await refresh(["device-a"], 3000);
	const repeated = await refresh(["device-a"], 4000);
	// Assert
	expect([initial.status, bOnly.status, restored.status, aOnly.status, repeated.status]).toEqual([
		"refreshed",
		"refreshed",
		"stale",
		"stale",
		"stale",
	]);
	expect(aAfterRevival).toMatchObject({ authorized: false, state: "revoked", freshness: "stale" });
	expect(bAfterRevival.authorized).toBe(true);
	for (const deviceId of ["device-a", "device-b"]) {
		expect(
			getCachedScopeAuthorization(db, { deviceId, scopeId: "scope-a", now: new Date(cacheTime) }),
		).toMatchObject({
			authorized: false,
			state: "revoked",
			freshness: "stale",
			membership: { membership_epoch: 3 },
			cacheStates: [
				expect.objectContaining({
					last_success_at: new Date(Date.parse(cacheTime) + 1000).toISOString(),
				}),
			],
		});
	}
	expect(manualRows()).toEqual(manualBefore);
	expect(
		getCachedScopeAuthorization(db, { deviceId: "device-a", scopeId: "manual" }).authorized,
	).toBe(true);
});

it("accepts a canonical key alias with its own exact-text fingerprint", async () => {
	// Arrange
	const wire = cacheWireSnapshot();
	const enrollment = wire.items[0]?.enrollment;
	if (!enrollment) throw new Error("Missing fixture enrollment");
	enrollment.public_key += " fixture-comment";
	enrollment.fingerprint = fingerprintPublicKey(enrollment.public_key);
	serve({ version: 1, items: [cacheScope()] }, { "scope-a": wire });
	// Act
	const result = await refreshScopeMembershipCache(db, options());
	// Assert
	expect(result.status).toBe("refreshed");
	expect(authorization().authorized).toBe(true);
});

it("local current store omits revoked-key, disabled and deleted enrollments without raw membership fallback", async () => {
	// Arrange: coordinator storage is not the memory/cache database.
	const coordinatorDbPath = join(keysDir, "coordinator.sqlite");
	const coordinator = new BetterSqliteCoordinatorStore(coordinatorDbPath);
	await coordinator.createGroup("group-a");
	await coordinator.createScope({
		scopeId: "scope-a",
		groupId: "group-a",
		label: "Local scope",
		membershipEpoch: 3,
	});
	for (const deviceId of ["device-a", "disabled", "deleted", "revoked-key"]) {
		const publicKey = deviceId === "revoked-key" ? UNRELATED_PUBLIC_KEY : CANONICAL_PUBLIC_KEY;
		await coordinator.enrollDevice("group-a", {
			deviceId,
			publicKey,
			fingerprint: fingerprintPublicKey(publicKey),
		});
		await coordinator.grantScopeMembership({
			scopeId: "scope-a",
			deviceId,
			membershipEpoch: 3,
			effectId: `grant-${deviceId}`,
		});
	}
	const localOptions = {
		groupIds: ["group-a"],
		coordinatorDbPath,
		coordinatorId: "local",
		now: new Date(cacheTime),
	};
	try {
		expect((await refreshScopeMembershipCache(db, localOptions)).status).toBe("refreshed");
		await coordinator.setDeviceEnabled("group-a", "disabled", false);
		await coordinator.removeDevice("group-a", "deleted");
		await coordinator.createDeviceRevocation({
			groupId: "group-a",
			deviceId: "revoked-key",
			publicKey: UNRELATED_PUBLIC_KEY,
			fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
		});
		const current = vi.spyOn(BetterSqliteCoordinatorStore.prototype, "getScopeAuthorization");
		const raw = vi.spyOn(BetterSqliteCoordinatorStore.prototype, "listScopeMemberships");
		// Act
		const result = await refreshScopeMembershipCache(db, localOptions);
		// Assert
		expect(result).toMatchObject({ status: "refreshed", groups: [{ membershipCount: 1 }] });
		expect(current).toHaveBeenCalledWith({ groupId: "group-a", scopeId: "scope-a" });
		expect(raw).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		for (const deviceId of ["device-a", "disabled", "deleted", "revoked-key"]) {
			expect(
				getCachedScopeAuthorization(db, { deviceId, scopeId: "scope-a", now: new Date(cacheTime) }),
			).toMatchObject({ authorized: deviceId === "device-a", freshness: "fresh" });
		}
	} finally {
		await coordinator.close();
	}
});

it("valid empty discovery archives only this authority's scopes, not direct manual scopes", async () => {
	// Arrange
	await seed();
	db.prepare(
		"INSERT INTO replication_scopes SELECT 'manual', label, kind, 'manual', NULL, NULL, manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at FROM replication_scopes WHERE scope_id = 'scope-a'",
	).run();
	db.prepare(
		"INSERT INTO scope_memberships SELECT 'manual', device_id, role, status, membership_epoch, NULL, NULL, manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at FROM scope_memberships WHERE scope_id = 'scope-a'",
	).run();
	const manualBefore = db
		.prepare("SELECT * FROM scope_memberships WHERE scope_id = 'manual'")
		.get();
	serve({ version: 1, items: [] }, {});
	// Act
	const result = await refreshScopeMembershipCache(db, options());
	// Assert
	expect(result.status).toBe("refreshed");
	expect(authorization()).toMatchObject({ authorized: false, state: "scope_inactive" });
	expect(
		getCachedScopeAuthorization(db, { deviceId: "device-a", scopeId: "manual" }).authorized,
	).toBe(true);
	expect(db.prepare("SELECT * FROM scope_memberships WHERE scope_id = 'manual'").get()).toEqual(
		manualBefore,
	);
});

it("preserves the 60-second freshness boundary", async () => {
	// Arrange
	await seed();
	const lookup = (age: number) =>
		getCachedScopeAuthorization(db, {
			deviceId: "device-a",
			scopeId: "scope-a",
			now: new Date(Date.parse(cacheTime) + age),
		});
	// Act
	const boundary = lookup(60_000);
	const expired = lookup(60_001);
	// Assert
	expect(boundary.freshness).toBe("fresh");
	expect(expired.freshness).toBe("stale");
});

it("publishes a valid group independently of a malformed group", async () => {
	// Arrange
	vi.mocked(fetch).mockImplementation(async (input) => {
		const url = new URL(String(input));
		if (url.searchParams.get("group_id") === "group-b")
			return new Response(JSON.stringify({ version: "1", items: [] }));
		const body =
			url.pathname === "/v1/scopes" ? { version: 1, items: [cacheScope()] } : cacheWireSnapshot();
		return new Response(JSON.stringify(body));
	});
	// Act
	const result = await refreshScopeMembershipCache(db, {
		...options(),
		groupIds: ["group-a", "group-b"],
	});
	// Assert
	expect(result).toMatchObject({
		status: "partial",
		groups: [
			{ groupId: "group-a", status: "refreshed" },
			{ groupId: "group-b", status: "stale" },
		],
	});
	expect(authorization()).toMatchObject({ authorized: true, freshness: "fresh" });
});

it("refreshes a current newer member epoch twice but rejects an older replacement", async () => {
	// Arrange: the producer's current-member predicate permits an epoch above the scope.
	const wire = cacheWireSnapshot();
	const member = wire.items[0]?.membership;
	if (!member) throw new Error("Missing fixture member");
	member.membership_epoch = 4;
	serve({ version: 1, items: [cacheScope()] }, { "scope-a": wire });
	// Act
	const first = await refreshScopeMembershipCache(db, options());
	const second = await refreshScopeMembershipCache(db, options());
	const previous = rows();
	serve({ version: 1, items: [cacheScope()] }, { "scope-a": cacheWireSnapshot() });
	const rollback = await refreshScopeMembershipCache(db, {
		...options(),
		now: new Date(Date.parse(cacheTime) + 1000),
	});
	// Assert
	expect(first.status).toBe("refreshed");
	expect(second.status).toBe("refreshed");
	expect(rollback.status).toBe("stale");
	expect(rows()).toEqual(previous);
	expect(authorization().cacheStates[0]?.last_success_at).toBe(cacheTime);
});

it.each(badSnapshots)(
	"rejects %s without changing group rows or last successful refresh",
	async (_name, damage) => {
		// Arrange: valid cached data precedes an untrusted replacement.
		await seed();
		const previous = rows();
		serve({ version: 1, items: [cacheScope()] }, { "scope-a": damage(cacheWireSnapshot()) });
		// Act
		const result = await refreshScopeMembershipCache(db, {
			...options(),
			now: new Date(Date.parse(cacheTime) + 1000),
		});
		// Assert
		expect(result.status).toBe("stale");
		expect(JSON.stringify(result)).not.toMatch(/private SQL|fixture-token/);
		expect(rows()).toEqual(previous);
		expect(authorization()).toMatchObject({
			freshness: "stale",
			cacheStates: [expect.objectContaining({ last_success_at: cacheTime })],
		});
	},
);

it.each([
	{},
	{ version: "1", items: [] },
	{ version: 1 },
	{ version: 1, items: {} },
	{ version: 1, items: [cacheScope(), cacheScope()] },
])("rejects malformed catalog %j without archiving cached scopes", async (catalog) => {
	// Arrange
	await seed();
	const previous = rows();
	serve(catalog, {});
	// Act
	const result = await refreshScopeMembershipCache(db, {
		...options(),
		now: new Date(Date.parse(cacheTime) + 1000),
	});
	// Assert
	expect(result.status).toBe("stale");
	expect(rows()).toEqual(previous);
	expect(authorization()).toMatchObject({
		freshness: "stale",
		cacheStates: [expect.objectContaining({ last_success_at: cacheTime })],
	});
});

it("uses the newer authoritative member scope rather than older discovery metadata", async () => {
	// Arrange
	const newer = cacheScope({ membership_epoch: 4, label: "New label" });
	serve({ version: 1, items: [cacheScope()] }, { "scope-a": cacheWireSnapshot(newer) });
	// Act
	const result = await refreshScopeMembershipCache(db, options());
	// Assert
	expect(result.status).toBe("refreshed");
	expect(authorization()).toMatchObject({
		authorized: true,
		freshness: "fresh",
		scope: { membership_epoch: 4, label: "New label" },
	});
});

it("rejects a superseded snapshot below persisted scope epoch", async () => {
	// Arrange
	await seed();
	const previous = rows();
	const older = cacheScope({ membership_epoch: 2 });
	serve({ version: 1, items: [older] }, { "scope-a": cacheWireSnapshot(older) });
	// Act
	const result = await refreshScopeMembershipCache(db, options());
	// Assert
	expect(result.status).toBe("stale");
	expect(rows()).toEqual(previous);
	expect(authorization().cacheStates[0]?.last_success_at).toBe(cacheTime);
});

it("rejects the whole group when a second scope fails after a valid first snapshot", async () => {
	// Arrange
	await seed();
	const previous = rows();
	const newer = cacheScope({ membership_epoch: 4 });
	const second = cacheScope({ scope_id: "scope-b" });
	serve(
		{ version: 1, items: [newer, second] },
		{ "scope-a": cacheWireSnapshot(newer, []), "scope-b": { items: [] } },
	);
	// Act
	const result = await refreshScopeMembershipCache(db, {
		...options(),
		now: new Date(Date.parse(cacheTime) + 1000),
	});
	// Assert
	expect(result.status).toBe("stale");
	expect(rows()).toEqual(previous);
	expect(authorization().cacheStates[0]?.last_success_at).toBe(cacheTime);
});

it("accepts an empty current roster and revokes omitted cached members", async () => {
	// Arrange
	await seed();
	serve({ version: 1, items: [cacheScope()] }, { "scope-a": cacheWireSnapshot(cacheScope(), []) });
	// Act
	const result = await refreshScopeMembershipCache(db, options());
	// Assert
	expect(result.status).toBe("refreshed");
	expect(authorization()).toMatchObject({
		authorized: false,
		state: "revoked",
		freshness: "fresh",
	});
});

it.each([true, false])(
	"signed remote reads with admin secret configured; enrolled=%s",
	async (enrolled) => {
		// Arrange: the memory DB and real coordinator store are separate databases.
		await seed();
		const previous = rows();
		const coordinator = setupStore("SQLite", { authClock: () => Date.parse(cacheTime) });
		const [deviceId] = ensureDeviceIdentity(db, { keysDir });
		const publicKey = loadPublicKey(keysDir);
		if (!publicKey) throw new Error("Missing fixture public key");
		await coordinator.store.createGroup("group-a");
		await coordinator.store.createScope({
			scopeId: "scope-a",
			groupId: "group-a",
			coordinatorId: "server-a",
			label: "Scope",
			membershipEpoch: 3,
		});
		if (enrolled) {
			await coordinator.store.enrollDevice("group-a", {
				deviceId,
				publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
			});
			await coordinator.store.grantScopeMembership({
				scopeId: "scope-a",
				deviceId,
				membershipEpoch: 3,
				effectId: "requester-grant",
			});
		}
		const app = createCoordinatorApp({
			storeFactory: () => coordinator.store,
			runtime: { now: () => cacheTime, adminSecret: () => "fixture-admin" },
			requestVerifier: async (input) =>
				verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
			requestRateLimit: { limiter: { check: () => ({ allowed: true, retryAfterS: 1 }) } },
		});
		const close = coordinator.store.close.bind(coordinator.store);
		vi.spyOn(coordinator.store, "close").mockResolvedValue(undefined);
		const seen: Array<{ path: string; headers: Headers }> = [];
		vi.mocked(fetch).mockImplementation(async (input, init) => {
			const url = new URL(String(input));
			seen.push({ path: url.pathname, headers: new Headers(init?.headers) });
			return app.request(`${url.pathname}${url.search}`, init);
		});
		try {
			// Act
			const result = await refreshScopeMembershipCache(db, {
				...options(),
				adminSecret: "fixture-admin",
				now: new Date(Date.parse(cacheTime) + 1000),
			});
			// Assert
			expect(result.status).toBe(enrolled ? "refreshed" : "stale");
			expect(seen.map((request) => request.path)).toEqual(
				enrolled ? ["/v1/scopes", "/v1/scopes/scope-a/members"] : ["/v1/scopes"],
			);
			for (const request of seen) {
				expect(request.headers.get("X-Opencode-Signature")).toBeTruthy();
				expect(request.headers.get("X-Codemem-Coordinator-Admin")).toBeNull();
			}
			if (enrolled)
				expect(
					getCachedScopeAuthorization(db, {
						deviceId,
						scopeId: "scope-a",
						now: new Date(cacheTime),
					}),
				).toMatchObject({
					authorized: true,
					freshness: "fresh",
					scope: { coordinator_id: baseUrl },
				});
			if (!enrolled) {
				expect(rows()).toEqual(previous);
				expect(authorization()).toMatchObject({
					freshness: "stale",
					cacheStates: [expect.objectContaining({ last_success_at: cacheTime })],
				});
			}
		} finally {
			await close();
		}
	},
);
