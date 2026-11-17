import { expect, it } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import { ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS } from "./coordinator-device-removal.js";
import type { RevocationFixture } from "./coordinator-device-revocation-test-harness.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/**
 * Numbers in test names are the entries of group A in the removal test plan.
 * Every fixture installs ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS itself, because
 * schema initialization and migration 0048 do not install them yet, and starts
 * with no tombstone and no enrollment.
 */
export type RemovalFixture = {
	store: Store;
	/** Unique for each test. */
	prefix: string;
	/** Raw SQL write. Rejects when a trigger or constraint aborts the statement. */
	exec: (sql: string, ...values: unknown[]) => Promise<void>;
	rows: <T = Record<string, unknown>>(sql: string, ...values: unknown[]) => Promise<T[]>;
	/**
	 * A store on the same database that runs `change` once, immediately before
	 * its first write whose SQL contains one of `before`. On D1 that is before
	 * the batch that holds the write, so after every read the operation made first.
	 */
	interleave: (before: readonly string[], change: readonly RawStatement[]) => Store;
};

export type RawStatement = { sql: string; values: unknown[] };

/** The injected store clock of every fixture. */
export const REMOVAL_CLOCK_MS = Date.UTC(2026, 10, 17, 12, 0, 0);

export function removalHarness(
	fixture: (use: (f: RemovalFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: RemovalFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
export type RemovalTest = ReturnType<typeof removalHarness>;

export type DeviceKey = { publicKey: string; fingerprint: string; keyId: string };

/** A well-formed SSH Ed25519 public key derived from a label. No private key exists for it. */
export async function removalDeviceKey(label: string): Promise<DeviceKey> {
	const wire = new Uint8Array(51);
	const view = new DataView(wire.buffer);
	view.setUint32(0, 11);
	wire.set(new TextEncoder().encode("ssh-ed25519"), 4);
	view.setUint32(15, 32);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(label));
	wire.set(new Uint8Array(digest), 19);
	const publicKey = `ssh-ed25519 ${btoa(String.fromCharCode(...wire))}`;
	const keyId = await ed25519KeyIdForRevocation(publicKey);
	if (!keyId) throw new Error("fixture key is not canonical");
	return { publicKey, fingerprint: fingerprintPublicKey(publicKey), keyId };
}

export function opaqueKey(label: string): DeviceKey {
	const publicKey = `opaque-fixture-key ${label}`;
	return { publicKey, fingerprint: fingerprintPublicKey(publicKey), keyId: "" };
}

export type Enrollment = { groupId: string; deviceId: string; key: DeviceKey };

export async function enroll(f: RemovalFixture, target: Enrollment): Promise<void> {
	if (!(await f.store.getGroup(target.groupId))) await f.store.createGroup(target.groupId);
	await f.store.enrollDevice(target.groupId, {
		deviceId: target.deviceId,
		publicKey: target.key.publicKey,
		fingerprint: target.key.fingerprint,
	});
}

/** The enrollment insert of releases before the key ID column existed. */
export function legacyInsert(f: RemovalFixture, target: Enrollment): Promise<void> {
	return f.exec(
		`INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, enabled, created_at)
		VALUES (?, ?, ?, ?, 1, '2026-11-17T00:00:00.000Z')`,
		target.groupId,
		target.deviceId,
		target.key.publicKey,
		target.key.fingerprint,
	);
}

export function currentInsert(
	f: RemovalFixture,
	target: Enrollment,
	verb = "INSERT",
): Promise<void> {
	return f.exec(
		`${verb} INTO enrolled_devices(group_id, device_id, public_key, fingerprint, enabled, created_at, key_id)
		VALUES (?, ?, ?, ?, 1, '2026-11-17T00:00:00.000Z', ?)`,
		target.groupId,
		target.deviceId,
		target.key.publicKey,
		target.key.fingerprint,
		target.key.keyId,
	);
}

export function insertTombstone(
	f: RemovalFixture,
	target: Enrollment,
	verb = "INSERT",
): Promise<void> {
	return f.exec(
		`${verb} INTO coordinator_device_removals(removal_id, group_id, device_id, public_key,
			fingerprint, key_id, removed_at)
		VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), '2026-11-17T00:00:00.000Z')`,
		`${f.prefix}-raw-removal`,
		target.groupId,
		target.deviceId,
		target.key.publicKey,
		target.key.fingerprint,
		target.key.keyId,
	);
}

function liftTombstones(f: RemovalFixture, deviceId: string): Promise<void> {
	return f.exec(
		`UPDATE coordinator_device_removals SET lifted_at = '2026-11-17T01:00:00.000Z',
			lifted_by_invite_id = 'fixture-invite' WHERE device_id = ? AND lifted_at IS NULL`,
		deviceId,
	);
}

/**
 * The state a removal before 0.50 left: the enrollment is gone and no tombstone
 * records it. Only the delete trigger is dropped and re-created around the delete.
 */
export function deleteEnrollmentWithoutTombstone(target: Enrollment): RawStatement[] {
	const trigger = ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS.find((sql) =>
		sql.includes("enrolled_devices_removal_delete"),
	);
	if (!trigger) throw new Error("Missing enrollment delete trigger");
	return [
		{ sql: "DROP TRIGGER IF EXISTS enrolled_devices_removal_delete", values: [] },
		{
			sql: "DELETE FROM enrolled_devices WHERE group_id = ? AND device_id = ?",
			values: [target.groupId, target.deviceId],
		},
		{ sql: trigger, values: [] },
	];
}

/** Marks an enrollment that a test arranged, in a column that every writer sets. */
export const ARRANGED_DISPLAY_NAME = "arranged by the test";
/** The creation time of every arranged enrollment. A writer's insert never uses it. */
export const ARRANGED_CREATED_AT = "2026-11-17T00:00:00.000Z";

/** A disabled enrollment with no Identity, as another writer could add it at any moment. */
export function insertDisabledEnrollment(target: Enrollment): RawStatement[] {
	return [
		{
			sql: `INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint,
				display_name, enabled, created_at, key_id)
				VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
			values: [
				target.groupId,
				target.deviceId,
				target.key.publicKey,
				target.key.fingerprint,
				ARRANGED_DISPLAY_NAME,
				ARRANGED_CREATED_AT,
				target.key.keyId,
			],
		},
	];
}

type Tombstone = {
	removal_seq: number;
	removal_id: string;
	group_id: string;
	device_id: string;
	public_key: string;
	fingerprint: string;
	key_id: string | null;
	actor_id: string | null;
	removed_at: string;
	lifted_at: string | null;
	lifted_by_invite_id: string | null;
	lifted_by_attempt_id: string | null;
};

function tombstones(f: RemovalFixture): Promise<Tombstone[]> {
	return f.rows<Tombstone>(
		"SELECT * FROM coordinator_device_removals WHERE device_id LIKE ? ORDER BY removal_seq",
		`${f.prefix}%`,
	);
}

export function enrollments(f: RemovalFixture) {
	return f.rows<{ group_id: string; device_id: string; public_key: string; key_id: string | null }>(
		`SELECT group_id, device_id, public_key, key_id FROM enrolled_devices
		WHERE device_id LIKE ? ORDER BY group_id, device_id`,
		`${f.prefix}%`,
	);
}

export async function target(f: RemovalFixture, name = "d", group = "g1"): Promise<Enrollment> {
	return {
		groupId: `${f.prefix}-${group}`,
		deviceId: `${f.prefix}-${name}`,
		key: await removalDeviceKey(`${f.prefix}-${name}`),
	};
}

export function registerDeviceRemovalContract(test: RemovalTest) {
	registerLegacyInsertShape(test);
	registerTombstoneRules(test);
	registerTombstoneSequence(test);
	registerSingleGroupRemoval(test);
	registerSuppressedRemovalWrites(test);
	registerRemovalAvailability(test);
	registerInvitationSequence(test);
	registerKeyIdStorage(test);
	registerTombstoneMatchTriggers(test);
	registerEnrollmentChangeTriggers(test);
	registerEnableWithoutKeyId(test);
	registerRowIdRule(test);
	registerEnrollmentMoveTriggers(test);
	registerCollisionTriggers(test);
	registerExistingEnrollmentWriters(test);
	registerInvitationWriters(test);
}

function registerLegacyInsertShape(test: RemovalTest) {
	test("A18 the pre-0.50 enrollment insert succeeds before any tombstone and aborts after one exists", async ({
		fixture: f,
	}) => {
		// Arrange
		const before = await target(f, "before");
		const removed = await target(f, "removed");
		const after = await target(f, "after");
		await f.store.createGroup(before.groupId);
		expect(await f.rows("SELECT 1 FROM coordinator_device_removals")).toEqual([]);
		// Act
		await legacyInsert(f, before);
		await insertTombstone(f, removed);
		await liftTombstones(f, removed.deviceId);
		const pending = legacyInsert(f, after);
		// Assert: a lifted tombstone still requires every later insert to state its key ID.
		await expect(pending).rejects.toThrow(/enrollment_key_id_required/u);
		expect(await enrollments(f)).toEqual([
			{
				group_id: before.groupId,
				device_id: before.deviceId,
				public_key: before.key.publicKey,
				key_id: null,
			},
		]);
	});
}

function registerTombstoneSequence(test: RemovalTest) {
	test("A9 a tombstone cannot take a removal sequence below 1", async ({ fixture: f }) => {
		// Arrange
		const removed = await target(f);
		const later = await target(f, "later");
		const insert = `INSERT INTO coordinator_device_removals(removal_seq, removal_id, group_id,
			device_id, public_key, fingerprint, removed_at) VALUES (?, 'raw', ?, ?, 'k', 'f', 'now')`;
		// Act and assert: an automatic sequence reads as -1 before insert and must match no row.
		for (const seq of [-1, 0]) {
			await expect(f.exec(insert, seq, removed.groupId, removed.deviceId)).rejects.toThrow(
				/device_removal_rowid/u,
			);
		}
		await insertTombstone(f, removed);
		await insertTombstone(f, later);
		// Assert
		const recorded = await tombstones(f);
		expect(recorded.map((row) => row.device_id)).toEqual([removed.deviceId, later.deviceId]);
		expect(recorded.every((row) => row.removal_seq >= 1)).toBe(true);
	});
}

function registerTombstoneRules(test: RemovalTest) {
	test("A9 a tombstone rejects delete and every update except its single lift", async ({
		fixture: f,
	}) => {
		// Arrange
		const byInvite = await target(f, "invite");
		const byAttempt = await target(f, "attempt");
		await insertTombstone(f, byInvite);
		await insertTombstone(f, byAttempt);
		const lift = "UPDATE coordinator_device_removals SET lifted_at = 'now'";
		// Act and assert: every other change aborts.
		for (const sql of [
			"DELETE FROM coordinator_device_removals WHERE device_id = ?",
			"UPDATE coordinator_device_removals SET group_id = 'moved' WHERE device_id = ?",
			"UPDATE coordinator_device_removals SET removal_seq = removal_seq + 1000 WHERE device_id = ?",
			`${lift} WHERE device_id = ?`,
			`${lift}, lifted_by_invite_id = 'i', lifted_by_attempt_id = 'a' WHERE device_id = ?`,
			"UPDATE coordinator_device_removals SET lifted_by_invite_id = 'i' WHERE device_id = ?",
			`${lift}, lifted_by_invite_id = 'i', actor_id = 'forged' WHERE device_id = ?`,
		]) {
			await expect(f.exec(sql, byInvite.deviceId)).rejects.toThrow(/device_removal_immutable/u);
		}
		// Act: the two lifts.
		await f.exec(`${lift}, lifted_by_invite_id = 'i' WHERE device_id = ?`, byInvite.deviceId);
		await f.exec(`${lift}, lifted_by_attempt_id = 'a' WHERE device_id = ?`, byAttempt.deviceId);
		// Assert: a lifted row accepts no second lift and no delete.
		await expect(
			f.exec(`${lift}, lifted_by_invite_id = 'again' WHERE device_id = ?`, byInvite.deviceId),
		).rejects.toThrow(/device_removal_immutable/u);
		await expect(
			f.exec("DELETE FROM coordinator_device_removals WHERE device_id = ?", byAttempt.deviceId),
		).rejects.toThrow(/device_removal_immutable/u);
		expect(await tombstones(f)).toMatchObject([
			{ device_id: byInvite.deviceId, lifted_by_invite_id: "i", lifted_by_attempt_id: null },
			{ device_id: byAttempt.deviceId, lifted_by_invite_id: null, lifted_by_attempt_id: "a" },
		]);
	});

	test("A10 a second active tombstone for the same group and device ID is rejected", async ({
		fixture: f,
	}) => {
		// Arrange
		const removed = await target(f);
		await insertTombstone(f, removed);
		const [first] = await tombstones(f);
		// Act and assert: neither a plain insert nor a replacing insert adds or erases one.
		await expect(insertTombstone(f, removed)).rejects.toThrow(/device_removal_collision/u);
		await expect(insertTombstone(f, removed, "INSERT OR REPLACE")).rejects.toThrow(
			/device_removal_collision/u,
		);
		expect(await tombstones(f)).toEqual([first]);
		// Act: a lifted tombstone no longer blocks a new one.
		await liftTombstones(f, removed.deviceId);
		await insertTombstone(f, removed);
		// Assert
		expect(await tombstones(f)).toMatchObject([
			{ removal_seq: first?.removal_seq, lifted_by_invite_id: "fixture-invite" },
			{ lifted_at: null },
		]);
	});
}

function registerSuppressedRemovalWrites(test: RemovalTest) {
	// A trigger that makes one write of the removal change no row without an error.
	const suppressed = {
		"tombstone insert": "BEFORE INSERT ON coordinator_device_removals",
		"enrollment delete": "BEFORE DELETE ON enrolled_devices",
		"presence delete": "BEFORE DELETE ON presence_records",
		"reciprocal approval delete": "BEFORE DELETE ON coordinator_reciprocal_approvals",
	} as const;
	for (const [write, event] of Object.entries(suppressed)) {
		test(`A11 a removal whose ${write} a trigger suppresses records no tombstone and deletes nothing`, async ({
			fixture: f,
		}) => {
			// Arrange
			const removed = await target(f);
			const peer = await target(f, "peer");
			await enroll(f, removed);
			await enroll(f, peer);
			await f.store.upsertPresence({
				groupId: removed.groupId,
				deviceId: removed.deviceId,
				addresses: ["http://127.0.0.1:9000"],
				ttlS: 300,
			});
			await f.store.createReciprocalApproval({
				groupId: removed.groupId,
				requestingDeviceId: removed.deviceId,
				requestedDeviceId: peer.deviceId,
			});
			const dependent = () =>
				Promise.all([
					enrollments(f),
					f.rows("SELECT device_id FROM presence_records WHERE device_id = ?", removed.deviceId),
					f.rows(
						"SELECT request_id FROM coordinator_reciprocal_approvals WHERE requesting_device_id = ?",
						removed.deviceId,
					),
				]);
			const before = await dependent();
			await f.exec(`CREATE TRIGGER removal_fixture_ignore_write ${event}
				BEGIN SELECT RAISE(IGNORE); END`);
			try {
				// Act
				const pending = f.store.removeEnrollment({
					groupId: removed.groupId,
					deviceId: removed.deviceId,
				});
				// Assert: neither a tombstone without its deletes nor a delete without its tombstone.
				await expect(pending).rejects.toThrow("device_removal_incomplete");
				expect(await tombstones(f)).toEqual([]);
				expect(await dependent()).toEqual(before);
				expect(before.map((rows) => rows.length)).toEqual([2, 1, 1]);
			} finally {
				await f.exec("DROP TRIGGER IF EXISTS removal_fixture_ignore_write");
			}
		});
	}
}

function registerSingleGroupRemoval(test: RemovalTest) {
	test("A11 A20 the single-group removal writes a tombstone before its delete, and a plain delete aborts", async ({
		fixture: f,
	}) => {
		// Arrange
		const removed = await target(f);
		const kept = { ...removed, groupId: `${f.prefix}-g2` };
		await enroll(f, removed);
		await enroll(f, kept);
		await f.store.upsertPresence({
			groupId: removed.groupId,
			deviceId: removed.deviceId,
			addresses: ["http://127.0.0.1:9000"],
			ttlS: 300,
		});
		// Act
		const plainDelete = f.exec(
			"DELETE FROM enrolled_devices WHERE device_id = ?",
			removed.deviceId,
		);
		await expect(plainDelete).rejects.toThrow(/enrollment_delete_requires_removal/u);
		const result = await f.store.removeEnrollment({
			groupId: removed.groupId,
			deviceId: removed.deviceId,
			actorId: "fixture-operator",
		});
		const missing = await f.store.removeEnrollment({
			groupId: removed.groupId,
			deviceId: `${f.prefix}-ghost`,
		});
		// Assert: one tombstone with the exact tuple; the other group is untouched.
		expect(missing).toEqual({ kind: "not_enrolled" });
		const recorded = await tombstones(f);
		expect(recorded).toHaveLength(1);
		expect(result).toEqual({
			kind: "removed",
			removal_id: recorded[0]?.removal_id,
			removals: [
				{
					removal_seq: recorded[0]?.removal_seq,
					group_id: removed.groupId,
					device_id: removed.deviceId,
				},
			],
		});
		expect(recorded[0]).toMatchObject({
			group_id: removed.groupId,
			device_id: removed.deviceId,
			public_key: removed.key.publicKey,
			fingerprint: removed.key.fingerprint,
			key_id: removed.key.keyId,
			actor_id: "fixture-operator",
			removed_at: new Date(REMOVAL_CLOCK_MS).toISOString(),
			lifted_at: null,
		});
		expect(recorded[0]?.removal_id).toMatch(/^[0-9a-f-]{36}$/u);
		expect(await enrollments(f)).toMatchObject([{ group_id: kept.groupId }]);
		expect(
			await f.rows("SELECT 1 FROM presence_records WHERE device_id = ?", removed.deviceId),
		).toEqual([]);
	});
}

function registerRemovalAvailability(test: RemovalTest) {
	test("A16 the single-group removal is unavailable while any enrollment has no key ID", async ({
		fixture: f,
	}) => {
		// Arrange: another enrollment as an older release wrote it before any tombstone existed.
		const removed = await target(f);
		const unfilled = await target(f, "unfilled");
		await enroll(f, removed);
		await legacyInsert(f, unfilled);
		// Act
		const removal = { groupId: removed.groupId, deviceId: removed.deviceId };
		const pending = f.store.removeEnrollment(removal);
		// Assert
		await expect(pending).rejects.toThrow("device_removal_unavailable");
		expect(await tombstones(f)).toEqual([]);
		expect(await enrollments(f)).toHaveLength(2);
		// Act: filling the key IDs makes the removal available.
		expect(await f.store.fillEnrollmentKeyIds()).toEqual({ filled: 1, remaining: false });
		expect(await f.store.removeEnrollment(removal)).toMatchObject({ kind: "removed" });
	});
}

async function highestRemovalSeq(f: RemovalFixture): Promise<number> {
	const rows = await f.rows<{ seq: number }>(
		"SELECT COALESCE(MAX(removal_seq), 0) AS seq FROM coordinator_device_removals",
	);
	return rows[0]?.seq ?? -1;
}

async function inviteRemovalSeq(f: RemovalFixture, inviteId: string) {
	const rows = await f.rows<{ seq: number | null }>(
		"SELECT issued_after_removal_seq AS seq FROM coordinator_invites WHERE invite_id = ?",
		inviteId,
	);
	return rows[0]?.seq;
}

function registerInvitationSequence(test: RemovalTest) {
	test("A12 a new invitation records the highest removal sequence and an older row reads null", async ({
		fixture: f,
	}) => {
		// Arrange
		const removed = await target(f);
		await f.store.createGroup(removed.groupId);
		const expiresAt = "2099-01-01T00:00:00.000Z";
		const startSeq = await highestRemovalSeq(f);
		// Act
		const first = await f.store.createInvite({
			groupId: removed.groupId,
			policy: "auto_admit",
			expiresAt,
		});
		await insertTombstone(f, removed);
		const second = await f.store.createInvite({
			groupId: removed.groupId,
			policy: "approval_required",
			expiresAt,
		});
		await f.exec(
			`INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at)
			VALUES (?, ?, ?, 'auto_admit', ?, '2026-01-01T00:00:00.000Z')`,
			`${f.prefix}-old-invite`,
			removed.groupId,
			`${f.prefix}-old-token`,
			expiresAt,
		);
		const request = await f.store.createJoinRequest({
			groupId: removed.groupId,
			deviceId: `${f.prefix}-joiner`,
			publicKey: "joiner-key",
			fingerprint: "joiner-fingerprint",
			token: second.token,
		});
		const oldRequest = await f.store.createJoinRequest({
			groupId: removed.groupId,
			deviceId: `${f.prefix}-old-joiner`,
			publicKey: "old-joiner-key",
			fingerprint: "old-joiner-fingerprint",
			token: `${f.prefix}-old-token`,
		});
		// Assert
		const endSeq = await highestRemovalSeq(f);
		expect(endSeq).toBeGreaterThan(startSeq);
		expect(await inviteRemovalSeq(f, first.invite_id)).toBe(startSeq);
		expect(await inviteRemovalSeq(f, second.invite_id)).toBe(endSeq);
		expect(await inviteRemovalSeq(f, `${f.prefix}-old-invite`)).toBeNull();
		expect(
			await f.rows(
				`SELECT request_id, issued_after_removal_seq AS seq FROM coordinator_join_requests
				WHERE group_id = ? ORDER BY created_at, device_id`,
				removed.groupId,
			),
		).toEqual(
			expect.arrayContaining([
				{ request_id: request.request_id, seq: endSeq },
				{ request_id: oldRequest.request_id, seq: null },
			]),
		);
	});
}

function registerKeyIdStorage(test: RemovalTest) {
	test("A13 enrollment writers store the key ID, and filling covers rows that lack one", async ({
		fixture: f,
	}) => {
		// Arrange
		const admin = await target(f, "admin");
		const opaque = { ...(await target(f, "opaque")), key: opaqueKey(`${f.prefix}-opaque`) };
		const joined = await target(f, "joined");
		const expiresAt = "2099-01-01T00:00:00.000Z";
		// Act: admin enrollment with both key kinds, then a join approval.
		await enroll(f, admin);
		await enroll(f, opaque);
		const invite = await f.store.createInvite({
			groupId: admin.groupId,
			policy: "approval_required",
			expiresAt,
		});
		const request = await f.store.createJoinRequest({
			groupId: joined.groupId,
			deviceId: joined.deviceId,
			publicKey: joined.key.publicKey,
			fingerprint: joined.key.fingerprint,
			token: invite.token,
		});
		await f.store.reviewJoinRequest({ requestId: request.request_id, approved: true });
		// Assert
		expect(await enrollments(f)).toEqual([
			{
				group_id: admin.groupId,
				device_id: admin.deviceId,
				public_key: admin.key.publicKey,
				key_id: admin.key.keyId,
			},
			{
				group_id: joined.groupId,
				device_id: joined.deviceId,
				public_key: joined.key.publicKey,
				key_id: joined.key.keyId,
			},
			{
				group_id: opaque.groupId,
				device_id: opaque.deviceId,
				public_key: opaque.key.publicKey,
				key_id: "",
			},
		]);
		// Arrange: rows as the migration leaves them, with no key ID.
		await f.exec(
			"UPDATE enrolled_devices SET key_id = NULL WHERE device_id LIKE ?",
			`${f.prefix}%`,
		);
		// Act
		const one = await f.store.fillEnrollmentKeyIds({ limit: 1 });
		const rest = await f.store.fillEnrollmentKeyIds();
		const none = await f.store.fillEnrollmentKeyIds();
		// Assert
		expect(one).toEqual({ filled: 1, remaining: true });
		expect(rest.remaining).toBe(false);
		expect(none).toEqual({ filled: 0, remaining: false });
		expect((await enrollments(f)).map((row) => row.key_id)).toEqual([
			admin.key.keyId,
			joined.key.keyId,
			"",
		]);
	});
}

function registerTombstoneMatchTriggers(test: RemovalTest) {
	test("A19 an insert of a removed device ID or key aborts while the tombstone is active and succeeds after a lift", async ({
		fixture: f,
	}) => {
		// Arrange: the same device ID under another key, and the same key under another ID.
		const removed = await target(f);
		const sameId = { ...removed, key: await removalDeviceKey(`${f.prefix}-new-key`) };
		const sameKey = { ...removed, deviceId: `${f.prefix}-alias`, groupId: `${f.prefix}-g2` };
		const recommented = {
			...sameKey,
			key: { ...removed.key, publicKey: `${removed.key.publicKey} comment` },
		};
		await f.store.createGroup(removed.groupId);
		await insertTombstone(f, removed);
		// Act and assert
		for (const blocked of [removed, sameId, sameKey, recommented]) {
			await expect(currentInsert(f, blocked)).rejects.toThrow(/device_removed/u);
		}
		expect(await enrollments(f)).toEqual([]);
		// Act
		await liftTombstones(f, removed.deviceId);
		await currentInsert(f, sameId);
		await currentInsert(f, recommented);
		// Assert
		expect(await enrollments(f)).toHaveLength(2);
	});

	test("A25 an insert of an opaque key whose text equals an active tombstone's key aborts", async ({
		fixture: f,
	}) => {
		// Arrange
		const removed = { ...(await target(f)), key: opaqueKey(f.prefix) };
		const sameText = { ...removed, deviceId: `${f.prefix}-alias` };
		const otherText = { ...sameText, key: opaqueKey(`${f.prefix}-other`) };
		await insertTombstone(f, removed);
		// Act
		const pending = currentInsert(f, sameText);
		// Assert: an opaque tombstone has no key ID, so only the exact text matches.
		await expect(pending).rejects.toThrow(/device_removed/u);
		expect((await tombstones(f))[0]?.key_id).toBeNull();
		await currentInsert(f, otherText);
		expect(await enrollments(f)).toMatchObject([{ public_key: otherText.key.publicKey }]);
	});

	test("A21 enabling an enrollment aborts when an active tombstone of the same group matches it", async ({
		fixture: f,
	}) => {
		// Arrange: two device IDs share a key in two groups; one ID is removed from group 1.
		const removed = await target(f);
		const alias = { ...removed, deviceId: `${f.prefix}-alias` };
		const aliasElsewhere = { ...alias, groupId: `${f.prefix}-g2` };
		for (const enrollment of [removed, alias, aliasElsewhere]) await currentInsert(f, enrollment);
		await f.exec("UPDATE enrolled_devices SET enabled = 0 WHERE device_id = ?", alias.deviceId);
		await insertTombstone(f, removed);
		const enable = "UPDATE enrolled_devices SET enabled = 1 WHERE group_id = ? AND device_id = ?";
		// Act
		const sameGroup = f.exec(enable, alias.groupId, alias.deviceId);
		// Assert
		await expect(sameGroup).rejects.toThrow(/device_removed/u);
		await f.exec(enable, aliasElsewhere.groupId, aliasElsewhere.deviceId);
		expect(
			await f.rows(
				"SELECT group_id, enabled FROM enrolled_devices WHERE device_id = ? ORDER BY group_id",
				alias.deviceId,
			),
		).toEqual([
			{ group_id: alias.groupId, enabled: 0 },
			{ group_id: aliasElsewhere.groupId, enabled: 1 },
		]);
	});
}

function registerEnableWithoutKeyId(test: RemovalTest) {
	test("A21 enabling an enrollment that has no key ID aborts once a tombstone exists", async ({
		fixture: f,
	}) => {
		// Arrange: two disabled rows from before the key ID column. One shares the removed key.
		const removed = { ...(await target(f)), key: opaqueKey(`${f.prefix}-removed`) };
		const alias = { ...removed, deviceId: `${f.prefix}-alias` };
		const other = { ...(await target(f, "other")), key: opaqueKey(`${f.prefix}-other`) };
		await f.store.createGroup(removed.groupId);
		for (const enrollment of [alias, other]) await legacyInsert(f, enrollment);
		await f.exec("UPDATE enrolled_devices SET enabled = 0 WHERE device_id LIKE ?", `${f.prefix}%`);
		await insertTombstone(f, removed);
		const enable = "UPDATE enrolled_devices SET enabled = 1 WHERE device_id = ?";
		const enableWithKeyId =
			"UPDATE enrolled_devices SET enabled = 1, key_id = ? WHERE device_id = ?";
		// Act and assert: a null key ID cannot be compared with a tombstone, so neither row is enabled.
		for (const enrollment of [alias, other]) {
			await expect(f.exec(enable, enrollment.deviceId)).rejects.toThrow(
				/enrollment_key_id_required/u,
			);
		}
		// Act and assert: with the key ID stated, the removed key is refused and the other is enabled.
		await expect(f.exec(enableWithKeyId, alias.key.keyId, alias.deviceId)).rejects.toThrow(
			/device_removed/u,
		);
		await f.exec(enableWithKeyId, other.key.keyId, other.deviceId);
		expect(
			await f.rows(
				"SELECT device_id, enabled, key_id FROM enrolled_devices WHERE device_id LIKE ? ORDER BY device_id",
				`${f.prefix}%`,
			),
		).toEqual([
			{ device_id: alias.deviceId, enabled: 0, key_id: null },
			{ device_id: other.deviceId, enabled: 1, key_id: "" },
		]);
	});
}

function registerRowIdRule(test: RemovalTest) {
	test("A24 an enrollment cannot take a row ID below 1 by insert or by update", async ({
		fixture: f,
	}) => {
		// Arrange
		const first = await target(f, "first");
		const second = await target(f, "second");
		await currentInsert(f, first);
		const insert = `INSERT INTO enrolled_devices(rowid, group_id, device_id, public_key,
			fingerprint, enabled, created_at, key_id) VALUES (?, ?, ?, 'k', 'f', 1, 'now', '')`;
		// Act and assert: an automatic row ID reads as -1 before insert and must match no row.
		for (const rowId of [-1, 0]) {
			await expect(f.exec(insert, rowId, first.groupId, `${f.prefix}-raw`)).rejects.toThrow(
				/enrollment_rowid/u,
			);
			for (const name of ["rowid", "_rowid_", "oid"]) {
				await expect(
					f.exec(
						`UPDATE enrolled_devices SET ${name} = ? WHERE device_id = ?`,
						rowId,
						first.deviceId,
					),
				).rejects.toThrow(/enrollment_rowid/u);
			}
		}
		// Assert: a later insert with an automatic row ID still succeeds.
		await currentInsert(f, second);
		const rows = await f.rows<{ row_id: number; device_id: string }>(
			"SELECT rowid AS row_id, device_id FROM enrolled_devices WHERE device_id LIKE ? ORDER BY rowid",
			`${f.prefix}%`,
		);
		expect(rows.map((row) => row.device_id)).toEqual([first.deviceId, second.deviceId]);
		expect(rows.every((row) => row.row_id >= 1)).toBe(true);
	});
}

function registerEnrollmentChangeTriggers(test: RemovalTest) {
	test("A22 an update that changes an Ed25519 key and leaves the key ID unchanged aborts", async ({
		fixture: f,
	}) => {
		// Arrange
		const enrolled = await target(f);
		const next = await removalDeviceKey(`${f.prefix}-next`);
		await currentInsert(f, enrolled);
		const setKey = "UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?";
		const setBoth = "UPDATE enrolled_devices SET public_key = ?, key_id = ? WHERE device_id = ?";
		// Act and assert: a new key without its ID, and the same key in another text form.
		await expect(f.exec(setKey, next.publicKey, enrolled.deviceId)).rejects.toThrow(
			/enrollment_key_id_stale/u,
		);
		await expect(
			f.exec(setBoth, `${enrolled.key.publicKey} comment`, enrolled.key.keyId, enrolled.deviceId),
		).rejects.toThrow(/enrollment_key_id_stale/u);
		// Act: the key and its ID together.
		await f.exec(setBoth, next.publicKey, next.keyId, enrolled.deviceId);
		// Assert
		expect(await enrollments(f)).toMatchObject([
			{ public_key: next.publicKey, key_id: next.keyId },
		]);
	});

	test("A22 an opaque key may change its text, but not to a text the key parser reads as Ed25519", async ({
		fixture: f,
	}) => {
		// Arrange: an opaque key has no key ID that could go stale.
		const enrolled = { ...(await target(f)), key: opaqueKey(`${f.prefix}-first`) };
		await currentInsert(f, enrolled);
		const setKey = "UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?";
		const opaque = [
			opaqueKey(`${f.prefix}-second`).publicKey,
			"SSH-ED25519 AAAA",
			"ssh-ed25519-cert-v01@openssh.com AAAA",
			"ssh-ed25519x",
		];
		// Act: the parser takes only the exact, case-sensitive first token for Ed25519.
		for (const text of opaque) await f.exec(setKey, text, enrolled.deviceId);
		// Assert: leading space of any kind does not hide that token.
		for (const text of [
			"ssh-ed25519 not-a-key",
			"\u00a0\t ssh-ed25519\tAAAA",
			"ssh-ed25519\u3000AAAA",
			"ssh-ed25519",
		]) {
			await expect(f.exec(setKey, text, enrolled.deviceId)).rejects.toThrow(
				/enrollment_key_id_stale/u,
			);
		}
		expect(await enrollments(f)).toMatchObject([{ public_key: opaque.at(-1), key_id: "" }]);
	});
}

function registerEnrollmentMoveTriggers(test: RemovalTest) {
	test("A19 a tombstone elsewhere stops a real change of an enrollment and not a restatement", async ({
		fixture: f,
	}) => {
		// Arrange: the device is removed from group 1 and stays enrolled in group 2.
		const removed = await target(f);
		const survivor = { ...removed, groupId: `${f.prefix}-g2` };
		const next = await removalDeviceKey(`${f.prefix}-next`);
		await enroll(f, removed);
		await enroll(f, survivor);
		await f.store.removeEnrollment({ groupId: removed.groupId, deviceId: removed.deviceId });
		const before = await enrollments(f);
		// Act: writers that name the checked columns without changing them.
		await enroll(f, survivor);
		await f.exec(
			`UPDATE enrolled_devices SET group_id = group_id, device_id = device_id,
				public_key = public_key, key_id = key_id WHERE device_id = ?`,
			survivor.deviceId,
		);
		const rotated = f.exec(
			"UPDATE enrolled_devices SET public_key = ?, key_id = ? WHERE device_id = ?",
			next.publicKey,
			next.keyId,
			survivor.deviceId,
		);
		// Assert: a new key for the removed device ID is a real change.
		await expect(rotated).rejects.toThrow(/device_removed/u);
		expect(await enrollments(f)).toEqual(before);
	});

	test("A25 an update to an opaque key whose text equals an active tombstone's key aborts", async ({
		fixture: f,
	}) => {
		// Arrange: both keys are opaque, so both rows carry an empty key ID.
		const removed = { ...(await target(f)), key: opaqueKey(`${f.prefix}-removed`) };
		const other = { ...(await target(f, "other")), key: opaqueKey(`${f.prefix}-other`) };
		await currentInsert(f, other);
		await insertTombstone(f, removed);
		// Act
		const pending = f.exec(
			"UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?",
			removed.key.publicKey,
			other.deviceId,
		);
		// Assert: the stale-key rule lets the opaque change through, and the text match stops it.
		await expect(pending).rejects.toThrow(/device_removed/u);
		expect(await enrollments(f)).toMatchObject([{ public_key: other.key.publicKey }]);
	});

	test("A23 after a single-group removal, moving the surviving enrollment into that group aborts", async ({
		fixture: f,
	}) => {
		// Arrange
		const removed = await target(f);
		const survivor = { ...removed, groupId: `${f.prefix}-g2` };
		await enroll(f, removed);
		await enroll(f, survivor);
		await f.store.removeEnrollment({ groupId: removed.groupId, deviceId: removed.deviceId });
		// Act
		const moved = f.exec(
			"UPDATE enrolled_devices SET group_id = ? WHERE group_id = ? AND device_id = ?",
			removed.groupId,
			survivor.groupId,
			survivor.deviceId,
		);
		// Assert: no delete can then use the old tombstone on a moved row.
		await expect(moved).rejects.toThrow(/device_removed/u);
		expect(await enrollments(f)).toMatchObject([{ group_id: survivor.groupId }]);
	});
}

function registerCollisionTriggers(test: RemovalTest) {
	test("A24 replacing inserts and updates that collide with another enrollment abort and leave it in place", async ({
		fixture: f,
	}) => {
		// Arrange: recursive triggers are off by default, so a replacement would skip the delete trigger.
		const first = await target(f, "first");
		const second = await target(f, "second");
		await currentInsert(f, first);
		await currentInsert(f, second);
		const before = await f.rows(
			"SELECT rowid AS row_id, * FROM enrolled_devices WHERE device_id LIKE ? ORDER BY rowid",
			`${f.prefix}%`,
		);
		const firstRowId = before[0]?.row_id;
		const replacement = { ...first, key: second.key };
		const collisions: [string, unknown[]][] = [
			[
				`INSERT OR REPLACE INTO enrolled_devices(rowid, group_id, device_id, public_key,
					fingerprint, enabled, created_at, key_id) VALUES (?, ?, ?, 'k', 'f', 1, 'now', '')`,
				[firstRowId, first.groupId, `${f.prefix}-third`],
			],
			...["rowid", "_rowid_", "oid"].map((name): [string, unknown[]] => [
				`UPDATE OR REPLACE enrolled_devices SET ${name} = ? WHERE device_id = ?`,
				[firstRowId, second.deviceId],
			]),
			[
				"UPDATE OR REPLACE enrolled_devices SET device_id = ? WHERE device_id = ?",
				[first.deviceId, second.deviceId],
			],
		];
		// Act and assert
		await expect(currentInsert(f, replacement, "INSERT OR REPLACE")).rejects.toThrow(
			/enrollment_collision/u,
		);
		for (const [sql, values] of collisions) {
			await expect(f.exec(sql, ...values)).rejects.toThrow(/enrollment_collision/u);
		}
		expect(
			await f.rows(
				"SELECT rowid AS row_id, * FROM enrolled_devices WHERE device_id LIKE ? ORDER BY rowid",
				`${f.prefix}%`,
			),
		).toEqual(before);
	});
}

/** The invitation helpers of the revocation harnesses, on this fixture's database. */
export function invitationFixture(
	f: RemovalFixture,
	name: string,
	key: DeviceKey,
): RevocationFixture {
	return {
		store: f.store,
		input: {
			groupId: `${f.prefix}-${name}-group`,
			deviceId: `${f.prefix}-${name}`,
			publicKey: key.publicKey,
			fingerprint: key.fingerprint,
			actorId: `${f.prefix}-operator`,
		},
		exec: f.exec,
		rows: (table) => f.rows(`SELECT * FROM ${table} ORDER BY rowid`),
	};
}

function registerInvitationWriters(test: RemovalTest) {
	test("A13 A26 invitation acceptance stores the key ID for a first enrollment and keeps an existing one", async ({
		fixture: f,
	}) => {
		// Arrange: a team invitation for a new device, and a Project invitation for an enrolled one.
		const joining = await removalDeviceKey(`${f.prefix}-joining`);
		const enrolled = await removalDeviceKey(`${f.prefix}-enrolled`);
		const team = invitationFixture(f, "team", joining);
		const project = invitationFixture(f, "project", enrolled);
		const teamInvite = await recipientInvite(team, "team_member");
		const projectShare = await projectInvite(project);
		await f.store.enrollDevice(project.input.groupId, project.input);
		// Act
		const accepted = await f.store.consumeRecipientInvite(teamInvite.input);
		const shared = await f.store.consumeProjectInvite(projectShare.input);
		const retried = await f.store.consumeRecipientInvite(teamInvite.input);
		// Assert
		expect([accepted.status, shared.status, retried.status]).toEqual([
			"accepted",
			"accepted",
			"existing",
		]);
		expect(
			await f.rows(
				`SELECT device_id, key_id, identity_id FROM enrolled_devices
				WHERE device_id IN (?, ?) ORDER BY device_id`,
				team.input.deviceId,
				project.input.deviceId,
			),
		).toEqual([
			{
				device_id: project.input.deviceId,
				key_id: enrolled.keyId,
				identity_id: projectShare.input.recipientActorId,
			},
			{
				device_id: team.input.deviceId,
				key_id: joining.keyId,
				identity_id: teamInvite.input.identityId,
			},
		]);
	});
}

function registerExistingEnrollmentWriters(test: RemovalTest) {
	test("A26 enrollment writers still work for a device already enrolled in the group", async ({
		fixture: f,
	}) => {
		// Arrange
		const enrolled = await target(f);
		const rotated = { ...enrolled, key: await removalDeviceKey(`${f.prefix}-rotated`) };
		const expiresAt = "2099-01-01T00:00:00.000Z";
		await enroll(f, enrolled);
		// Act: the same tuple again, a new key, then a join approval back to the first key.
		await enroll(f, enrolled);
		await enroll(f, rotated);
		const afterAdmin = await enrollments(f);
		const invite = await f.store.createInvite({
			groupId: enrolled.groupId,
			policy: "approval_required",
			expiresAt,
		});
		const request = await f.store.createJoinRequest({
			groupId: enrolled.groupId,
			deviceId: enrolled.deviceId,
			publicKey: enrolled.key.publicKey,
			fingerprint: enrolled.key.fingerprint,
			token: invite.token,
		});
		const review = await f.store.reviewJoinRequest({
			requestId: request.request_id,
			approved: true,
		});
		// Assert: one row throughout, with the key ID of its current key.
		expect(afterAdmin).toEqual([
			{
				group_id: enrolled.groupId,
				device_id: enrolled.deviceId,
				public_key: rotated.key.publicKey,
				key_id: rotated.key.keyId,
			},
		]);
		expect(review?.status).toBe("approved");
		expect(await enrollments(f)).toEqual([
			{
				group_id: enrolled.groupId,
				device_id: enrolled.deviceId,
				public_key: enrolled.key.publicKey,
				key_id: enrolled.key.keyId,
			},
		]);
	});
}
