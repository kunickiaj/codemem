import { expect } from "vitest";
import {
	ENROLLMENT_REMOVAL_TRIGGER_NAMES,
	ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS,
} from "./coordinator-device-removal.js";
import {
	type Enrollment,
	enroll,
	insertTombstone,
	legacyInsert,
	liftTombstones,
	opaqueKey,
	type RemovalFixture,
	type RemovalTest,
	target,
} from "./coordinator-device-removal-test-harness.js";

/** D5/D6: active removal history, filtered before pagination, with no public keys. */
export function registerDeviceRemovalListContract(test: RemovalTest) {
	registerListShape(test);
	registerListFilters(test);
	registerListCap(test);
	registerListValidation(test);
	registerListReadiness(test);
}

function cursor(page: { next_before_seq: number | null }): number {
	if (page.next_before_seq === null) throw new Error("Expected another page");
	return page.next_before_seq;
}

async function add(f: RemovalFixture, name: string, group = "g1") {
	const device = await target(f, name, group);
	await insertTombstone(f, device);
	const [row] = await f.rows<{ removal_seq: number }>(
		"SELECT removal_seq FROM coordinator_device_removals WHERE group_id = ? AND device_id = ? AND lifted_at IS NULL",
		device.groupId,
		device.deviceId,
	);
	if (!row) throw new Error("Missing fixture tombstone");
	return {
		device,
		item: {
			removal_id: `${f.prefix}-raw-removal`,
			removal_seq: row.removal_seq,
			group_id: device.groupId,
			device_id: device.deviceId,
			fingerprint: device.key.fingerprint,
			key_id: device.key.keyId,
			display_name: null,
			identity_id: null,
			removed_at: "2026-11-17T00:00:00.000Z",
		},
	};
}

/** A revocation recorded from an enrolled alias is global evidence for the subject. */
async function block(f: RemovalFixture, device: Enrollment, kind: "device_id" | "ed25519_key") {
	await enroll(f, device);
	expect(
		await f.store.createDeviceRevocation({
			groupId: device.groupId,
			deviceId: device.deviceId,
			publicKey: device.key.publicKey,
			fingerprint: device.key.fingerprint,
		}),
	).toMatchObject({ kind: "revoked" });
	// Leave exactly one subject so the test distinguishes ID from key matching.
	await f.exec(
		"DELETE FROM coordinator_device_revocations WHERE subject_kind = ? AND subject_value = ?",
		kind === "device_id" ? "ed25519_key" : "device_id",
		kind === "device_id" ? device.key.keyId : device.deviceId,
	);
}

function registerListShape(test: RemovalTest) {
	test("D5 an empty removal listing has no cursor", async ({ fixture: f }) => {
		expect(await f.store.listDeviceRemovals()).toEqual({ items: [], next_before_seq: null });
	});
	test("D5 the listing is newest first, active only, read-only, and has exactly the approved fields", async ({
		fixture: f,
	}) => {
		const older = await add(f, "old");
		await add(f, "lifted");
		await liftTombstones(f, `${f.prefix}-lifted`);
		const newer = await add(f, "new");
		const before = await f.rows("SELECT * FROM coordinator_device_removals ORDER BY removal_seq");
		expect(await f.store.listDeviceRemovals()).toEqual({
			items: [newer.item, older.item],
			next_before_seq: null,
		});
		expect(await f.rows("SELECT * FROM coordinator_device_removals ORDER BY removal_seq")).toEqual(
			before,
		);
	});
	test("D5 two-item pages reach the oldest matching tombstone without repeating a row", async ({
		fixture: f,
	}) => {
		const a = await add(f, "a");
		const b = await add(f, "b");
		const c = await add(f, "c");
		const first = await f.store.listDeviceRemovals({ limit: 2 });
		expect(first).toEqual({ items: [c.item, b.item], next_before_seq: b.item.removal_seq });
		expect(await f.store.listDeviceRemovals({ limit: 2, beforeSeq: cursor(first) })).toEqual({
			items: [a.item],
			next_before_seq: null,
		});
		expect(await f.store.listDeviceRemovals({ beforeSeq: a.item.removal_seq })).toEqual({
			items: [],
			next_before_seq: null,
		});
	});
}

