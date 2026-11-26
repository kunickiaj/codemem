import { expect } from "vitest";
import { ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS } from "./coordinator-device-removal.js";
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
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	NODE_ONLY_ALIASES,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	deleteEnrollmentWithoutTombstone,
	seedEnrollment,
} from "./coordinator-enrollment-test-fixtures.js";

/** Store-side E1–E11 and the lookup assertion of B15, independent of route changes. */
export function registerPeerRemovalQueryContract(test: RemovalTest) {
	registerQueryMatching(test);
	registerOpaqueQuery(test);
	registerSurvivingKey(test);
	registerQueryHistory(test);
	registerQueryRevocation(test);
	registerIdRevocation(test);
	registerQueryInputs(test);
	registerQueryReadiness(test);
	registerQueryBoundary(test);
	registerKeyEvidence(test);
}
const NO_KEYS = { removed: [], enrolled: [] };
const lookup = (f: RemovalFixture, ...peers: { deviceId: string; publicKey?: string }[]) =>
	f.store.lookupPeerRemovals({ peers });
const keyed = (device: Enrollment, deviceId = device.deviceId) => ({
	deviceId,
	publicKey: device.key.publicKey,
});
const seed = (f: RemovalFixture, device: Enrollment) =>
	seedEnrollment(f.exec, { groupId: device.groupId, deviceId: device.deviceId, ...device.key });
async function highest(f: RemovalFixture) {
	const [row] = await f.rows<{ seq: number }>(
		"SELECT COALESCE(MAX(removal_seq), 0) AS seq FROM coordinator_device_removals",
	);
	if (!row) throw new Error("Missing fixture maximum");
	return row.seq;
}
async function remove(f: RemovalFixture, device: Enrollment) {
	await enroll(f, device);
	expect(await f.store.removeDevice(device.groupId, device.deviceId)).toBe(true);
}

function registerQueryMatching(test: RemovalTest) {
	test("E1 E9 an empty lookup returns complete empty arrays and the maximum sequence including lifted history", async ({
		fixture: f,
	}) => {
		expect(await lookup(f)).toEqual({
			revoked: [],
			removed: [],
			enrolled: [],
			removal_seq: 0,
			key_evidence: NO_KEYS,
		});
		const device = await target(f);
		await remove(f, device);
		await liftTombstones(f, device.deviceId);
		expect(await lookup(f)).toEqual({
			revoked: [],
			removed: [],
			enrolled: [],
			removal_seq: await highest(f),
			key_evidence: NO_KEYS,
		});
	});
	test("E2 full removal matches the ID with another key and a canonical-key alias, but a keyless unknown ID matches nothing", async ({
		fixture: f,
	}) => {
		const device = await target(f);
		await remove(f, device);
		const alias = `${f.prefix}-alias`;
		expect(
			await lookup(
				f,
				{ deviceId: device.deviceId, publicKey: "another-key" },
				{ deviceId: alias, publicKey: `${device.key.publicKey} comment` },
				{ deviceId: `${f.prefix}-unknown` },
			),
		).toEqual({
			revoked: [],
			removed: [alias, device.deviceId].sort(),
			enrolled: [],
			removal_seq: await highest(f),
			// A lookup without a signed caller relates no device to it.
			key_evidence: NO_KEYS,
		});
	});
}

function registerOpaqueQuery(test: RemovalTest) {
	test("E2 opaque removals match exact text while omitted keys do not become opaque-key queries", async ({
		fixture: f,
	}) => {
		const device = { ...(await target(f)), key: opaqueKey("case-sensitive text") };
		await remove(f, device);
		const alias = `${f.prefix}-alias`;
		expect(
			(
				await lookup(
					f,
					keyed(device, alias),
					{ deviceId: `${f.prefix}-keyless` },
					{ deviceId: `${f.prefix}-case`, publicKey: device.key.publicKey.toUpperCase() },
				)
			).removed,
		).toEqual([alias]);
		await liftTombstones(f, device.deviceId);
		await seed(f, { ...device, groupId: `${f.prefix}-survivor`, deviceId: `${f.prefix}-survivor` });
		await insertTombstone(f, device);
		expect(await lookup(f, keyed(device, alias))).toEqual({
			revoked: [],
			removed: [],
			enrolled: [alias],
			removal_seq: await highest(f),
			// The surviving enrollment of that key is under another ID.
			key_evidence: NO_KEYS,
		});
	});
}

