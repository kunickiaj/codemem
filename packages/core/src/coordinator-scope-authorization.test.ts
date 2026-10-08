import { Hash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	MALFORMED_KEYS,
	NODE_ONLY_ALIASES,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { READ_SCOPE_AUTHORIZATION_SQL } from "./coordinator-scope-authorization.js";

const input = { groupId: "scope-group", scopeId: "scope-a" };
const unavailable = { kind: "rejected", error: "scope_authorization_unavailable" };
const revocation = {
	groupId: input.groupId,
	deviceId: "device-a",
	publicKey: CANONICAL_PUBLIC_KEY,
	fingerprint: "untrusted-display-fingerprint",
	actorId: "operator",
};
const stores: BetterSqliteCoordinatorStore[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) await store.close();
});

async function fixture() {
	const store = new BetterSqliteCoordinatorStore(":memory:");
	stores.push(store);
	await store.createGroup(input.groupId);
	await store.createScope({
		...input,
		label: "Scope A",
		coordinatorId: "coordinator-a",
		membershipEpoch: 2,
		manifestIssuerDeviceId: "issuer-a",
		manifestHash: "manifest-a",
	});
	for (const deviceId of ["device-a", "device-b"]) {
		await store.enrollDevice(input.groupId, {
			deviceId,
			publicKey: CANONICAL_PUBLIC_KEY,
			fingerprint: "untrusted-display-fingerprint",
		});
		await store.grantScopeMembership({
			scopeId: input.scopeId,
			deviceId,
			effectId: `grant:${deviceId}`,
			membershipEpoch: 2,
			manifestIssuerDeviceId: "issuer-a",
			manifestHash: "manifest-a",
		});
	}
	return store;
}

async function memberIds(store: BetterSqliteCoordinatorStore) {
	const result = await store.getScopeAuthorization(input);
	expect(result.kind).toBe("authorized");
	if (result.kind !== "authorized") throw new Error("Expected authorized snapshot");
	return result.members.map((member) => member.membership.device_id);
}

function beforeFinalRead(store: BetterSqliteCoordinatorStore, sql: string, mutate: () => void) {
	const prepare = store.db.prepare.bind(store.db);
	let changed = false;
	const hook = vi.spyOn(store.db, "prepare").mockImplementation((query) => {
		if (query === sql && !changed) {
			changed = true;
			mutate();
		}
		return prepare(query);
	});
	return hook;
}

describe("SQLite current scope authorization", () => {
	it("returns version 1 with the exact scope, membership and enrollment DTOs", async () => {
		// Arrange: fingerprints and actor hints are not canonical key proof.
		const store = await fixture();
		const scope = (await store.listScopes()).find((row) => row.scope_id === input.scopeId);
		const memberships = await store.listScopeMemberships(input.scopeId, true);
		const enrollments = await store.listEnrolledDevices(input.groupId);
		// Act
		const result = await store.getScopeAuthorization(input);
		// Assert
		expect(result).toEqual({
			kind: "authorized",
			authorizationVersion: 1,
			scope,
			members: memberships.map((membership) => ({
				membership,
				enrollment: enrollments.find((row) => row.device_id === membership.device_id),
				keyId: EXPECTED_KEY_ID,
			})),
		});
	});

	it.each([...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES])(
		"canonicalizes $name before checking a key-only tombstone",
		async ({ publicKey }) => {
			// Arrange: the same key under another ID is globally revoked.
			const store = await fixture();
			store.db
				.prepare("UPDATE enrolled_devices SET public_key = ? WHERE device_id = 'device-b'")
				.run(publicKey);
			const before = await store.getScopeAuthorization(input);
			const created = await store.createDeviceRevocation(revocation);
			expect(created.kind).toBe("revoked");
			store.db
				.prepare("DELETE FROM coordinator_device_revocations WHERE subject_kind = 'device_id'")
				.run();
			// Act
			const result = await store.getScopeAuthorization(input);
			// Assert
			expect(before).toMatchObject({
				kind: "authorized",
				members: [{ keyId: EXPECTED_KEY_ID }, { keyId: EXPECTED_KEY_ID }],
			});
			expect(result).toMatchObject({ kind: "authorized", authorizationVersion: 1, members: [] });
			expect(await store.listScopeMemberships(input.scopeId, true)).toHaveLength(2);
		},
	);
});

