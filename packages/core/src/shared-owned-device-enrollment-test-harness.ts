import { expect } from "vitest";
import {
	insertOwnership,
	OWNERSHIP_TABLE,
	type OwnershipFixture,
	ownedRow,
	type ownershipHarness,
} from "./coordinator-device-ownership-test-harness.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	NODE_ONLY_ALIASES,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";

export const OWNED_DENIAL = "device_ownership_requires_verified_identity";
export const OWNED_UNAVAILABLE = "device_ownership_authorization_unavailable";
export const ownedEnrollment = {
	deviceId: String(ownedRow.device_id),
	publicKey: CANONICAL_PUBLIC_KEY,
	fingerprint: "a".repeat(64),
	identityId: String(ownedRow.identity_id),
	displayName: "Original",
};
export const ownedGroup = "owned-enrollment-group";
export async function ownedSnapshot(f: OwnershipFixture) {
	return Promise.all(
		["enrolled_devices", OWNERSHIP_TABLE, "coordinator_device_revocations"].map((table) =>
			f.query(`SELECT * FROM ${table} ORDER BY rowid`),
		),
	);
}
export async function seedOwnedEnrollment(f: OwnershipFixture) {
	await f.store.createGroup(ownedGroup);
	await f.store.enrollDevice(ownedGroup, ownedEnrollment);
	await insertOwnership(f);
}
type Test = ReturnType<typeof ownershipHarness>;
export function registerOwnedEnrollmentContract(test: Test) {
	registerDeniedWrites(test);
	registerEnable(test);
	registerLegacy(test);
	registerRetention(test);
	registerRevocation(test);
	registerUnavailable(test);
	registerInputTypes(test);
	registerStoredOwnedKey(test);
	registerStoredAliasCompatibility(test);
}