function registerQueryBoundary(test: RemovalTest) {
	test("E9 a removal at the snapshot boundary is reflected in both flags and the maximum sequence", async ({
		fixture: f,
	}) => {
		const device = await target(f);
		await enroll(f, device);
		let removed: Promise<boolean> | undefined;
		const store = f.interleave(["MAX(removal_seq)"], () => {
			removed = f.store.removeDevice(device.groupId, device.deviceId);
			return removed;
		});
		const result = await store.lookupPeerRemovals({ peers: [{ deviceId: device.deviceId }] });
		expect(await removed).toBe(true);
		expect(result).toEqual({
			revoked: [],
			removed: [device.deviceId],
			enrolled: [],
			removal_seq: await highest(f),
			key_evidence: NO_KEYS,
		});
	});
}

function registerSurvivingKey(test: RemovalTest) {
	test("E3 E10 disabled enrollment in an archived foreign group suppresses removal of that same key", async ({
		fixture: f,
	}) => {
		const device = await target(f);
		await enroll(f, device);
		const survivor = { ...device, groupId: `${f.prefix}-other`, deviceId: `${f.prefix}-other` };
		await enroll(f, survivor);
		await f.store.setDeviceEnabled(survivor.groupId, survivor.deviceId, false);
		await f.store.archiveGroup(survivor.groupId);
		await f.store.removeDevice(device.groupId, device.deviceId);
		expect(await lookup(f, { deviceId: device.deviceId })).toEqual({
			revoked: [],
			removed: [],
			enrolled: [],
			removal_seq: await highest(f),
			key_evidence: NO_KEYS,
		});
		const alias = `${f.prefix}-alias`;
		expect(await lookup(f, keyed(device, alias), { deviceId: survivor.deviceId })).toEqual({
			revoked: [],
			removed: [],
			enrolled: [alias, survivor.deviceId].sort(),
			removal_seq: await highest(f),
			key_evidence: NO_KEYS,
		});
	});
}

function registerQueryHistory(test: RemovalTest) {
	test("B15 E8 the same ID under another key does not hide the old removal and can be both removed and enrolled", async ({
		fixture: f,
	}) => {
		const old = await target(f);
		const current = { ...(await target(f, "new-key", "g2")), deviceId: old.deviceId };
		await seed(f, current);
		await insertTombstone(f, old);
		expect(await lookup(f, { deviceId: old.deviceId })).toEqual({
			revoked: [],
			removed: [old.deviceId],
			enrolled: [old.deviceId],
			removal_seq: await highest(f),
			key_evidence: NO_KEYS,
		});
	});
	test("E4 any individually effective tombstone matches; surviving K1 cannot hide removed K2 for a keyless ID", async ({
		fixture: f,
	}) => {
		const first = await target(f);
		const second = { ...(await target(f, "second", "g2")), deviceId: first.deviceId };
		await seed(f, { ...first, deviceId: `${f.prefix}-survivor`, groupId: `${f.prefix}-g3` });
		await insertTombstone(f, first);
		await insertTombstone(f, second);
		expect((await lookup(f, { deviceId: first.deviceId })).removed).toEqual([first.deviceId]);
		await f.exec(
			`UPDATE coordinator_device_removals SET lifted_at = 'later', lifted_by_invite_id = 'fixture'
			WHERE group_id = ? AND device_id = ?`,
			second.groupId,
			second.deviceId,
		);
		expect(await lookup(f, { deviceId: first.deviceId })).toEqual({
			revoked: [],
			removed: [],
			enrolled: [],
			removal_seq: await highest(f),
			key_evidence: NO_KEYS,
		});
	});
}

async function revoke(f: RemovalFixture, device: Enrollment) {
	await enroll(f, device);
	expect(
		await f.store.createDeviceRevocation({
			groupId: device.groupId,
			deviceId: device.deviceId,
			publicKey: device.key.publicKey,
			fingerprint: device.key.fingerprint,
		}),
	).toMatchObject({ kind: "revoked" });
	await deleteEnrollmentWithoutTombstone(f.exec, "device_id = ?", device.deviceId);
}
function registerIdRevocation(test: RemovalTest) {
	test("E5 an ID revocation matches keyless requests and any supplied key without returning duplicate IDs", async ({
		fixture: f,
	}) => {
		const device = await target(f);
		await revoke(f, device);
		await insertTombstone(f, device);
		const alias = `${f.prefix}-alias`;
		expect(
			await lookup(
				f,
				{ deviceId: device.deviceId },
				{ deviceId: device.deviceId, publicKey: "different opaque key" },
				keyed(device, alias),
			),
		).toEqual({
			revoked: [alias, device.deviceId].sort(),
			removed: [],
			enrolled: [],
			removal_seq: await highest(f),
			key_evidence: NO_KEYS,
		});
	});
}