describe("SQLite membership authority and raw history", () => {
	it("excludes an ID-only tombstone without excluding the other device sharing its key", async () => {
		// Arrange
		const store = await fixture();
		await store.createDeviceRevocation(revocation);
		store.db
			.prepare("DELETE FROM coordinator_device_revocations WHERE subject_kind = 'ed25519_key'")
			.run();
		const memberships = await store.listScopeMemberships(input.scopeId, true);
		const audit = await store.listScopeMembershipAuditEvents({ scopeId: input.scopeId });
		// Act
		const ids = await memberIds(store);
		// Assert: authorization filtering must not rewrite inspection/history.
		expect(ids).toEqual(["device-b"]);
		expect(await store.listScopeMemberships(input.scopeId, true)).toEqual(memberships);
		expect(await store.listScopeMembershipAuditEvents({ scopeId: input.scopeId })).toEqual(audit);
		expect(await store.listDeviceRevocations({ deviceId: "device-a" })).toHaveLength(1);
	});

	it("preserves revoked memberships and removed scope inspection instead of turning them into authority", async () => {
		// Arrange
		const store = await fixture();
		await store.revokeScopeMembership({
			scopeId: input.scopeId,
			deviceId: "device-a",
			effectId: "revoke:a",
			membershipEpoch: 3,
		});
		const rows = await store.listScopeMemberships(input.scopeId, true);
		const audit = await store.listScopeMembershipAuditEvents({ scopeId: input.scopeId });
		// Act
		const ids = await memberIds(store);
		store.db.prepare("UPDATE coordinator_scopes SET status = 'removed'").run();
		const removed = await store.getScopeAuthorization(input);
		// Assert
		expect(ids).toEqual(["device-b"]);
		expect(removed).toEqual({ kind: "rejected", error: "scope_inactive" });
		expect(await store.listScopes({ includeInactive: true })).toMatchObject([
			{ status: "removed" },
		]);
		expect(await store.listScopeMemberships(input.scopeId, true)).toEqual(rows);
		expect(await store.listScopeMembershipAuditEvents({ scopeId: input.scopeId })).toEqual(audit);
	});

	it.each([
		["disabled", "UPDATE enrolled_devices SET enabled = 0 WHERE device_id = 'device-a'"],
		["missing enrollment", "DELETE FROM enrolled_devices WHERE device_id = 'device-a'"],
		[
			"wrong enrollment group",
			"UPDATE enrolled_devices SET group_id = 'other-group' WHERE device_id = 'device-a'",
		],
		[
			"old epoch",
			"UPDATE coordinator_scope_memberships SET membership_epoch = 1 WHERE device_id = 'device-a'",
		],
		[
			"conflicting group",
			"UPDATE coordinator_scope_memberships SET group_id = 'other-group' WHERE device_id = 'device-a'",
		],
		[
			"conflicting coordinator",
			"UPDATE coordinator_scope_memberships SET coordinator_id = 'other-coordinator' WHERE device_id = 'device-a'",
		],
		[
			"conflicting issuer",
			"UPDATE coordinator_scope_memberships SET manifest_issuer_device_id = 'other-issuer' WHERE device_id = 'device-a'",
		],
		[
			"conflicting manifest",
			"UPDATE coordinator_scope_memberships SET manifest_hash = 'other-manifest' WHERE device_id = 'device-a'",
		],
	])("excludes a member with %s", async (_name, sql) => {
		// Arrange
		const store = await fixture();
		store.db.prepare(sql).run();
		// Act
		const ids = await memberIds(store);
		// Assert
		expect(ids).toEqual(["device-b"]);
		expect(await store.listScopeMemberships(input.scopeId, true)).toHaveLength(2);
	});

	it("accepts non-conflicting null legacy member metadata but still requires enrollment", async () => {
		// Arrange: a legacy member inherits the scope source, not issuer or account ownership.
		const store = await fixture();
		store.db
			.prepare(
				"UPDATE coordinator_scope_memberships SET coordinator_id = NULL, group_id = NULL, manifest_issuer_device_id = NULL, manifest_hash = NULL",
			)
			.run();
		store.db.prepare("DELETE FROM enrolled_devices WHERE device_id = 'device-a'").run();
		// Act
		const ids = await memberIds(store);
		// Assert
		expect(ids).toEqual(["device-b"]);
	});

	it.each([
		["missing", "DELETE FROM coordinator_scopes", "scope_not_found"],
		["inactive", "UPDATE coordinator_scopes SET status = 'removed'", "scope_inactive"],
		[
			"wrong group",
			"UPDATE coordinator_scopes SET group_id = 'other-group'",
			"scope_source_mismatch",
		],
		["unbound group", "UPDATE coordinator_scopes SET group_id = NULL", "scope_source_mismatch"],
		["archived group", "UPDATE groups SET archived_at = '2026-10-07'", "group_archived"],
	])("rejects a %s scope", async (_name, sql, error) => {
		// Arrange
		const store = await fixture();
		store.db.prepare(sql).run();
		// Act
		const result = await store.getScopeAuthorization(input);
		// Assert
		expect(result).toEqual({ kind: "rejected", error });
	});
});

