import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	publicKeyFromWire,
	wireBytes,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import type { CoordinatorScope } from "./coordinator-store-contract.js";
import { type Database as CoreDatabase, connectReadOnly } from "./db.js";
import { putRecipientPolicyDenyOverlay } from "./recipient-policy-reconciliation.js";
import {
	getCachedScopeAuthorization,
	getEffectiveCachedScopeAuthorization,
	listCachedScopesForDevice,
	refreshScopeMembershipCache,
	upsertCachedScopeMemberships,
} from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import type { ScopeMembershipSnapshot } from "./scope-membership-snapshot.js";
import { initTestSchema, seedMixedScopeFixture } from "./test-utils.js";

const authority = { coordinatorId: "server-a", groupId: "group-a" };
const input = { deviceId: "device-a", scopeId: "scope-a", now: new Date(cacheTime) };
const later = new Date(Date.parse(cacheTime) + 120_000);
const evidenceTable = "scope_membership_authorization_evidence";
const connections: CoreDatabase[] = [];
const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const db of connections.splice(0)) db.close();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(filename = ":memory:"): CoreDatabase {
	const db = new Database(filename);
	connections.push(db);
	initTestSchema(db);
	return db;
}

function seedOld(db: CoreDatabase, scope = cacheScope(), deviceId = "device-a"): void {
	db.prepare(`INSERT OR REPLACE INTO replication_scopes
		(scope_id, label, kind, authority_type, coordinator_id, group_id,
		manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		scope.scope_id,
		scope.label,
		scope.kind,
		scope.authority_type,
		scope.coordinator_id,
		scope.group_id,
		scope.manifest_issuer_device_id,
		scope.membership_epoch,
		scope.manifest_hash,
		scope.status,
		scope.created_at,
		scope.updated_at,
	);
	upsertCachedScopeMemberships(db, [cacheMember(scope, deviceId)]);
}

function refresh(
	db: CoreDatabase,
	snapshots = [cacheWireSnapshot()],
	now = new Date(cacheTime),
	coordinatorId = authority.coordinatorId,
) {
	return refreshScopeMembershipCache(db, {
		groupIds: [authority.groupId],
		coordinatorId,
		now,
		fetchers: {
			listScopes: async () => ({ version: 1, items: snapshots.map((snapshot) => snapshot.scope) }),
			getScopeSnapshot: async (_group, scopeId) => {
				const snapshot = snapshots.find((item) => item.scope.scope_id === scopeId);
				if (!snapshot) throw new Error("Missing fixture snapshot");
				return snapshot;
			},
		},
	});
}

function proof(db: CoreDatabase): ScopeMembershipSnapshot {
	const row = db
		.prepare(`SELECT evidence_json FROM ${evidenceTable} WHERE scope_id = ? AND device_id = ?`)
		.get(input.scopeId, input.deviceId) as { evidence_json: string };
	return JSON.parse(row.evidence_json);
}

function saveProof(db: CoreDatabase, snapshot: ScopeMembershipSnapshot): void {
	db.prepare(
		`UPDATE ${evidenceTable} SET evidence_json = ? WHERE scope_id = ? AND device_id = ?`,
	).run(JSON.stringify(snapshot), input.scopeId, input.deviceId);
}

function firstItem(snapshot: ScopeMembershipSnapshot): ScopeMembershipSnapshot["items"][number] {
	const item = snapshot.items[0];
	if (!item) throw new Error("Missing fixture member");
	return item;
}

function rotated(snapshot = cacheWireSnapshot()): ScopeMembershipSnapshot {
	const wire = wireBytes();
	wire[wire.length - 1] = (wire[wire.length - 1] ?? 0) ^ 1;
	firstItem(snapshot).enrollment.public_key = publicKeyFromWire(wire);
	firstItem(snapshot).key_id = createHash("sha256").update(wire).digest("hex");
	return snapshot;
}

it("denies historical managed rows without changing raw authorization or epoch history", () => {
	// Arrange: historical cache rows have no proof from a current V1 refresh.
	const db = setup();
	seedOld(db);
	const raw = getCachedScopeAuthorization(db, input);
	// Act
	const effective = getEffectiveCachedScopeAuthorization(db, input);
	// Assert: only the effective decision changes; diagnostics and storage remain intact.
	expect(raw).toMatchObject({ authorized: true, state: "authorized" });
	expect(effective).toEqual({ ...raw, authorized: false, state: "not_authorized", keyId: null });
	expect(getCachedScopeAuthorization(db, input)).toEqual(raw);
});

it("accepts one current V1 refresh and keeps verified stale access after a failed refresh", async () => {
	// Arrange
	const db = setup();
	seedOld(db);
	// Act: successful refresh is the only promotion path; a network failure is not a lease expiry.
	const refreshed = await refresh(db);
	const fresh = getEffectiveCachedScopeAuthorization(db, {
		...input,
		expectedPublicKey: CANONICAL_PUBLIC_KEY,
	});
	const before = proof(db);
	const failed = await refreshScopeMembershipCache(db, {
		...authority,
		groupIds: [authority.groupId],
		now: later,
		fetchers: {
			listScopes: async () => {
				throw new Error("offline");
			},
			getScopeSnapshot: async () => {
				throw new Error("unreachable");
			},
		},
	});
	const stale = getEffectiveCachedScopeAuthorization(db, { ...input, now: later });
	// Assert
	expect(refreshed).toMatchObject({ status: "refreshed" });
	expect(fresh).toMatchObject({ authorized: true, freshness: "fresh", keyId: EXPECTED_KEY_ID });
	expect(failed).toMatchObject({ status: "stale" });
	expect(stale).toMatchObject({
		authorized: true,
		state: "authorized",
		freshness: "stale",
		keyId: EXPECTED_KEY_ID,
	});
	expect(stale.cacheStates[0]).toMatchObject({
		last_success_at: cacheTime,
		last_error: "offline",
	});
	expect(proof(db)).toEqual(before);
});

it("binds access to the actual current key, accepts SSH text aliases, and preserves opaque fingerprints", async () => {
	// Arrange: fingerprint is legacy transport metadata, not the canonical key hash.
	const db = setup();
	const snapshot = cacheWireSnapshot();
	firstItem(snapshot).enrollment.fingerprint = "legacy-opaque-fingerprint";
	await refresh(db, [snapshot]);
	const next = rotated(cacheWireSnapshot(cacheScope({ membership_epoch: 4 })));
	firstItem(next).enrollment.fingerprint = "another-opaque-fingerprint";
	// Act
	const alias = getEffectiveCachedScopeAuthorization(db, {
		...input,
		expectedPublicKey: `  ${CANONICAL_PUBLIC_KEY}\tcomment\n`,
	});
	const mismatch = getEffectiveCachedScopeAuthorization(db, {
		...input,
		expectedPublicKey: firstItem(next).enrollment.public_key,
	});
	await refresh(db, [next], later);
	// Assert
	expect(alias).toMatchObject({ authorized: true, keyId: EXPECTED_KEY_ID });
	expect(mismatch).toMatchObject({ authorized: false, keyId: null });
	expect(
		getEffectiveCachedScopeAuthorization(db, {
			...input,
			expectedPublicKey: CANONICAL_PUBLIC_KEY,
		}),
	).toMatchObject({ authorized: false, keyId: null });
	expect(
		getEffectiveCachedScopeAuthorization(db, {
			...input,
			expectedPublicKey: firstItem(next).enrollment.public_key,
		}),
	).toMatchObject({ authorized: true, keyId: firstItem(next).key_id });
});

it("does not infer a server-ID/URL alias for an omitted old scope, but verifies an included legacy source", async () => {
	// Arrange
	const db = setup();
	seedOld(db);
	const copied = seedMixedScopeFixture(db);
	const url = "https://coordinator.example.test";
	// Act: the old server-ID scope is entirely absent from the URL catalogue.
	await refresh(db, [], later, url);
	const omitted = getEffectiveCachedScopeAuthorization(db, input);
	const raw = getCachedScopeAuthorization(db, input);
	await refresh(db, [cacheWireSnapshot()], later, url);
	const included = getEffectiveCachedScopeAuthorization(db, {
		...input,
		authority: { ...authority, coordinatorId: url },
	});
	// Assert
	expect(omitted).toMatchObject({ authorized: false, keyId: null });
	expect(raw).toMatchObject({
		authorized: true,
		scope: { coordinator_id: "server-a", status: "active" },
	});
	expect(included).toMatchObject({
		authorized: true,
		keyId: EXPECTED_KEY_ID,
		scope: { coordinator_id: url },
	});
	expect(proof(db).scope.coordinator_id).toBe("server-a");
	expect(db.prepare("SELECT id FROM memory_items ORDER BY id").all()).toHaveLength(
		copied.allIds.length,
	);
});

it.each([
	[
		"invalid items",
		(p: ScopeMembershipSnapshot) => {
			p.items = null as never;
		},
	],
	[
		"missing version",
		(p: ScopeMembershipSnapshot) => {
			delete (p as Partial<ScopeMembershipSnapshot>).authorization_version;
		},
	],
	[
		"older version",
		(p: ScopeMembershipSnapshot) => {
			p.authorization_version = 0 as never;
		},
	],
	[
		"scope source",
		(p: ScopeMembershipSnapshot) => {
			p.scope.group_id = "other-group";
		},
	],
	[
		"member source",
		(p: ScopeMembershipSnapshot) => {
			firstItem(p).membership.coordinator_id = "other-server";
		},
	],
	[
		"contradictory source coordinator",
		(p: ScopeMembershipSnapshot) => {
			p.scope.coordinator_id = "other-server";
		},
	],
	[
		"missing required membership field",
		(p: ScopeMembershipSnapshot) => {
			delete (
				firstItem(p).membership as Partial<ScopeMembershipSnapshot["items"][number]["membership"]>
			).role;
		},
	],
	[
		"enrollment tuple",
		(p: ScopeMembershipSnapshot) => {
			firstItem(p).enrollment.device_id = "other-device";
		},
	],
	[
		"key tuple",
		(p: ScopeMembershipSnapshot) => {
			firstItem(p).key_id = "0".repeat(64);
		},
	],
	[
		"duplicate record",
		(p: ScopeMembershipSnapshot) => {
			p.items.push(firstItem(p));
		},
	],
] as const)(
	"rejects retained proof with %s without changing raw history",
	async (_name, corrupt) => {
		// Arrange
		const db = setup();
		await refresh(db);
		const raw = getCachedScopeAuthorization(db, input);
		const snapshot = proof(db);
		corrupt(snapshot);
		saveProof(db, snapshot);
		// Act
		const effective = getEffectiveCachedScopeAuthorization(db, input);
		// Assert
		expect(effective).toMatchObject({ authorized: false, state: "not_authorized", keyId: null });
		expect(getCachedScopeAuthorization(db, input)).toEqual(raw);
	},
);

it.each([
	"UPDATE scope_memberships SET role = 'admin'",
	"UPDATE scope_memberships SET membership_epoch = 4",
	"UPDATE scope_memberships SET coordinator_id = 'other-server'",
	"UPDATE replication_scopes SET kind = 'project'",
	"UPDATE replication_scopes SET manifest_hash = 'changed'",
] as const)("does not reuse proof after cached authority facts change: %s", async (sql) => {
	// Arrange
	const db = setup();
	await refresh(db);
	db.exec(sql);
	// Act
	const effective = getEffectiveCachedScopeAuthorization(db, input);
	// Assert
	expect(effective).toMatchObject({ authorized: false, keyId: null });
});

it.each(["{", "null", "{}"])("denies malformed stored proof JSON %s", async (rawProof) => {
	// Arrange
	const db = setup();
	await refresh(db);
	db.prepare(`UPDATE ${evidenceTable} SET evidence_json = ?`).run(rawProof);
	// Act
	const effective = getEffectiveCachedScopeAuthorization(db, input);
	// Assert
	expect(effective).toMatchObject({ authorized: false, state: "not_authorized", keyId: null });
});

it("retains raw policy-denied diagnostics even with a valid proof", async () => {
	// Arrange
	const db = setup();
	await refresh(db);
	putRecipientPolicyDenyOverlay(db, {
		scopeId: input.scopeId,
		deviceId: input.deviceId,
		canonicalProjectIdentity: "project:fixture",
		generation: 1,
		reasonCode: "recipient_removed",
		now: cacheTime,
	});
	// Act
	const raw = getCachedScopeAuthorization(db, input);
	const effective = getEffectiveCachedScopeAuthorization(db, input);
	// Assert
	expect(raw).toMatchObject({ authorized: false, state: "policy_denied" });
	expect(effective).toEqual({ ...raw, keyId: null });
});

it.each(["manual", "local"] as const)(
	"leaves %s scope authorization unchanged without an evidence table",
	(authorityType) => {
		// Arrange
		const db = setup();
		seedOld(
			db,
			cacheScope({ authority_type: authorityType as CoordinatorScope["authority_type"] }),
		);
		// Act
		const allowed = getEffectiveCachedScopeAuthorization(db, input);
		db.exec("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = 'scope-a'");
		const denied = getEffectiveCachedScopeAuthorization(db, input);
		// Assert
		expect(allowed).toMatchObject({ authorized: true, keyId: null });
		expect(denied).toEqual({ ...getCachedScopeAuthorization(db, input), keyId: null });
		expect(denied.state).toBe("revoked");
		expect(
			db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(evidenceTable),
		).toBeUndefined();
	},
);

it("denies a legacy read-only database without creating tables or writing", () => {
	// Arrange
	const dir = mkdtempSync(join(tmpdir(), "codemem-effective-"));
	directories.push(dir);
	const filename = join(dir, "cache.sqlite");
	const writer = setup(filename);
	seedOld(writer);
	seedOld(writer, cacheScope({ scope_id: "scope-manual", authority_type: "manual" }));
	writer.exec("DROP TABLE IF EXISTS scope_membership_cache_state");
	const reader = new Database(filename, { readonly: true });
	connections.push(reader);
	const schema = reader.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
	// Act
	const effective = getEffectiveCachedScopeAuthorization(reader, input);
	const unmanaged = getEffectiveCachedScopeAuthorization(reader, {
		...input,
		scopeId: "scope-manual",
	});
	// Assert
	expect(effective).toMatchObject({ authorized: false, keyId: null });
	expect(unmanaged).toMatchObject({ authorized: true, freshness: "unknown", keyId: null });
	expect(reader.prepare("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual(schema);
});

it("retains verified proof after reopening SQLite and denies it when the proof row is missing", async () => {
	// Arrange
	const dir = mkdtempSync(join(tmpdir(), "codemem-effective-reopen-"));
	directories.push(dir);
	const filename = join(dir, "cache.sqlite");
	const db = setup(filename);
	await refresh(db);
	db.close();
	connections.splice(connections.indexOf(db), 1);
	const reopened = new Database(filename);
	connections.push(reopened);
	// Act
	const retained = getEffectiveCachedScopeAuthorization(reopened, { ...input, now: later });
	reopened.exec(`DELETE FROM ${evidenceTable}`);
	const missing = getEffectiveCachedScopeAuthorization(reopened, input);
	// Assert
	expect(retained).toMatchObject({
		authorized: true,
		freshness: "stale",
		keyId: EXPECTED_KEY_ID,
	});
	expect(missing).toMatchObject({ authorized: false, keyId: null });
});

it("rolls back both proof and cache changes when the second proof insert fails", async () => {
	// Arrange
	const db = setup();
	await refresh(db);
	const before = proof(db);
	const second = cacheWireSnapshot(cacheScope({ scope_id: "scope-b", membership_epoch: 4 }));
	const attempted: string[] = [];
	db.function("observe_proof_insert", (scopeId: string) => {
		attempted.push(scopeId);
		return 0;
	});
	db.exec(`CREATE TRIGGER observe_proof BEFORE INSERT ON ${evidenceTable}
		BEGIN SELECT observe_proof_insert(NEW.scope_id); END`);
	db.exec(`CREATE TRIGGER fail_second_proof BEFORE INSERT ON ${evidenceTable}
		WHEN NEW.scope_id = 'scope-b' BEGIN SELECT observe_proof_insert(NEW.scope_id);
		SELECT RAISE(ABORT, 'fixture proof failure'); END`);
	// Act
	const result = await refresh(
		db,
		[rotated(cacheWireSnapshot(cacheScope({ membership_epoch: 4 }))), second],
		later,
	);
	const effective = getEffectiveCachedScopeAuthorization(db, input);
	// Assert: failure diagnostics may advance, but the previous success and authority must survive.
	expect(result).toMatchObject({
		status: "stale",
		groups: [{ error: "Scope authorization evidence unavailable." }],
	});
	expect(attempted).toEqual(["scope-a", "scope-b"]);
	expect(proof(db)).toEqual(before);
	expect(effective).toMatchObject({
		authorized: true,
		keyId: EXPECTED_KEY_ID,
		membership: { membership_epoch: 3 },
	});
	expect(effective.cacheStates[0]?.last_success_at).toBe(cacheTime);
	expect(
		db.prepare("SELECT scope_id FROM replication_scopes WHERE scope_id = 'scope-b'").get(),
	).toBeUndefined();
});

it("remove-only same-epoch revival cannot mint proof or grants and only retains unchanged verified proof", async () => {
	// Arrange: one revoked row blocks all grants, while unchanged proof can still work offline.
	const db = setup();
	const unchanged = cacheWireSnapshot();
	const changed = cacheWireSnapshot(cacheScope({ scope_id: "scope-key" }));
	const omitted = cacheWireSnapshot(cacheScope({ scope_id: "scope-omitted" }));
	const revoked = cacheWireSnapshot(cacheScope({ scope_id: "scope-revoked" }));
	const scopes = [unchanged, changed, omitted, revoked];
	await refresh(db, scopes);
	db.exec("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = 'scope-revoked'");
	db.prepare(`DELETE FROM ${evidenceTable} WHERE scope_id = ?`).run("scope-revoked");
	const oldProof = proof(db);
	const grant = cacheWireSnapshot(cacheScope({ scope_id: "scope-new" }));
	firstItem(unchanged).enrollment.public_key = `${CANONICAL_PUBLIC_KEY}\tfixture-comment`;
	// Act
	const result = await refresh(db, [unchanged, rotated(changed), revoked, grant], later);
	const changedInput = { ...input, scopeId: "scope-key" };
	const oldKeyDenied = getEffectiveCachedScopeAuthorization(db, {
		...changedInput,
		expectedPublicKey: CANONICAL_PUBLIC_KEY,
	});
	const newKeyDenied = getEffectiveCachedScopeAuthorization(db, {
		...changedInput,
		expectedPublicKey: firstItem(changed).enrollment.public_key,
	});
	// Assert
	expect(result).toMatchObject({ status: "stale" });
	expect(oldKeyDenied).toMatchObject({ authorized: false, keyId: null });
	expect(newKeyDenied).toMatchObject({ authorized: false, keyId: null });
	expect(getEffectiveCachedScopeAuthorization(db, { ...input, now: later })).toMatchObject({
		authorized: true,
		freshness: "stale",
	});
	expect(proof(db)).toEqual(oldProof);
	for (const scopeId of ["scope-key", "scope-omitted", "scope-revoked", "scope-new"])
		expect(getEffectiveCachedScopeAuthorization(db, { ...input, scopeId }).authorized).toBe(false);
	expect(db.prepare(`SELECT scope_id FROM ${evidenceTable} ORDER BY scope_id`).all()).toEqual([
		{ scope_id: "scope-a" },
	]);
	expect(
		db.prepare("SELECT scope_id FROM replication_scopes WHERE scope_id = 'scope-new'").get(),
	).toBeUndefined();
	expect(
		db.prepare("SELECT status FROM scope_memberships WHERE scope_id = 'scope-revoked'").get(),
	).toEqual({ status: "revoked" });
});

it("accepts a replacement key only after a successful refresh clears the revival conflict at a higher epoch", async () => {
	// Arrange
	const db = setup();
	const blocked = cacheWireSnapshot(cacheScope({ scope_id: "scope-blocked" }));
	await refresh(db, [cacheWireSnapshot(), blocked]);
	db.exec("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = 'scope-blocked'");
	const replacement = rotated();
	await refresh(db, [replacement, blocked], later);
	const before = getEffectiveCachedScopeAuthorization(db, {
		...input,
		expectedPublicKey: firstItem(replacement).enrollment.public_key,
	});
	// Act: only a genuine higher member/scope epoch permits revival and an atomic new proof.
	const result = await refresh(
		db,
		[
			replacement,
			cacheWireSnapshot(cacheScope({ scope_id: "scope-blocked", membership_epoch: 4 })),
		],
		later,
	);
	const current = getEffectiveCachedScopeAuthorization(db, {
		...input,
		expectedPublicKey: firstItem(replacement).enrollment.public_key,
	});
	const old = getEffectiveCachedScopeAuthorization(db, {
		...input,
		expectedPublicKey: CANONICAL_PUBLIC_KEY,
	});
	// Assert
	expect(before).toMatchObject({ authorized: false, keyId: null });
	expect(result).toMatchObject({ status: "refreshed" });
	expect(current).toMatchObject({ authorized: true, keyId: firstItem(replacement).key_id });
	expect(old).toMatchObject({ authorized: false, keyId: null });
});

it("rolls back first proof-table creation when success-state persistence fails", async () => {
	// Arrange: no evidence exists yet; only the legacy cache/state table is present.
	const db = setup();
	seedOld(db);
	getCachedScopeAuthorization(db, input);
	db.exec(`CREATE TRIGGER fail_success_state BEFORE INSERT ON scope_membership_cache_state
		WHEN NEW.last_success_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture state failure'); END`);
	// Act: failure occurs after proof inserts, still inside the whole-group transaction.
	const result = await refresh(db, [cacheWireSnapshot(cacheScope({ membership_epoch: 4 }))], later);
	const effective = getEffectiveCachedScopeAuthorization(db, input);
	// Assert: the catch may record failure, but it must not retain proof DDL or a positive success stamp.
	expect(result).toMatchObject({ status: "stale" });
	expect(
		db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(evidenceTable),
	).toBeUndefined();
	expect(effective).toMatchObject({
		authorized: false,
		keyId: null,
		membership: { membership_epoch: 3 },
	});
	expect(effective.cacheStates[0]?.last_success_at).toBeNull();
	expect(getCachedScopeAuthorization(db, input)).toMatchObject({
		authorized: true,
		membership: { membership_epoch: 3 },
	});
});