function registerQueryRevocation(test: RemovalTest) {
	test("E5 keyless entries do not inherit historical key revocations, and duplicate-ID revocation wins globally", async ({
		fixture: f,
	}) => {
		const removed = await target(f);
		await revoke(f, {
			...removed,
			deviceId: `${f.prefix}-revoked-alias`,
			groupId: `${f.prefix}-evidence`,
		});
		const current = { ...(await target(f, "current", "current")), deviceId: removed.deviceId };
		await seed(f, current);
		await insertTombstone(f, removed);
		expect(await lookup(f, { deviceId: removed.deviceId })).toEqual({
			revoked: [],
			removed: [removed.deviceId],
			enrolled: [removed.deviceId],
			removal_seq: await highest(f),
			key_evidence: NO_KEYS,
		});
		expect(await lookup(f, { deviceId: removed.deviceId }, keyed(current), keyed(removed))).toEqual(
			{
				revoked: [removed.deviceId],
				removed: [],
				enrolled: [removed.deviceId],
				removal_seq: await highest(f),
				key_evidence: NO_KEYS,
			},
		);
	});
	test("key derivation retains the revocation parser's accepted aliases and treats malformed Ed25519 text as opaque metadata", async ({
		fixture: f,
	}) => {
		const device = {
			...(await target(f)),
			key: {
				publicKey: CANONICAL_PUBLIC_KEY,
				keyId: EXPECTED_KEY_ID,
				fingerprint: "fixture",
			},
		};
		await seed(f, device);
		for (const alias of [...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES])
			expect((await lookup(f, { deviceId: "alias", publicKey: alias.publicKey })).enrolled).toEqual(
				["alias"],
			);
		const malformed = { ...(await target(f, "malformed")), key: opaqueKey("unused") };
		malformed.key.publicKey = "ssh-ed25519 not-a-key";
		malformed.key.keyId = "";
		await seed(f, malformed);
		expect(
			(await lookup(f, { deviceId: "opaque-alias", publicKey: malformed.key.publicKey })).enrolled,
		).toEqual(["opaque-alias"]);
	});
}

function registerQueryInputs(test: RemovalTest) {
	test("direct lookup rejects invalid entries and enforces the existing 25-entry and 4096-character key bounds", async ({
		fixture: f,
	}) => {
		const invalid: unknown[] = [
			null,
			{},
			{ peers: null },
			{ peers: [null] },
			{ peers: ["id"] },
			{ peers: [{ deviceId: "" }] },
			{ peers: [{ deviceId: " padded " }] },
			...["", null, 7, "x".repeat(4097), "key\u0000text"].map((publicKey) => ({
				peers: [{ deviceId: "id", publicKey }],
			})),
			{ peers: Array.from({ length: 26 }, () => ({ deviceId: "id" })) },
		];
		for (const input of invalid)
			await expect(f.store.lookupPeerRemovals(input as never)).rejects.toThrow("invalid_input");
		const peers = Array.from({ length: 25 }, (_, i) => ({
			deviceId: `id-${i}`,
			publicKey: "x".repeat(4096),
		}));
		expect(await f.store.lookupPeerRemovals({ peers })).toEqual({
			revoked: [],
			removed: [],
			enrolled: [],
			removal_seq: 0,
			key_evidence: NO_KEYS,
		});
	});
}
function registerQueryReadiness(test: RemovalTest) {
	test("snapshot lookup refuses pre-0049 storage and null enrollment key IDs instead of returning empty success", async ({
		fixture: f,
	}) => {
		const sql = ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS[0];
		if (!sql) throw new Error("Missing fixture trigger");
		await f.exec("DROP TRIGGER enrolled_devices_removal_insert");
		try {
			await expect(lookup(f)).rejects.toThrow("device_removal_unavailable");
		} finally {
			await f.exec(sql);
		}
		await legacyInsert(f, await target(f));
		await expect(lookup(f)).rejects.toThrow("device_removal_unavailable");
	});
}

/** The caller enrolled, under one key, in each named group of this test. */
async function callerIn(f: RemovalFixture, ...groups: string[]) {
	const [first, ...others] = groups;
	if (!first) throw new Error("Missing fixture group");
	const caller = await target(f, "caller", first);
	await enroll(f, caller);
	for (const group of others) await enroll(f, { ...caller, groupId: `${f.prefix}-${group}` });
	return { groupId: caller.groupId, deviceId: caller.deviceId };
}
const lookupAs = (
	f: RemovalFixture,
	caller: { groupId: string; deviceId: string },
	...peers: { deviceId: string; publicKey?: string }[]
) => f.store.lookupPeerRemovals({ peers, caller });

/** An old key removed in g1, and the same ID enrolled with a current key in g2. */
async function rotatedDevice(f: RemovalFixture) {
	const old = await target(f);
	const current = { ...(await target(f, "new-key", "g2")), deviceId: old.deviceId };
	await seed(f, current);
	await insertTombstone(f, old);
	return { old, current };
}

function registerKeyEvidence(test: RemovalTest) {
	registerSharedGroupEvidence(test);
	registerWithheldEvidence(test);
}

