import { expect, it } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/**
 * Numbers in test names are the entries of group A in the removal test plan.
 */
export type RemovalFixture = {
	store: Store;
	/** Unique for each test. */
	prefix: string;
	/** Raw SQL write. Rejects when a trigger or constraint aborts the statement. */
	exec: (sql: string, ...values: unknown[]) => Promise<void>;
	rows: <T = Record<string, unknown>>(sql: string, ...values: unknown[]) => Promise<T[]>;
};

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

export type Enrollment = { groupId: string; deviceId: string; key: DeviceKey };

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

export async function target(f: RemovalFixture, name = "d", group = "g1"): Promise<Enrollment> {
	return {
		groupId: `${f.prefix}-${group}`,
		deviceId: `${f.prefix}-${name}`,
		key: await removalDeviceKey(`${f.prefix}-${name}`),
	};
}

export function registerDeviceRemovalContract(test: RemovalTest) {
	registerTombstoneRules(test);
	registerTombstoneSequence(test);
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
