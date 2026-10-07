import { expect, it } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";

export const OWNERSHIP_TABLE = "coordinator_device_ownership_bindings";
export const ownershipColumns = [
	"device_id",
	"key_id",
	"identity_id",
	"coordinator_id",
	"binding_id",
	"provenance",
	"source_ref",
	"bound_at",
] as const;
export type OwnershipValue = string | null | Uint8Array;
export type OwnershipRow = Record<(typeof ownershipColumns)[number], OwnershipValue>;
export const ownedRow: OwnershipRow = {
	device_id: "owned-device",
	key_id: EXPECTED_KEY_ID,
	identity_id: "owned-identity",
	coordinator_id: "coordinator-a",
	binding_id: "binding-a",
	provenance: "owner_enrollment",
	source_ref: "fixture-proof-reference",
	bound_at: "2026-10-07T00:00:00.000Z",
};
export type OwnershipFixture = {
	store: Store;
	exec: (sql: string, ...values: OwnershipValue[]) => Promise<void>;
	query: (sql: string, ...values: OwnershipValue[]) => Promise<unknown[]>;
};
export function ownershipHarness(
	fixture: (use: (f: OwnershipFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: OwnershipFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
export function insertOwnership(f: OwnershipFixture, row = ownedRow, verb = "INSERT", suffix = "") {
	return f.exec(
		`${verb} INTO ${OWNERSHIP_TABLE} (${ownershipColumns.join(", ")}) VALUES (${ownershipColumns.map(() => "?").join(", ")}) ${suffix}`,
		...ownershipColumns.map((column) => row[column]),
	);
}
function rows(f: OwnershipFixture) {
	return f.query(`SELECT * FROM ${OWNERSHIP_TABLE} ORDER BY device_id`);
}
const collisions = [
	{ name: "device with another key", patch: { key_id: "b".repeat(64), binding_id: "binding-b" } },
	{
		name: "key with another device and identity",
		patch: { device_id: "other-device", identity_id: "other-identity", binding_id: "binding-b" },
	},
	{
		name: "key with another device and same identity",
		patch: { device_id: "other-device", binding_id: "binding-b" },
	},
	{ name: "binding identifier", patch: { device_id: "other-device", key_id: "b".repeat(64) } },
	{
		name: "coordinator metadata cannot namespace keys",
		patch: { device_id: "other-device", coordinator_id: "coordinator-b", binding_id: "binding-b" },
	},
	{ name: "exact retry", patch: {} },
];

// Trusted fixture SQL tests storage invariants, not permission to bind an owner.
export function registerOwnershipContract(test: ReturnType<typeof ownershipHarness>) {
	registerCreation(test);
	registerCollisions(test);
	registerInvalid(test);
	registerBlobValidation(test);
	registerMutation(test);
	registerAliases(test);
	registerLegacy(test);
	registerRetention(test);
}
type OwnershipTest = ReturnType<typeof ownershipHarness>;
function registerBlobValidation(test: OwnershipTest) {
	for (const column of ownershipColumns) {
		test(`rejects actual BLOB bytes in ${column}`, async ({ fixture: f }) => {
			// Arrange: bind bytes directly, never normalize them to text in the adapter.
			const bytes = new TextEncoder().encode(String(ownedRow[column]));
			// Act
			const storageType = await f.query("SELECT typeof(?) AS storage_type", bytes);
			const attempt = insertOwnership(f, { ...ownedRow, [column]: bytes });
			// Assert
			expect(storageType).toEqual([{ storage_type: "blob" }]);
			await expect(attempt).rejects.toThrow(/CHECK constraint failed/);
			expect(await rows(f)).toEqual([]);
		});
	}
	for (const column of ["device_id", "key_id", "binding_id"] as const) {
		test(`BLOB copy of existing TEXT ${column} cannot bypass global ownership uniqueness`, async ({
			fixture: f,
		}) => {
			// Arrange: all other unique identifiers differ, so another collision cannot mask the type CHECK.
			await insertOwnership(f);
			const candidate = {
				...ownedRow,
				device_id: "other-device",
				key_id: "c".repeat(64),
				binding_id: "other-binding",
				[column]: new TextEncoder().encode(String(ownedRow[column])),
			};
			// Act
			const attempt = insertOwnership(f, candidate);
			// Assert
			await expect(attempt).rejects.toThrow(/CHECK constraint failed/);
			expect(await rows(f)).toEqual([ownedRow]);
		});
	}
}
function registerCreation(test: OwnershipTest) {
	test("accepts both provenances and multiple different keys for one identity without a group", async ({
		fixture: f,
	}) => {
		// Arrange
		const second = {
			...ownedRow,
			device_id: "second-device",
			key_id: "b".repeat(64),
			binding_id: "binding-b",
			provenance: "reviewed_legacy_migration",
		};
		// Act
		await insertOwnership(f);
		await insertOwnership(f, second);
		// Assert
		expect(await rows(f)).toEqual([ownedRow, second]);
		expect(await f.query(`PRAGMA foreign_key_list(${OWNERSHIP_TABLE})`)).toEqual([]);
	});
}
function registerCollisions(test: OwnershipTest) {
	for (const { name, patch } of collisions) {
		for (const verb of ["INSERT", "INSERT OR REPLACE", "INSERT OR IGNORE"]) {
			test(`${verb} rejects ${name} and preserves the entire original row`, async ({
				fixture: f,
			}) => {
				// Arrange: recursive triggers must not be needed to prevent REPLACE's implicit delete.
				await f.exec("PRAGMA recursive_triggers = OFF");
				await insertOwnership(f);
				// Act
				const attempt = insertOwnership(f, { ...ownedRow, ...patch }, verb);
				// Assert
				await expect(attempt).rejects.toThrow(/device_ownership_collision/);
				expect(await rows(f)).toEqual([ownedRow]);
				expect(await f.query("PRAGMA recursive_triggers")).toEqual([{ recursive_triggers: 0 }]);
			});
		}
	}
}
function registerInvalid(test: OwnershipTest) {
	const invalid: [string, Partial<OwnershipRow>][] = [
		...[
			"",
			"a".repeat(63),
			"a".repeat(65),
			"A".repeat(64),
			"g".repeat(64),
			`${"a".repeat(63)}\n`,
			`${"a".repeat(63)}\0`,
		].map((key_id) => ["invalid key", { key_id }] as [string, Partial<OwnershipRow>]),
		...[
			"device_id",
			"identity_id",
			"coordinator_id",
			"binding_id",
			"source_ref",
			"bound_at",
		].flatMap((column) =>
			["", "   ", null].map(
				(value) => [`${column} blank/null`, { [column]: value }] as [string, Partial<OwnershipRow>],
			),
		),
		...["device_id", "identity_id", "coordinator_id", "binding_id", "source_ref", "bound_at"].map(
			(column) => [`${column} NUL`, { [column]: "a\0b" }] as [string, Partial<OwnershipRow>],
		),
		["unknown provenance", { provenance: "unverified_hint" }],
		["null key", { key_id: null }],
		["null provenance", { provenance: null }],
	];
	for (const [name, patch] of invalid) {
		test(`rejects ${name}: ${JSON.stringify(patch)}`, async ({ fixture: f }) => {
			// Arrange
			const row = { ...ownedRow, ...patch };
			// Act
			const attempt = insertOwnership(f, row);
			// Assert
			await expect(attempt).rejects.toThrow();
			expect(await rows(f)).toEqual([]);
		});
	}
}
function registerMutation(test: OwnershipTest) {
	for (const column of ownershipColumns) {
		test(`rejects updates to ${column}, including no-op updates`, async ({ fixture: f }) => {
			// Arrange
			await insertOwnership(f);
			// Act
			const changed = f.exec(
				`UPDATE ${OWNERSHIP_TABLE} SET ${column} = ?`,
				column === "key_id" ? "b".repeat(64) : "changed",
			);
			// Assert
			await expect(changed).rejects.toThrow(/device_ownership_immutable/);
			await expect(f.exec(`UPDATE ${OWNERSHIP_TABLE} SET ${column} = ${column}`)).rejects.toThrow(
				/device_ownership_immutable/,
			);
			expect(await rows(f)).toEqual([ownedRow]);
		});
	}
	test("rejects DELETE and UPSERT DO UPDATE without releasing ownership", async ({
		fixture: f,
	}) => {
		// Arrange
		await insertOwnership(f);
		// Act
		const deletion = f.exec(`DELETE FROM ${OWNERSHIP_TABLE}`);
		// Assert
		await expect(deletion).rejects.toThrow(/device_ownership_immutable/);
		await expect(
			insertOwnership(
				f,
				ownedRow,
				"INSERT",
				"ON CONFLICT(device_id) DO UPDATE SET identity_id = excluded.identity_id",
			),
		).rejects.toThrow(/device_ownership_collision|device_ownership_immutable/);
		expect(await rows(f)).toEqual([ownedRow]);
	});
}
function registerAliases(test: OwnershipTest) {
	test("canonical comment aliases cannot acquire a second device binding", async ({
		fixture: f,
	}) => {
		// Arrange: reuse the reviewed canonical-key helper; no verifier or network behavior changes.
		const canonical = await ed25519KeyId(CANONICAL_PUBLIC_KEY);
		const alias = await ed25519KeyId(`${CANONICAL_PUBLIC_KEY} fixture-comment`);
		await insertOwnership(f);
		// Act
		const attempt = insertOwnership(f, {
			...ownedRow,
			device_id: "alias-device",
			binding_id: "alias-binding",
			key_id: alias,
		});
		// Assert
		expect(canonical).toBe(EXPECTED_KEY_ID);
		expect(alias).toBe(canonical);
		await expect(attempt).rejects.toThrow(/device_ownership_collision/);
		expect(await rows(f)).toEqual([ownedRow]);
	});
}
function registerLegacy(test: OwnershipTest) {
	test("legacy enrollment creates no binding, and still ignores an existing binding until writer adoption", async ({
		fixture: f,
	}) => {
		// Arrange
		await f.store.createGroup("ownership-group");
		const enrollment = {
			deviceId: "owned-device",
			publicKey: CANONICAL_PUBLIC_KEY,
			fingerprint: "a".repeat(64),
		};
		// Act
		await f.store.enrollDevice("ownership-group", enrollment);
		// Assert: this foundation deliberately is not an ownership authorization gate.
		expect(await rows(f)).toEqual([]);
		await insertOwnership(f);
		await f.store.enrollDevice("ownership-group", {
			...enrollment,
			publicKey: `${CANONICAL_PUBLIC_KEY} another-comment`,
		});
		expect(await rows(f)).toEqual([ownedRow]);
		expect(
			await f.query(
				"SELECT device_id, public_key FROM enrolled_devices WHERE group_id = 'ownership-group'",
			),
		).toEqual([
			{ device_id: "owned-device", public_key: `${CANONICAL_PUBLIC_KEY} another-comment` },
		]);
	});
}
function registerRetention(test: OwnershipTest) {
	test("last enrollment, presence, group cleanup and key/device revocation retain the binding", async ({
		fixture: f,
	}) => {
		// Arrange
		await insertOwnership(f);
		await f.store.createGroup("ownership-group");
		await f.store.enrollDevice("ownership-group", {
			deviceId: "owned-device",
			publicKey: CANONICAL_PUBLIC_KEY,
			fingerprint: "a".repeat(64),
		});
		await f.exec(
			"INSERT INTO presence_records (group_id, device_id, addresses_json, capabilities_json, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
			"ownership-group",
			"owned-device",
			"[]",
			"{}",
			"2026-10-07",
			"2026-10-08",
		);
		// Act
		const revocation = await f.store.createDeviceRevocation({
			groupId: "ownership-group",
			deviceId: "owned-device",
			publicKey: CANONICAL_PUBLIC_KEY,
			fingerprint: "a".repeat(64),
			actorId: "fixture-operator",
		});
		await f.store.removeDevice("ownership-group", "owned-device");
		await f.exec("DELETE FROM groups WHERE group_id = ?", "ownership-group");
		// Assert
		expect(revocation.kind).toBe("revoked");
		expect(await rows(f)).toEqual([ownedRow]);
		expect(await f.query("SELECT * FROM enrolled_devices")).toEqual([]);
		expect(await f.query("SELECT * FROM presence_records")).toEqual([]);
	});
}