function registerSharedGroupEvidence(test: RemovalTest) {
	test("K1 a caller in both groups tells an old removed key from a current enrolled key under one ID", async ({
		fixture: f,
	}) => {
		const { old, current } = await rotatedDevice(f);
		const caller = await callerIn(f, "g1", "g2");
		const legacy = { revoked: [], removed: [old.deviceId], enrolled: [old.deviceId] };

		expect(await lookupAs(f, caller, keyed(current))).toEqual({
			...legacy,
			removal_seq: await highest(f),
			key_evidence: { removed: [], enrolled: [old.deviceId] },
		});
		expect(await lookupAs(f, caller, keyed(old))).toEqual({
			...legacy,
			removal_seq: await highest(f),
			key_evidence: { removed: [old.deviceId], enrolled: [] },
		});
	});
	test("K2 a key enrolled only under another ID is not evidence for the ID that was sent", async ({
		fixture: f,
	}) => {
		const old = await target(f);
		const elsewhere = await target(f, "elsewhere", "g2");
		await seed(f, elsewhere);
		await insertTombstone(f, old);
		const caller = await callerIn(f, "g1", "g2");

		const result = await lookupAs(f, caller, {
			deviceId: old.deviceId,
			publicKey: elsewhere.key.publicKey,
		});

		expect(result.removed).toEqual([old.deviceId]);
		expect(result.key_evidence).toEqual(NO_KEYS);
	});
	test("K3 a key removed in a shared group is reported for its ID and no enrollment is claimed", async ({
		fixture: f,
	}) => {
		const device = await target(f);
		await remove(f, device);
		const caller = await callerIn(f, "g1");

		expect(
			(await lookupAs(f, caller, keyed(device), { deviceId: `${f.prefix}-keyless` })).key_evidence,
		).toEqual({ removed: [device.deviceId], enrolled: [] });
	});
}

function registerWithheldEvidence(test: RemovalTest) {
	test("K4 a caller in an unrelated group learns nothing beyond the legacy fields", async ({
		fixture: f,
	}) => {
		const { old, current } = await rotatedDevice(f);
		const caller = await callerIn(f, "unrelated");

		for (const entry of [keyed(current), keyed(old)])
			expect(await lookupAs(f, caller, entry)).toEqual({
				revoked: [],
				removed: [old.deviceId],
				enrolled: [old.deviceId],
				removal_seq: await highest(f),
				key_evidence: NO_KEYS,
			});
	});
	test("K5 a blocked device gets no key evidence even in a shared group", async ({
		fixture: f,
	}) => {
		const device = await target(f);
		await enroll(f, device);
		await f.store.createDeviceRevocation({
			groupId: device.groupId,
			deviceId: device.deviceId,
			publicKey: device.key.publicKey,
			fingerprint: device.key.fingerprint,
		});
		await insertTombstone(f, { ...device, groupId: `${f.prefix}-g2` });
		const caller = await callerIn(f, "g1", "g2");

		const result = await lookupAs(f, caller, keyed(device));

		expect(result.revoked).toEqual([device.deviceId]);
		expect(result.key_evidence).toEqual(NO_KEYS);
	});
	test("K6 a group where the caller is enrolled under another key is not shared", async ({
		fixture: f,
	}) => {
		const { old } = await rotatedDevice(f);
		const caller = await callerIn(f, "home");
		await enroll(f, { ...(await target(f, "caller-other-key", "g1")), deviceId: caller.deviceId });

		expect((await lookupAs(f, caller, keyed(old))).key_evidence).toEqual(NO_KEYS);
	});
	test("K6 a shared group stops counting when the caller is disabled there or it is archived", async ({
		fixture: f,
	}) => {
		const { current } = await rotatedDevice(f);
		const caller = await callerIn(f, "home", "g2");
		const evidence = async () => (await lookupAs(f, caller, keyed(current))).key_evidence;
		expect(await evidence()).toEqual({ removed: [], enrolled: [current.deviceId] });

		await f.store.setDeviceEnabled(current.groupId, caller.deviceId, false);
		expect(await evidence()).toEqual(NO_KEYS);
		await f.store.setDeviceEnabled(current.groupId, caller.deviceId, true);
		await f.store.archiveGroup(current.groupId);
		expect(await evidence()).toEqual(NO_KEYS);
	});
	test("K7 a disabled enrollment in a shared group is not evidence that the key is enrolled", async ({
		fixture: f,
	}) => {
		const { current } = await rotatedDevice(f);
		const caller = await callerIn(f, "g2");
		await f.store.setDeviceEnabled(current.groupId, current.deviceId, false);

		expect((await lookupAs(f, caller, keyed(current))).key_evidence).toEqual(NO_KEYS);
	});
}