function registerListReadiness(test: RemovalTest) {
	test("D6 listing requires each enrollment trigger by name, even when the page would be empty", async ({
		fixture: f,
	}) => {
		for (const [i, name] of ENROLLMENT_REMOVAL_TRIGGER_NAMES.entries()) {
			const sql = ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS[i];
			if (!sql) throw new Error("Missing fixture trigger");
			await f.exec(`DROP TRIGGER ${name}`);
			try {
				await expect(f.store.listDeviceRemovals()).rejects.toThrow("device_removal_unavailable");
			} finally {
				await f.exec(sql);
			}
		}
	});
	test("D5 an opaque removal retains display and Identity metadata but omits public key and audit-only fields", async ({
		fixture: f,
	}) => {
		const device = { ...(await target(f)), key: opaqueKey(`${f.prefix}-opaque`) };
		await enroll(f, device);
		await f.exec(
			`UPDATE enrolled_devices SET display_name = 'Work laptop', identity_id = 'identity-a'
			WHERE group_id = ? AND device_id = ?`,
			device.groupId,
			device.deviceId,
		);
		const removed = await f.store.removeEnrollment({
			groupId: device.groupId,
			deviceId: device.deviceId,
			actorId: "operator",
		});
		if (removed.kind !== "removed") throw new Error("Missing removal");
		expect(await f.store.listDeviceRemovals({ includeBlocked: true })).toEqual({
			items: [
				{
					removal_id: removed.removal_id,
					removal_seq: removed.removals[0]?.removal_seq,
					group_id: device.groupId,
					device_id: device.deviceId,
					fingerprint: device.key.fingerprint,
					key_id: null,
					display_name: "Work laptop",
					identity_id: "identity-a",
					removed_at: expect.any(String),
				},
			],
			next_before_seq: null,
		});
	});
}

async function filteredHistory(f: RemovalFixture) {
	const oldest = await add(f, "keep", "g1");
	await add(f, "other");
	const byId = await target(f, "blocked-id", "evidence");
	const byKey = await target(f, "key-owner", "evidence");
	await block(f, byId, "device_id");
	await block(f, byKey, "ed25519_key");
	const blockedId = await add(f, "blocked-id");
	const alias = { ...byKey, groupId: `${f.prefix}-g2`, deviceId: `${f.prefix}-alias` };
	await insertTombstone(f, alias);
	const [blockedKey] = await f.rows<{ removal_seq: number }>(
		"SELECT removal_seq FROM coordinator_device_removals WHERE device_id = ?",
		alias.deviceId,
	);
	const newest = await add(f, "keep", "g3");
	return { oldest, newest, blockedId, blockedKey, alias };
}

function registerListFilters(test: RemovalTest) {
	test("D5 exact device filtering precedes the page limit, and both ID and canonical-key blocks are omitted", async ({
		fixture: f,
	}) => {
		const { oldest, newest } = await filteredHistory(f);
		expect(
			await f.store.listDeviceRemovals({ deviceId: oldest.device.deviceId, limit: 2 }),
		).toEqual({ items: [newest.item, oldest.item], next_before_seq: null });
		const all = await f.store.listDeviceRemovals({ limit: 2 });
		expect(all.items.map((row) => row.device_id)).toEqual([
			newest.device.deviceId,
			`${f.prefix}-other`,
		]);
		expect(all.next_before_seq).not.toBeNull();
		expect(
			await f.store.listDeviceRemovals({ deviceId: `${f.prefix}-kee`, includeBlocked: true }),
		).toEqual({ items: [], next_before_seq: null });
	});
	test("D5 includeBlocked marks only blocked rows, including a key alias under a different device ID", async ({
		fixture: f,
	}) => {
		const { oldest, newest, blockedId, blockedKey, alias } = await filteredHistory(f);
		const page = await f.store.listDeviceRemovals({ includeBlocked: true, limit: 3 });
		expect(page.items[0]).toEqual(newest.item);
		expect(page.items.slice(1)).toEqual([
			{
				...blockedId.item,
				group_id: alias.groupId,
				device_id: alias.deviceId,
				removal_seq: blockedKey?.removal_seq,
				fingerprint: alias.key.fingerprint,
				key_id: alias.key.keyId,
				revoked: true,
			},
			{ ...blockedId.item, revoked: true },
		]);
		expect(page.next_before_seq).toBe(blockedId.item.removal_seq);
		const final = await f.store.listDeviceRemovals({
			includeBlocked: true,
			beforeSeq: blockedId.item.removal_seq,
		});
		expect(final.items.at(-1)).toEqual(oldest.item);
		expect(final.items.every((row) => !Object.hasOwn(row, "revoked"))).toBe(true);
		expect(final.next_before_seq).toBeNull();
	});
}