it("accepts legacy null member source only under an explicit current scope group", async () => {
	// Arrange: null member source inherits the explicit group; a scope without that group cannot grant.
	const db = setup();
	const snapshot = cacheWireSnapshot();
	firstItem(snapshot).membership.group_id = null;
	firstItem(snapshot).membership.coordinator_id = null;
	await refresh(db, [snapshot]);
	const invalid = cacheWireSnapshot(cacheScope({ scope_id: "scope-unbound" }));
	invalid.scope.group_id = null;
	// Act
	const valid = getEffectiveCachedScopeAuthorization(db, input);
	const rejected = await refresh(db, [invalid], later);
	const unbound = getEffectiveCachedScopeAuthorization(db, { ...input, scopeId: "scope-unbound" });
	// Assert
	expect(valid).toMatchObject({ authorized: true, keyId: EXPECTED_KEY_ID });
	expect(rejected).toMatchObject({ status: "stale" });
	expect(unbound).toMatchObject({ authorized: false, keyId: null });
	expect(getEffectiveCachedScopeAuthorization(db, input)).toMatchObject({
		authorized: true,
		keyId: EXPECTED_KEY_ID,
	});
});

function concurrentKeyDecisions(db: CoreDatabase, newKey: string) {
	const read = (expectedPublicKey: string) =>
		getEffectiveCachedScopeAuthorization(db, { ...input, expectedPublicKey }).authorized;
	return { oldKey: read(CANONICAL_PUBLIC_KEY), newKey: read(newKey) };
}