describe("SQLite key and input capture", () => {
	it("does not treat an owner role or identity hint as proof without a current public key", async () => {
		// Arrange: these fields are metadata, not an alternate authorization source.
		const store = await fixture();
		store.db
			.prepare(
				"UPDATE coordinator_scope_memberships SET role = 'owner' WHERE device_id = 'device-a'",
			)
			.run();
		store.db
			.prepare(
				"UPDATE enrolled_devices SET identity_id = 'identity-owner', public_key = 'pk1' WHERE device_id = 'device-a'",
			)
			.run();
		// Act
		const ids = await memberIds(store);
		// Assert
		expect(ids).toEqual(["device-b"]);
	});

	it.each([
		"UPDATE coordinator_scope_memberships SET membership_epoch = -1 WHERE device_id = 'device-a'",
		"UPDATE coordinator_scopes SET membership_epoch = -1",
	])("rejects malformed storage with a fixed error: %s", async (sql) => {
		// Arrange
		const store = await fixture();
		store.db.prepare(sql).run();
		// Act
		const result = await store.getScopeAuthorization(input);
		// Assert
		expect(result).toEqual(unavailable);
	});
	it.each(["pk1", "", ...MALFORMED_KEYS.map((key) => key.publicKey)])(
		"never promotes malformed or opaque enrollment key %s",
		async (key) => {
			// Arrange
			const store = await fixture();
			store.db
				.prepare("UPDATE enrolled_devices SET public_key = ? WHERE device_id = 'device-a'")
				.run(key);
			// Act
			const ids = await memberIds(store);
			// Assert
			expect(ids).toEqual(["device-b"]);
		},
	);

	it("captures primitive caller options before the async wrapper returns", async () => {
		// Arrange
		const store = await fixture();
		const options = { ...input };
		// Act
		const pending = store.getScopeAuthorization(options);
		options.groupId = "different-group";
		options.scopeId = "different-scope";
		const result = await pending;
		// Assert
		expect(result).toMatchObject({
			kind: "authorized",
			scope: { scope_id: input.scopeId, group_id: input.groupId },
		});
	});

	it("rejects accessor options without invoking caller code", async () => {
		// Arrange
		const store = await fixture();
		const getter = vi.fn(() => input.groupId);
		const options = {
			get groupId() {
				return getter();
			},
			scopeId: input.scopeId,
		};
		// Act
		const result = await store.getScopeAuthorization(options);
		// Assert
		expect(result).toEqual(unavailable);
		expect(getter).not.toHaveBeenCalled();
	});
});