export const storedOwnedAlias = {
	...ownedEnrollment,
	deviceId: "unowned-alias",
	identityId: undefined,
};
export const aliasReplacement = {
	...storedOwnedAlias,
	publicKey: UNRELATED_PUBLIC_KEY,
	fingerprint: "e".repeat(64),
	displayName: "overwrite",
};
export async function seedStoredOwnedAlias(f: OwnershipFixture, publicKey = CANONICAL_PUBLIC_KEY) {
	await f.store.createGroup(ownedGroup);
	await f.store.enrollDevice(ownedGroup, { ...storedOwnedAlias, publicKey });
	await insertOwnership(f);
}
export function registerStoredKeyRaces(
	test: Test,
	guarded: (f: OwnershipFixture, hook: () => Promise<void>) => OwnershipFixture["store"],
) {
	for (const scenario of [
		"late binding",
		"rotate captured owned key",
		"delete captured owned row",
		"absent row appears",
	] as const) {
		test(`stored key race: ${scenario} cannot overwrite or re-enable`, async ({ fixture: f }) => {
			// Arrange: the mutator's changes are allowed; this enrollment attempt must add none.
			await f.store.createGroup(ownedGroup);
			if (scenario !== "absent row appears")
				await f.store.enrollDevice(ownedGroup, storedOwnedAlias);
			if (scenario !== "late binding") await insertOwnership(f);
			let atGate: unknown[][] = [];
			const hook = async () => {
				await mutateStoredKeyRace(f, scenario);
				atGate = await ownedSnapshot(f);
			};
			const racing = guarded(f, hook);
			// Act
			const pending = racing.enrollDevice(ownedGroup, aliasReplacement);
			// Assert: captured current ownership wins even if that row rotates or disappears.
			await expect(pending).rejects.toThrow(
				new RegExp(`^${scenario === "absent row appears" ? OWNED_UNAVAILABLE : OWNED_DENIAL}$`),
			);
			expect(atGate).toHaveLength(3);
			expect(await ownedSnapshot(f)).toEqual(atGate);
		});
	}
}
async function mutateStoredKeyRace(f: OwnershipFixture, scenario: string) {
	if (scenario === "late binding") return insertOwnership(f);
	if (scenario === "rotate captured owned key")
		return f.exec(
			"UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?",
			UNRELATED_PUBLIC_KEY,
			storedOwnedAlias.deviceId,
		);
	if (scenario === "delete captured owned row")
		return f.exec("DELETE FROM enrolled_devices WHERE device_id = ?", storedOwnedAlias.deviceId);
	return f.exec(
		"INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,enabled,created_at) VALUES (?,?,?,?,0,?)",
		ownedGroup,
		storedOwnedAlias.deviceId,
		CANONICAL_PUBLIC_KEY,
		"unrelated-physical-fingerprint",
		"2026-10-07",
	);
}
function registerStoredOwnedKey(test: Test) {
	for (const enabled of [true, false]) {
		for (const identityId of [undefined, "foreign-identity", String(ownedRow.identity_id)]) {
			test(`stored owned key blocks unrelated replacement (${enabled}, hint ${identityId})`, async ({
				fixture: f,
			}) => {
				// Arrange: incoming ID/key have no binding; only the current stored key is owned.
				await seedStoredOwnedAlias(f);
				if (!enabled) await f.store.setDeviceEnabled(ownedGroup, storedOwnedAlias.deviceId, false);
				const incomingKeyId = await ed25519KeyId(aliasReplacement.publicKey);
				expect(
					await f.query(
						`SELECT COUNT(*) AS count FROM ${OWNERSHIP_TABLE} WHERE device_id = ? OR key_id = ?`,
						storedOwnedAlias.deviceId,
						incomingKeyId,
					),
				).toEqual([{ count: 0 }]);
				expect(
					await f.query(
						`SELECT COUNT(*) AS count FROM ${OWNERSHIP_TABLE} WHERE key_id = ?`,
						ownedRow.key_id,
					),
				).toEqual([{ count: 1 }]);
				const before = await ownedSnapshot(f);
				// Act
				const pending = f.store.enrollDevice(ownedGroup, { ...aliasReplacement, identityId });
				// Assert
				await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
				expect(await ownedSnapshot(f)).toEqual(before);
			});
		}
	}
}
function registerStoredAliasCompatibility(test: Test) {
	for (const alias of [
		{ name: "comment", publicKey: `${CANONICAL_PUBLIC_KEY} stored-comment` },
		...NODE_ONLY_ALIASES,
	]) {
		test(`stored owned ${alias.name} canonical key blocks unrelated replacement`, async ({
			fixture: f,
		}) => {
			// Arrange: the physical fingerprint deliberately is not canonical ownership metadata.
			await seedStoredOwnedAlias(f, alias.publicKey);
			const before = await ownedSnapshot(f);
			// Act
			const pending = f.store.enrollDevice(ownedGroup, aliasReplacement);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(await ownedSnapshot(f)).toEqual(before);
		});
	}
	test("unbound current opaque key still permits unrelated replacement", async ({ fixture: f }) => {
		// Arrange
		await f.store.createGroup(ownedGroup);
		await f.store.enrollDevice(ownedGroup, { ...storedOwnedAlias, publicKey: "opaque-legacy-key" });
		// Act
		await f.store.enrollDevice(ownedGroup, aliasReplacement);
		// Assert
		expect(await f.store.getEnrollment(ownedGroup, storedOwnedAlias.deviceId)).toMatchObject({
			public_key: UNRELATED_PUBLIC_KEY,
			display_name: "overwrite",
			enabled: 1,
		});
		expect(await f.query(`SELECT * FROM ${OWNERSHIP_TABLE}`)).toEqual([]);
	});
	test("incoming revocation retains priority over the current stored owned key", async ({
		fixture: f,
	}) => {
		// Arrange: revoke an unrelated incoming key using a genuine enrollment tuple.
		await f.store.createGroup(ownedGroup);
		const revoked = {
			...aliasReplacement,
			deviceId: "revoked-key-source",
			groupId: ownedGroup,
			actorId: "fixture-operator",
		};
		await f.store.enrollDevice(ownedGroup, revoked);
		await f.store.createDeviceRevocation(revoked);
		await seedStoredOwnedAlias(f);
		const before = await ownedSnapshot(f);
		// Act
		const pending = f.store.enrollDevice(ownedGroup, aliasReplacement);
		// Assert
		await expect(pending).rejects.toThrow(/^device_revoked$/);
		expect(await ownedSnapshot(f)).toEqual(before);
	});
}
function registerInputTypes(test: Test) {
	for (const field of [
		"deviceId",
		"publicKey",
		"fingerprint",
		"identityId",
		"displayName",
	] as const) {
		test(`BLOB ${field} cannot bypass TEXT ownership authority`, async ({ fixture: f }) => {
			// Arrange
			await seedOwnedEnrollment(f);
			const before = await ownedSnapshot(f);
			const input = {
				...ownedEnrollment,
				[field]: new TextEncoder().encode(ownedEnrollment[field]),
			};
			// Act: deliberately violate the public TS contract to test its runtime boundary.
			const pending = f.store.enrollDevice(ownedGroup, input as unknown as typeof ownedEnrollment);
			// Assert
			await expect(pending).rejects.toThrow(/^invalid_input$/);
			expect(await ownedSnapshot(f)).toEqual(before);
		});
	}
	test("caller getters cannot replace a captured device ID or run as authority", async ({
		fixture: f,
	}) => {
		// Arrange
		await seedOwnedEnrollment(f);
		const getter = () => {
			throw new Error("private getter diagnostic");
		};
		const input = { ...ownedEnrollment };
		Object.defineProperty(input, "deviceId", { get: getter });
		const before = await ownedSnapshot(f);
		// Act
		const pending = f.store.enrollDevice(ownedGroup, input);
		// Assert
		await expect(pending).rejects.toThrow(/^invalid_input$/);
		expect(await ownedSnapshot(f)).toEqual(before);
	});
}
function registerDeniedWrites(test: Test) {
	for (const state of ["insert", "upsert"] as const) {
		for (const identityId of [undefined, "foreign-identity", String(ownedRow.identity_id)]) {
			for (const subject of ["ID", "key"] as const) {
				test(`${state} denies owned ${subject} with identity hint ${identityId}`, async ({
					fixture: f,
				}) => {
					// Arrange: even a matching identity hint is not verified owner proof.
					await f.store.createGroup(ownedGroup);
					const target = {
						...ownedEnrollment,
						deviceId: subject === "ID" ? ownedEnrollment.deviceId : "key-alias-device",
						publicKey: subject === "ID" ? UNRELATED_PUBLIC_KEY : CANONICAL_PUBLIC_KEY,
					};
					if (state === "upsert") await f.store.enrollDevice(ownedGroup, target);
					await insertOwnership(f);
					const before = await ownedSnapshot(f);
					// Act
					const pending = f.store.enrollDevice(ownedGroup, {
						...target,
						identityId,
						fingerprint: "b".repeat(64),
						displayName: "Must not write",
					});
					// Assert
					await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
					expect(await ownedSnapshot(f)).toEqual(before);
				});
			}
		}
	}
	for (const alias of [...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES]) {
		test(`canonical ${alias.name} cannot insert a new owned-key alias`, async ({ fixture: f }) => {
			// Arrange: fingerprint is deliberately unrelated to canonical authority.
			await f.store.createGroup(ownedGroup);
			await insertOwnership(f);
			const before = await ownedSnapshot(f);
			// Act
			const pending = f.store.enrollDevice(ownedGroup, {
				...ownedEnrollment,
				deviceId: "alias",
				publicKey: alias.publicKey,
				fingerprint: "f".repeat(64),
			});
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(await ownedSnapshot(f)).toEqual(before);
		});
	}
}
function registerEnable(test: Test) {
	for (const subject of ["ID", "key"] as const) {
		test(`enable denies isolated owned ${subject}; disable and remove retain ledger`, async ({
			fixture: f,
		}) => {
			// Arrange
			await f.store.createGroup(ownedGroup);
			const target = {
				...ownedEnrollment,
				deviceId: subject === "ID" ? ownedEnrollment.deviceId : "alias-device",
				publicKey: subject === "ID" ? "opaque-legacy-key" : `${CANONICAL_PUBLIC_KEY} alias`,
			};
			await f.store.enrollDevice(ownedGroup, target);
			await insertOwnership(f);
			await f.store.setDeviceEnabled(ownedGroup, target.deviceId, false);
			const before = await ownedSnapshot(f);
			// Act
			const pending = f.store.setDeviceEnabled(ownedGroup, target.deviceId, true);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(await ownedSnapshot(f)).toEqual(before);
			expect(await f.store.setDeviceEnabled(ownedGroup, target.deviceId, false)).toBe(true);
			expect(await f.store.removeDevice(ownedGroup, target.deviceId)).toBe(true);
			expect(await f.query(`SELECT * FROM ${OWNERSHIP_TABLE}`)).toEqual([ownedRow]);
		});
	}
}
function registerLegacy(test: Test) {
	for (const publicKey of [CANONICAL_PUBLIC_KEY, "opaque-legacy-key"]) {
		test(`unbound ${publicKey} keeps nullable identity upserts and long IDs`, async ({
			fixture: f,
		}) => {
			// Arrange
			await f.store.createGroup(ownedGroup);
			const input = {
				...ownedEnrollment,
				deviceId: "long-id".repeat(600),
				publicKey,
				identityId: undefined,
			};
			// Act
			await f.store.enrollDevice(ownedGroup, input);
			await f.store.setDeviceEnabled(ownedGroup, input.deviceId, false);
			const enabled = await f.store.setDeviceEnabled(ownedGroup, input.deviceId, true);
			await f.store.enrollDevice(ownedGroup, { ...input, displayName: "Updated" });
			// Assert
			expect(enabled).toBe(true);
			expect(await f.store.getEnrollment(ownedGroup, input.deviceId)).toMatchObject({
				identity_id: null,
				display_name: "Updated",
				enabled: 1,
				public_key: publicKey,
			});
			expect(await f.query(`SELECT * FROM ${OWNERSHIP_TABLE}`)).toEqual([]);
		});
	}
	test("unknown re-enable returns false without changing retained ownership", async ({
		fixture: f,
	}) => {
		// Arrange
		await seedOwnedEnrollment(f);
		const before = await ownedSnapshot(f);
		// Act
		const result = await f.store.setDeviceEnabled(ownedGroup, "unknown", true);
		// Assert
		expect(result).toBe(false);
		expect(await ownedSnapshot(f)).toEqual(before);
	});
}
function registerRetention(test: Test) {
	for (const subject of ["ID", "key"] as const) {
		test(`last-group cleanup does not release owned ${subject}`, async ({ fixture: f }) => {
			// Arrange
			await seedOwnedEnrollment(f);
			await f.store.removeDevice(ownedGroup, ownedEnrollment.deviceId);
			await f.exec("DELETE FROM groups WHERE group_id = ?", ownedGroup);
			await f.store.createGroup(ownedGroup);
			const before = await ownedSnapshot(f);
			// Act
			const pending = f.store.enrollDevice(ownedGroup, {
				...ownedEnrollment,
				deviceId: subject === "ID" ? ownedEnrollment.deviceId : "new-id",
				publicKey: subject === "ID" ? UNRELATED_PUBLIC_KEY : CANONICAL_PUBLIC_KEY,
			});
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(await ownedSnapshot(f)).toEqual(before);
		});
	}
}
function registerRevocation(test: Test) {
	for (const subject of ["device_id", "ed25519_key"] as const) {
		test(`isolated ${subject} revocation keeps precedence over ownership`, async ({
			fixture: f,
		}) => {
			// Arrange: use genuine current-tuple revocation evidence, then isolate one authority.
			await seedOwnedEnrollment(f);
			await f.store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, false);
			await f.store.createDeviceRevocation({
				...ownedEnrollment,
				groupId: ownedGroup,
				actorId: "fixture-operator",
			});
			await f.exec("DELETE FROM coordinator_device_revocations WHERE subject_kind != ?", subject);
			const before = await ownedSnapshot(f);
			// Act
			const pending = f.store.enrollDevice(ownedGroup, ownedEnrollment);
			// Assert
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(await f.store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, true)).toBe(
				false,
			);
			expect(await ownedSnapshot(f)).toEqual(before);
		});
	}
}
function registerUnavailable(test: Test) {
	for (const operation of ["insert", "upsert", "enable"] as const) {
		test(`${operation} fails closed when ownership migration is absent`, async ({ fixture: f }) => {
			// Arrange: DDL is confined to the disposable fixture database.
			await f.store.createGroup(ownedGroup);
			if (operation !== "insert") await f.store.enrollDevice(ownedGroup, ownedEnrollment);
			await f.exec(`DROP TABLE ${OWNERSHIP_TABLE}`);
			const before = await f.query("SELECT * FROM enrolled_devices");
			// Act
			const pending =
				operation === "enable"
					? f.store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, true)
					: f.store.enrollDevice(ownedGroup, ownedEnrollment);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
			expect(await f.query("SELECT * FROM enrolled_devices")).toEqual(before);
		});
	}
}