it.each([
	{ scenario: "replacement key", connection: "shared" },
	{ scenario: "empty catalogue", connection: "shared" },
	{ scenario: "replacement key", connection: "separate" },
] as const)(
	"does not let a delayed same-epoch snapshot overwrite a newer committed $scenario ($connection connections)",
	async ({ scenario, connection }) => {
		// Arrange: R1 has captured key A, but delivery waits until R2 commits.
		const filename = connection === "separate" ? temporaryCacheFilename() : ":memory:";
		const db = setup(filename);
		const writer = connection === "separate" ? new Database(filename) : db;
		if (writer !== db) connections.push(writer);
		seedOld(db);
		if (scenario === "replacement key") await refresh(db);
		const oldSnapshot = cacheWireSnapshot();
		const replacement = rotated();
		const requested = Promise.withResolvers<void>();
		const delivery = Promise.withResolvers<ScopeMembershipSnapshot>();
		const pending = refreshScopeMembershipCache(db, {
			...authority,
			groupIds: [authority.groupId],
			now: new Date(cacheTime),
			fetchers: {
				listScopes: async () => ({ version: 1, items: [oldSnapshot.scope] }),
				getScopeSnapshot: () => {
					requested.resolve();
					return delivery.promise;
				},
			},
		});
		await requested.promise;
		let committed: Awaited<ReturnType<typeof refresh>>;
		let beforeLate: ReturnType<typeof concurrentKeyDecisions>;
		// Act: even if R2 fails unexpectedly, settle R1 before database cleanup.
		try {
			committed = await refresh(writer, scenario === "replacement key" ? [replacement] : [], later);
			beforeLate = concurrentKeyDecisions(db, firstItem(replacement).enrollment.public_key);
		} finally {
			delivery.resolve(oldSnapshot);
			await pending;
		}
		const late = await pending;
		const afterLate = concurrentKeyDecisions(db, firstItem(replacement).enrollment.public_key);
		const current = getEffectiveCachedScopeAuthorization(db, input);
		// Assert: equal epochs must not let an older in-flight read restore key A.
		expect(committed).toMatchObject({ status: "refreshed" });
		expect(beforeLate).toEqual({ oldKey: false, newKey: scenario === "replacement key" });
		expect({
			afterLate,
			lateStatus: late.status,
			lastSuccess: current.cacheStates[0]?.last_success_at,
		}).toEqual({ afterLate: beforeLate, lateStatus: "stale", lastSuccess: later.toISOString() });
		if (scenario === "replacement key")
			expect(firstItem(proof(db)).key_id).toBe(firstItem(replacement).key_id);
		else expect(current.scope?.status).toBe("archived");
	},
);