describe("SQLite final snapshot pins", () => {
	it("captures the whole roster before hashing can change a later member's key", async () => {
		// Arrange: mutate the second member during the first canonical hash.
		const store = await fixture();
		const mutation = store.db.prepare(
			"UPDATE enrolled_devices SET public_key = public_key || ' replacement-comment' WHERE device_id = 'device-b'",
		);
		const update = Hash.prototype.update;
		let changed = false;
		vi.spyOn(Hash.prototype, "update").mockImplementation(function (data, encoding) {
			if (!changed) {
				changed = true;
				mutation.run();
			}
			if (typeof data === "string") return update.call(this, data, encoding);
			return update.call(this, data);
		});
		// Act
		const ids = await memberIds(store);
		// Assert: rereading the second key after hashing would incorrectly promote it.
		expect(changed).toBe(true);
		expect(ids).toEqual(["device-a"]);
	});
	it.each([
		[
			"key replacement",
			"UPDATE enrolled_devices SET public_key = 'replacement-key' WHERE device_id = 'device-a'",
		],
		[
			"same-key representation drift",
			"UPDATE enrolled_devices SET public_key = public_key || ' changed-comment' WHERE device_id = 'device-a'",
		],
		[
			"fingerprint drift",
			"UPDATE enrolled_devices SET fingerprint = 'new-fingerprint' WHERE device_id = 'device-a'",
		],
		["disabled enrollment", "UPDATE enrolled_devices SET enabled = 0 WHERE device_id = 'device-a'"],
		["deleted enrollment", "DELETE FROM enrolled_devices WHERE device_id = 'device-a'"],
		[
			"member epoch drift",
			"UPDATE coordinator_scope_memberships SET membership_epoch = 3 WHERE device_id = 'device-a'",
		],
		[
			"member source drift",
			"UPDATE coordinator_scope_memberships SET manifest_hash = 'changed' WHERE device_id = 'device-a'",
		],
	])("does not refresh %s into the captured positive member", async (_name, sql) => {
		// Arrange: mutate the real connection after capture, immediately before final SQL.
		const store = await fixture();
		const mutation = store.db.prepare(sql);
		const hook = beforeFinalRead(store, READ_SCOPE_AUTHORIZATION_SQL, () => mutation.run());
		// Act
		const ids = await memberIds(store);
		// Assert
		expect(ids).toEqual(["device-b"]);
		expect(hook).toHaveBeenCalledWith(READ_SCOPE_AUTHORIZATION_SQL);
	});

	it("checks late key tombstones against captured canonical keys without deleting membership history", async () => {
		// Arrange: retain valid tombstone tuples, then reinsert only at the final read.
		const store = await fixture();
		const revoked = await store.createDeviceRevocation(revocation);
		if (revoked.kind !== "revoked") throw new Error("Expected test tombstones");
		const records = store.db.prepare("SELECT * FROM coordinator_device_revocations").all();
		store.db.prepare("DELETE FROM coordinator_device_revocations").run();
		// Restore the exact existing table tuples, not a new authorization source.
		const restore = records.map((row) => {
			const record = row as Record<string, unknown>;
			return {
				statement: store.db.prepare(
					`INSERT INTO coordinator_device_revocations (${Object.keys(record).join(",")}) VALUES (${Object.keys(
						record,
					)
						.map(() => "?")
						.join(",")})`,
				),
				values: Object.values(record),
			};
		});
		beforeFinalRead(store, READ_SCOPE_AUTHORIZATION_SQL, () => {
			for (const row of restore) row.statement.run(...row.values);
		});
		// Act
		const ids = await memberIds(store);
		// Assert
		expect(ids).toEqual([]);
		expect(await store.listScopeMemberships(input.scopeId, true)).toHaveLength(2);
	});

	it.each([
		["epoch", "UPDATE coordinator_scopes SET membership_epoch = 3"],
		["group", "UPDATE coordinator_scopes SET group_id = 'other-group'"],
		["manifest", "UPDATE coordinator_scopes SET manifest_hash = 'changed'"],
		["archive", "UPDATE groups SET archived_at = '2026-10-07'"],
	])("rejects %s drift at the final scope read", async (_name, sql) => {
		// Arrange
		const store = await fixture();
		const mutation = store.db.prepare(sql);
		beforeFinalRead(store, READ_SCOPE_AUTHORIZATION_SQL, () => mutation.run());
		// Act
		const result = await store.getScopeAuthorization(input);
		// Assert
		expect(result).toEqual(unavailable);
	});
});

