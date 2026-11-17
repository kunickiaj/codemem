import { describe, expect, it } from "vitest";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { ENROLLMENT_REMOVAL_TRIGGERS_SQL } from "./coordinator-device-removal.js";
import { removalDeviceKey } from "./coordinator-device-removal-test-harness.js";
import {
	changeEnrollmentKey,
	clearEnrollmentsAndRemovals,
	d1EnrollmentExec,
	deleteEnrollmentWithoutTombstone,
	removeDeviceWithoutTombstone,
	replaceEnrollment,
	seedEnrollment,
} from "./coordinator-enrollment-test-fixtures.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const TOMBSTONE_SQL = `INSERT INTO coordinator_device_removals(removal_id, group_id, device_id,
	public_key, fingerprint, removed_at) VALUES ('raw', ?, ?, 'removed-key', 'fp', 'then')`;

type Backend = "SQLite" | "D1";
type Triggers = "installed" | "absent";

async function setup(backend: Backend, triggers: Triggers) {
	const f = setupStore(backend);
	if (triggers === "installed") f.db.exec(ENROLLMENT_REMOVAL_TRIGGERS_SQL);
	// The sync path for a better-sqlite3 database, the async path for a D1 database.
	const target = backend === "SQLite" ? f.db : d1EnrollmentExec(sqliteD1(f.db));
	const key = await removalDeviceKey("helper-first");
	for (const groupId of ["g1", "g2"]) {
		await f.store.createGroup(groupId);
		for (const deviceId of ["d1", "d2"])
			await seedEnrollment(target, { groupId, deviceId, publicKey: `opaque ${deviceId}` });
	}
	const rows = (sql: string) => f.db.prepare(sql).all();
	const enrolled = () =>
		rows("SELECT group_id, device_id FROM enrolled_devices ORDER BY group_id, device_id");
	const triggerDefinitions = () =>
		rows("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
	/** What an installed trigger answers to SQL that goes around a helper. */
	const expectRaw = (run: () => unknown, refusal: RegExp) => {
		if (triggers === "installed") expect(run).toThrow(refusal);
		else expect(run).not.toThrow();
	};
	return { ...f, target, key, rows, enrolled, triggerDefinitions, expectRaw };
}

describe.each([
	["SQLite", "installed"],
	["SQLite", "absent"],
	["D1", "installed"],
	["D1", "absent"],
] as const)("%s enrollment test helpers with the enrollment triggers %s", (backend, triggers) => {
	it("deleteEnrollmentWithoutTombstone deletes the named enrollment and records no tombstone", async () => {
		// Arrange
		const f = await setup(backend, triggers);
		const before = f.triggerDefinitions();
		// Act
		await deleteEnrollmentWithoutTombstone(f.target, "group_id = ? AND device_id = ?", "g1", "d1");
		// Assert: the state a removal before 0.50 left, with every trigger as it was.
		expect(f.enrolled()).toEqual([
			{ group_id: "g1", device_id: "d2" },
			{ group_id: "g2", device_id: "d1" },
			{ group_id: "g2", device_id: "d2" },
		]);
		expect(f.rows("SELECT 1 FROM coordinator_device_removals")).toEqual([]);
		expect(f.triggerDefinitions()).toEqual(before);
		f.expectRaw(
			() => f.db.exec("DELETE FROM enrolled_devices"),
			/enrollment_delete_requires_removal/u,
		);
		f.db.close();
	});

	it("removeDeviceWithoutTombstone deletes what removeDevice deleted before 0.50", async () => {
		// Arrange
		const f = await setup(backend, triggers);
		await f.store.upsertPresence({
			groupId: "g1",
			deviceId: "d1",
			addresses: ["http://127.0.0.1:9000"],
			ttlS: 300,
		});
		await f.store.createReciprocalApproval({
			groupId: "g1",
			requestingDeviceId: "d1",
			requestedDeviceId: "d2",
		});
		// Act
		await removeDeviceWithoutTombstone(f.target, "g1", "d1");
		// Assert
		expect(f.enrolled()).toHaveLength(3);
		expect(f.enrolled()).not.toContainEqual({ group_id: "g1", device_id: "d1" });
		expect(f.rows("SELECT 1 FROM presence_records")).toEqual([]);
		expect(f.rows("SELECT 1 FROM coordinator_reciprocal_approvals")).toEqual([]);
		expect(f.rows("SELECT 1 FROM coordinator_device_removals")).toEqual([]);
		f.db.close();
	});

	it("changeEnrollmentKey sets the key text, fingerprint and key ID together", async () => {
		// Arrange: another key, another text form of it, and an opaque key in turn.
		const f = await setup(backend, triggers);
		const recommented = `${f.key.publicKey} another-comment`;
		const stored = () =>
			f.rows(
				"SELECT public_key, fingerprint, key_id FROM enrolled_devices WHERE group_id = 'g1' AND device_id = 'd1'",
			);
		const setKey = f.db.prepare(
			"UPDATE enrolled_devices SET public_key = ? WHERE device_id = 'd1'",
		);
		// Act and assert
		await changeEnrollmentKey(f.target, f.key, "group_id = ? AND device_id = ?", "g1", "d1");
		expect(stored()).toEqual([
			{ public_key: f.key.publicKey, fingerprint: f.key.fingerprint, key_id: f.key.keyId },
		]);
		f.expectRaw(() => setKey.run(recommented), /enrollment_key_id_stale/u);
		await changeEnrollmentKey(f.target, { publicKey: recommented }, "device_id = ?", "d1");
		expect(stored()).toEqual([
			{
				public_key: recommented,
				fingerprint: fingerprintPublicKey(recommented),
				key_id: f.key.keyId,
			},
		]);
		await changeEnrollmentKey(
			f.target,
			{ publicKey: "opaque-key", fingerprint: "stated-fingerprint" },
			"device_id = 'd1'",
		);
		expect(stored()).toEqual([
			{ public_key: "opaque-key", fingerprint: "stated-fingerprint", key_id: "" },
		]);
		await changeEnrollmentKey(
			f.target,
			{ publicKey: f.key.publicKey, fingerprint: null },
			"device_id = 'd1'",
		);
		expect(stored()).toEqual([
			{ public_key: f.key.publicKey, fingerprint: "stated-fingerprint", key_id: f.key.keyId },
		]);
		expect(
			f.rows("SELECT 1 FROM enrolled_devices WHERE device_id = 'd2' AND key_id <> ''"),
		).toEqual([]);
		f.db.close();
	});
});

describe.each([
	["SQLite", "installed"],
	["SQLite", "absent"],
	["D1", "installed"],
	["D1", "absent"],
] as const)("%s enrollment seeds with the enrollment triggers %s", (backend, triggers) => {
	it("seedEnrollment stores the key ID, so the seed passes once a tombstone exists", async () => {
		// Arrange
		const f = await setup(backend, triggers);
		f.db.prepare(TOMBSTONE_SQL).run("g9", "removed-elsewhere");
		const rawSeed = f.db.prepare(
			`INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, enabled, created_at)
			VALUES ('g1', 'raw', 'opaque raw', 'fp', 1, 'then')`,
		);
		// Act
		await seedEnrollment(f.target, {
			groupId: "g1",
			deviceId: "d3",
			publicKey: f.key.publicKey,
			identityId: "identity-a",
			enabled: false,
		});
		// Assert
		expect(
			f.rows(
				"SELECT public_key, fingerprint, key_id, identity_id, enabled FROM enrolled_devices WHERE device_id = 'd3'",
			),
		).toEqual([
			{
				public_key: f.key.publicKey,
				fingerprint: f.key.fingerprint,
				key_id: f.key.keyId,
				identity_id: "identity-a",
				enabled: 0,
			},
		]);
		f.expectRaw(() => rawSeed.run(), /enrollment_key_id_required/u);
		f.db.close();
	});

	it("replaceEnrollment puts the seed in place of the enrollment of that group and device", async () => {
		// Arrange
		const f = await setup(backend, triggers);
		const replace = f.db.prepare(
			`INSERT OR REPLACE INTO enrolled_devices(group_id, device_id, public_key, fingerprint,
				enabled, created_at, key_id) VALUES ('g1', 'd1', 'opaque raw', 'fp', 1, 'then', '')`,
		);
		// Act: once over an existing row, once where the group has none.
		await replaceEnrollment(f.target, {
			groupId: "g1",
			deviceId: "d1",
			publicKey: f.key.publicKey,
		});
		await replaceEnrollment(f.target, { groupId: "g1", deviceId: "d3", publicKey: "opaque d3" });
		// Assert
		expect(
			f.rows(
				"SELECT device_id, public_key, key_id FROM enrolled_devices WHERE group_id = 'g1' ORDER BY device_id",
			),
		).toEqual([
			{ device_id: "d1", public_key: f.key.publicKey, key_id: f.key.keyId },
			{ device_id: "d2", public_key: "opaque d2", key_id: "" },
			{ device_id: "d3", public_key: "opaque d3", key_id: "" },
		]);
		expect(f.rows("SELECT 1 FROM coordinator_device_removals")).toEqual([]);
		f.expectRaw(() => replace.run(), /enrollment_collision/u);
		f.db.close();
	});

	it("clearEnrollmentsAndRemovals clears the named enrollments and every tombstone", async () => {
		// Arrange
		const f = await setup(backend, triggers);
		f.db.prepare(TOMBSTONE_SQL).run("g9", "removed-elsewhere");
		const before = f.triggerDefinitions();
		// Act
		await clearEnrollmentsAndRemovals(f.target, "group_id = ?", "g1");
		// Assert: both tables are guarded again afterwards.
		expect(f.enrolled()).toEqual([
			{ group_id: "g2", device_id: "d1" },
			{ group_id: "g2", device_id: "d2" },
		]);
		expect(f.rows("SELECT 1 FROM coordinator_device_removals")).toEqual([]);
		expect(f.triggerDefinitions()).toEqual(before);
		f.db.prepare(TOMBSTONE_SQL).run("g9", "removed-again");
		expect(() => f.db.exec("DELETE FROM coordinator_device_removals")).toThrow(
			/device_removal_immutable/u,
		);
		f.db.close();
	});
});

it("clearEnrollmentsAndRemovals clears the enrollments of a database from before the tombstone table", async () => {
	// Arrange
	const f = setupStore("D1");
	const target = d1EnrollmentExec(sqliteD1(f.db));
	await f.store.createGroup("g1");
	await seedEnrollment(target, { groupId: "g1", deviceId: "d1", publicKey: "opaque d1" });
	f.db.exec("DROP TABLE coordinator_device_removals");
	// Act
	await clearEnrollmentsAndRemovals(target);
	// Assert
	expect(f.db.prepare("SELECT 1 FROM enrolled_devices").all()).toEqual([]);
	f.db.close();
});