function temporaryCacheFilename(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-effective-revision-"));
	directories.push(dir);
	return join(dir, "cache.sqlite");
}

function seedLegacyCacheState(db: CoreDatabase): void {
	db.exec(`DROP TABLE scope_membership_cache_state;
		CREATE TABLE scope_membership_cache_state (
		coordinator_id TEXT NOT NULL, group_id TEXT NOT NULL, last_refresh_at TEXT NOT NULL,
		last_success_at TEXT, last_error TEXT, updated_at TEXT NOT NULL,
		PRIMARY KEY (coordinator_id, group_id))`);
	db.prepare(`INSERT INTO scope_membership_cache_state VALUES (?, ?, ?, ?, ?, ?)`).run(
		authority.coordinatorId,
		authority.groupId,
		cacheTime,
		cacheTime,
		"old-offline",
		cacheTime,
	);
}

it("upgrades legacy cache-state history only on the writer path, without inferring proof", async () => {
	// Arrange
	const db = setup();
	seedOld(db);
	seedLegacyCacheState(db);
	let beforeCommit: unknown;
	// Act: capture the upgraded state before the asynchronous fetch can grant anything.
	const result = await refreshScopeMembershipCache(db, {
		...authority,
		groupIds: [authority.groupId],
		now: later,
		fetchers: {
			listScopes: async () => {
				beforeCommit = {
					state: db.prepare("SELECT * FROM scope_membership_cache_state").get(),
					authorized: getEffectiveCachedScopeAuthorization(db, input).authorized,
				};
				return { version: 1, items: [cacheScope()] };
			},
			getScopeSnapshot: async () => cacheWireSnapshot(),
		},
	});
	const transaction = vi.spyOn(db, "transaction");
	const raw = getCachedScopeAuthorization(db, input);
	const effective = getEffectiveCachedScopeAuthorization(db, input);
	// Assert: adding the counter keeps old diagnostics; only a committed refresh updates them.
	expect(beforeCommit).toEqual({
		authorized: false,
		state: {
			coordinator_id: authority.coordinatorId,
			group_id: authority.groupId,
			last_refresh_at: cacheTime,
			last_success_at: cacheTime,
			last_error: "old-offline",
			updated_at: cacheTime,
			refresh_revision: 0,
		},
	});
	expect(result).toMatchObject({ status: "refreshed" });
	expect(db.prepare("SELECT * FROM scope_membership_cache_state").get()).toMatchObject({
		last_refresh_at: later.toISOString(),
		last_success_at: later.toISOString(),
		last_error: null,
		updated_at: later.toISOString(),
		refresh_revision: 1,
	});
	expect(effective).toEqual({ ...raw, keyId: EXPECTED_KEY_ID });
	expect(transaction).not.toHaveBeenCalled();
});