describe("SQLite private backend failures", () => {
	it("returns a fixed private error when the final backend read fails", async () => {
		// Arrange
		const store = await fixture();
		beforeFinalRead(store, READ_SCOPE_AUTHORIZATION_SQL, () => {
			throw new Error("SELECT private-device-id FROM private-table");
		});
		// Act
		const result = await store.getScopeAuthorization(input);
		// Assert
		expect(result).toEqual(unavailable);
	});

	it.each(["not-json", "null", "{}", "[{}]"])(
		"rejects malformed final member tuples: %s",
		async (membersJson) => {
			// Arrange: exercise decoding of the actual final atomic SELECT result.
			const store = await fixture();
			const prepare = store.db.prepare.bind(store.db);
			vi.spyOn(store.db, "prepare").mockImplementation((query) => {
				const statement = prepare(query);
				if (query === READ_SCOPE_AUTHORIZATION_SQL) {
					const get = statement.get.bind(statement);
					vi.spyOn(statement, "get").mockImplementation((...values) => {
						const row = get(...values);
						if (!row || typeof row !== "object") throw new Error("Expected final row");
						return { ...row, members_json: membersJson };
					});
				}
				return statement;
			});
			// Act
			const result = await store.getScopeAuthorization(input);
			// Assert
			expect(result).toEqual(unavailable);
		},
	);

	it("rejects a dropped revocation backend instead of returning raw members", async () => {
		// Arrange
		const store = await fixture();
		store.db.exec("DROP TABLE coordinator_device_revocations");
		// Act
		const result = await store.getScopeAuthorization(input);
		// Assert
		expect(result).toEqual(unavailable);
	});
});