function registerListCap(test: RemovalTest) {
	test("D5 the default and an oversized named limit cap at 500 even with a device filter", async ({
		fixture: f,
	}) => {
		const base = await target(f, "many");
		await f.exec(
			`INSERT INTO coordinator_device_removals
			(removal_id, group_id, device_id, public_key, fingerprint, key_id, removed_at)
			SELECT 'many', ? || value, ?, ?, ?, ?, 'then' FROM json_each(?)`,
			`${f.prefix}-g`,
			base.deviceId,
			base.key.publicKey,
			base.key.fingerprint,
			base.key.keyId,
			JSON.stringify(Array.from({ length: 501 }, (_, i) => i)),
		);
		const plain = await f.store.listDeviceRemovals();
		const filtered = await f.store.listDeviceRemovals({ deviceId: base.deviceId, limit: 900 });
		expect(filtered).toEqual(plain);
		expect(plain.items).toHaveLength(500);
		expect(plain.next_before_seq).toBe(plain.items.at(-1)?.removal_seq);
		const tail = await f.store.listDeviceRemovals({
			deviceId: base.deviceId,
			beforeSeq: cursor(plain),
		});
		expect(tail.items).toHaveLength(1);
		expect(tail.items[0]?.removal_seq).toBeLessThan(cursor(plain));
		expect(tail.next_before_seq).toBeNull();
	});
}

function registerListValidation(test: RemovalTest) {
	test("D6 listing is unavailable while any enrollment has no key ID, even with no matching tombstones", async ({
		fixture: f,
	}) => {
		await legacyInsert(f, await target(f));
		await expect(f.store.listDeviceRemovals({ deviceId: "absent" })).rejects.toThrow(
			"device_removal_unavailable",
		);
	});
	test("listing rejects invalid options and accepts every safe-integer cursor without rounding it", async ({
		fixture: f,
	}) => {
		const invalid = [
			{ beforeSeq: 1.5 },
			{ beforeSeq: Number.MAX_SAFE_INTEGER + 1 },
			{ beforeSeq: "1" },
			{ beforeSeq: null },
			{ includeBlocked: 1 },
			{ includeBlocked: null },
			{ deviceId: "" },
			{ deviceId: " padded " },
			{ deviceId: null },
			{ limit: 0 },
			{ limit: -1 },
			{ limit: 1.5 },
			{ limit: Infinity },
			null,
			[],
		];
		for (const options of invalid)
			await expect(f.store.listDeviceRemovals(options as never)).rejects.toThrow("invalid_input");
		await add(f, "one");
		for (const beforeSeq of [0, -1, Number.MIN_SAFE_INTEGER])
			expect(await f.store.listDeviceRemovals({ beforeSeq })).toEqual({
				items: [],
				next_before_seq: null,
			});
		expect(
			(await f.store.listDeviceRemovals({ beforeSeq: Number.MAX_SAFE_INTEGER })).items,
		).toHaveLength(1);
	});
}