it.each(["legacy", "bootstrap", "absent"] as const)(
	"reads %s state through public read-only raw APIs without writes or transactions",
	(stateKind) => {
		// Arrange
		const filename = temporaryCacheFilename();
		const writer = setup(filename);
		seedOld(writer);
		seedOld(writer, cacheScope({ scope_id: "scope-manual", authority_type: "manual" }));
		if (stateKind === "legacy") seedLegacyCacheState(writer);
		if (stateKind === "absent") writer.exec("DROP TABLE scope_membership_cache_state");
		const reader = connectReadOnly(filename);
		connections.push(reader);
		const transaction = vi.spyOn(reader, "transaction");
		const exec = vi.spyOn(reader, "exec");
		const pragma = vi.spyOn(reader, "pragma");
		const state =
			stateKind === "absent"
				? undefined
				: reader.prepare("SELECT * FROM scope_membership_cache_state").get();
		const schema = reader.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
		// Act
		const raw = getCachedScopeAuthorization(reader, input);
		const listed = listCachedScopesForDevice(reader, input.deviceId, input);
		const managed = getEffectiveCachedScopeAuthorization(reader, input);
		const manual = getEffectiveCachedScopeAuthorization(reader, {
			...input,
			scopeId: "scope-manual",
		});
		// Assert
		expect(raw).toMatchObject({
			authorized: true,
			freshness: stateKind === "legacy" ? "stale" : "unknown",
		});
		expect(listed.memberships.map((row) => row.scope_id)).toEqual(["scope-a", "scope-manual"]);
		expect(listed.cacheStates).toEqual(raw.cacheStates);
		if (stateKind === "legacy")
			expect(raw.cacheStates[0]).toMatchObject({
				last_error: "old-offline",
				last_success_at: cacheTime,
			});
		expect(managed).toMatchObject({ authorized: false, freshness: raw.freshness, keyId: null });
		expect(manual).toMatchObject({ authorized: true, keyId: null });
		if (stateKind !== "absent")
			expect(reader.prepare("SELECT * FROM scope_membership_cache_state").get()).toEqual(state);
		expect(reader.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
		expect(transaction).not.toHaveBeenCalled();
		expect(exec).not.toHaveBeenCalled();
		expect(pragma).not.toHaveBeenCalled();
	},
);

it.each(["catalogue", "member"] as const)(
	"ignores a late %s network failure after a newer success, including a third in-flight grant",
	async (stage) => {
		// Arrange: distinct SQLite connections must share the same persisted revision.
		const filename = temporaryCacheFilename();
		const db = setup(filename);
		const writer = new Database(filename);
		connections.push(writer);
		if (stage === "catalogue") seedOld(db);
		else await refresh(db);
		const replacement = rotated();
		const requested = Promise.withResolvers<void>();
		const delivery = Promise.withResolvers<ScopeMembershipSnapshot>();
		const pending = refreshScopeMembershipCache(db, {
			...authority,
			groupIds: [authority.groupId],
			now: new Date(cacheTime),
			fetchers: {
				listScopes: async () => {
					if (stage === "catalogue") {
						requested.resolve();
						await delivery.promise;
					}
					return { version: 1, items: [cacheScope()] };
				},
				getScopeSnapshot: () => {
					requested.resolve();
					return delivery.promise;
				},
			},
		});
		await requested.promise;
		const thirdRequested = Promise.withResolvers<void>();
		const thirdDelivery = Promise.withResolvers<ScopeMembershipSnapshot>();
		const thirdSnapshot = cacheWireSnapshot(cacheScope({ scope_id: "scope-third" }));
		let third: ReturnType<typeof refresh> | undefined;
		// Act: R3 captures R2's revision before the old R1 failure arrives.
		try {
			expect(await refresh(writer, [replacement], later)).toMatchObject({ status: "refreshed" });
			const state = db.prepare("SELECT * FROM scope_membership_cache_state").get();
			const retained = proof(db);
			third = refreshScopeMembershipCache(writer, {
				...authority,
				groupIds: [authority.groupId],
				now: new Date(later.getTime() + 120_000),
				fetchers: {
					listScopes: async () => ({ version: 1, items: [thirdSnapshot.scope] }),
					getScopeSnapshot: () => {
						thirdRequested.resolve();
						return thirdDelivery.promise;
					},
				},
			});
			await thirdRequested.promise;
			delivery.reject(new Error("late offline"));
			const failed = await pending;
			// Assert: R1 cannot replace R2 diagnostics, proof, key, or invalidate R3's revision.
			expect(failed).toMatchObject({ status: "stale" });
			expect(db.prepare("SELECT * FROM scope_membership_cache_state").get()).toEqual(state);
			expect(proof(db)).toEqual(retained);
			expect(concurrentKeyDecisions(db, firstItem(replacement).enrollment.public_key)).toEqual({
				oldKey: false,
				newKey: true,
			});
			thirdDelivery.resolve(thirdSnapshot);
			expect(await third).toMatchObject({ status: "refreshed" });
			expect(
				getEffectiveCachedScopeAuthorization(db, { ...input, scopeId: "scope-third" }),
			).toMatchObject({ authorized: true, keyId: EXPECTED_KEY_ID });
		} finally {
			delivery.reject(new Error("fixture cleanup"));
			thirdDelivery.resolve(thirdSnapshot);
			await pending;
			await third;
		}
	},
);

it.each(["malformed", Number.MAX_SAFE_INTEGER])(
	"keeps refreshing a later group when revision %s prevents failure diagnostics",
	async (revision) => {
		// Arrange: error recording for group A must not escape and skip valid group B.
		const db = setup();
		await refresh(db);
		const retained = proof(db);
		db.prepare("UPDATE scope_membership_cache_state SET refresh_revision = ?").run(revision);
		const snapshot = cacheWireSnapshot(cacheScope({ scope_id: "scope-b", group_id: "group-b" }));
		// Act
		const result = await refreshScopeMembershipCache(db, {
			...authority,
			groupIds: [authority.groupId, "group-b"],
			now: later,
			fetchers: {
				listScopes: async () => ({ version: 1, items: [snapshot.scope] }),
				getScopeSnapshot: async () => snapshot,
			},
		});
		// Assert: group A retains its old proof; group B can still commit a verified grant.
		expect(result).toMatchObject({
			status: "partial",
			groups: [
				{ groupId: "group-a", status: "stale" },
				{ groupId: "group-b", status: "refreshed" },
			],
		});
		expect(proof(db)).toEqual(retained);
		expect(
			getEffectiveCachedScopeAuthorization(db, { ...input, scopeId: "scope-b", now: later }),
		).toMatchObject({ authorized: true, keyId: EXPECTED_KEY_ID });
	},
);