describe("SQLite review regressions", () => {
	it("accepts empty display names written through rename and enrollment", async () => {
		// Arrange: display metadata is not membership authority.
		const store = await fixture();
		await store.renameDevice(input.groupId, "device-b", "");
		await store.enrollDevice(input.groupId, {
			deviceId: "device-c",
			publicKey: CANONICAL_PUBLIC_KEY,
			fingerprint: "fixture-fingerprint",
			displayName: "",
		});
		await store.grantScopeMembership({
			scopeId: input.scopeId,
			deviceId: "device-c",
			effectId: "grant:c",
			membershipEpoch: 2,
		});
		// Act
		const result = await store.getScopeAuthorization(input);
		// Assert
		expect(result).toMatchObject({
			kind: "authorized",
			members: [
				{ membership: { device_id: "device-a" }, enrollment: { display_name: null } },
				{ membership: { device_id: "device-b" }, enrollment: { display_name: "" } },
				{ membership: { device_id: "device-c" }, enrollment: { display_name: "" } },
			],
		});
	});

	it.each(["revoked", "active"])(
		"handles an empty role on a %s membership without rewriting history",
		async (status) => {
			// Arrange: inactive audit rows are not positive member candidates.
			const store = await fixture();
			if (status === "revoked")
				await store.revokeScopeMembership({
					scopeId: input.scopeId,
					deviceId: "device-a",
					effectId: "revoke:empty-role",
					membershipEpoch: 3,
				});
			store.db
				.prepare("UPDATE coordinator_scope_memberships SET role = '' WHERE device_id = 'device-a'")
				.run();
			const history = await store.listScopeMemberships(input.scopeId, true);
			// Act
			const result = await store.getScopeAuthorization(input);
			// Assert
			if (status === "active") expect(result).toEqual(unavailable);
			else
				expect(result).toMatchObject({
					kind: "authorized",
					members: [{ membership: { device_id: "device-b" } }],
				});
			expect(await store.listScopeMemberships(input.scopeId, true)).toEqual(history);
		},
	);

	it("rejects local authority written through the public scope updater", async () => {
		// Arrange
		const store = await fixture();
		await store.updateScope({ scopeId: input.scopeId, authorityType: "local" });
		// Act
		const result = await store.getScopeAuthorization(input);
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "scope_source_mismatch" });
	});

	it("rejects authority drift at the final atomic read", async () => {
		// Arrange
		const store = await fixture();
		const mutation = store.db.prepare("UPDATE coordinator_scopes SET authority_type = 'local'");
		beforeFinalRead(store, READ_SCOPE_AUTHORIZATION_SQL, () => mutation.run());
		// Act
		const result = await store.getScopeAuthorization(input);
		// Assert
		expect(result).toEqual(unavailable);
	});

	it("allows a legacy null coordinator with an explicit group but excludes conflicting member metadata", async () => {
		// Arrange: null source metadata is not tenant or owner proof.
		const store = await fixture();
		store.db.prepare("UPDATE coordinator_scopes SET coordinator_id = NULL").run();
		store.db
			.prepare(
				"UPDATE coordinator_scope_memberships SET coordinator_id = NULL WHERE device_id = 'device-b'",
			)
			.run();
		// Act
		const ids = await memberIds(store);
		// Assert
		expect(ids).toEqual(["device-b"]);
		expect(await store.listScopeMemberships(input.scopeId, true)).toHaveLength(2);
	});

	it("sorts validated final tuples even when the backend returns them in reverse order", async () => {
		// Arrange: reverse only exact captured tuples, not membership authority.
		const store = await fixture();
		const prepare = store.db.prepare.bind(store.db);
		vi.spyOn(store.db, "prepare").mockImplementation((query) => {
			const statement = prepare(query);
			if (query === READ_SCOPE_AUTHORIZATION_SQL) {
				const get = statement.get.bind(statement);
				vi.spyOn(statement, "get").mockImplementation((...values) => {
					const row = get(...values);
					if (
						!row ||
						typeof row !== "object" ||
						!("members_json" in row) ||
						typeof row.members_json !== "string"
					)
						throw new Error("Expected final member tuples");
					const members: unknown = JSON.parse(row.members_json);
					if (!Array.isArray(members)) throw new Error("Expected member array");
					return { ...row, members_json: JSON.stringify(members.reverse()) };
				});
			}
			return statement;
		});
		// Act
		const ids = await memberIds(store);
		// Assert
		expect(ids).toEqual(["device-a", "device-b"]);
	});
});

it("keeps D1 unavailable without consulting raw scope getters", async () => {
	// Arrange: D1 adoption is a separate slice, not a raw-getter fallback.
	const f = setupStore("D1");
	const raw = vi.spyOn(f.store, "listScopes").mockRejectedValue(new Error("raw fallback"));
	try {
		// Act
		const result = await f.store.getScopeAuthorization(input);
		// Assert
		expect(result).toEqual(unavailable);
		expect(raw).not.toHaveBeenCalled();
	} finally {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
});
