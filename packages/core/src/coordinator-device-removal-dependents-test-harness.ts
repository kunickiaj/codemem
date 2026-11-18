import { expect } from "vitest";
import {
	type Enrollment,
	enroll,
	liftTombstones,
	REMOVAL_CLOCK_MS,
	type RemovalFixture,
	type RemovalTest,
	target,
} from "./coordinator-device-removal-test-harness.js";

/**
 * What a removal does beyond the enrollment: it revokes the device's scope
 * memberships as the membership revocation does, revokes its bootstrap grants,
 * and denies its pending join requests. Numbers in test names are entries of
 * group A in the removal test plan. The fixtures are those of the removal harness.
 */
export function registerDeviceRemovalDependentsContract(test: RemovalTest) {
	registerMembershipRevocation(test);
	registerLaterGrant(test);
	registerMembershipRevocationRows(test);
	registerRemovalEffectIsolation(test);
	registerScopesWithoutGroup(test);
	registerGrantRevocation(test);
	registerJoinRequestDenial(test);
	registerSuppressedDependentWrites(test);
}

const CLOCK = new Date(REMOVAL_CLOCK_MS).toISOString();
const actor = (f: RemovalFixture) => `${f.prefix}-operator`;

async function scope(f: RemovalFixture, name: string, groupId: string | null): Promise<string> {
	const scopeId = `${f.prefix}-${name}`;
	await f.store.createScope({ scopeId, label: name, groupId });
	return scopeId;
}

let grantsMade = 0;
function grant(f: RemovalFixture, scopeId: string, deviceId: string, membershipEpoch?: number) {
	return f.store.grantScopeMembership({
		effectId: `${f.prefix}-grant-${++grantsMade}`,
		scopeId,
		deviceId,
		membershipEpoch,
	});
}

type Membership = { row_id: number; status: string; membership_epoch: number; updated_at: string };

async function membership(f: RemovalFixture, scopeId: string, deviceId: string) {
	const rows = await f.rows<Membership>(
		`SELECT rowid AS row_id, status, membership_epoch, updated_at
		FROM coordinator_scope_memberships WHERE scope_id = ? AND device_id = ?`,
		scopeId,
		deviceId,
	);
	if (rows.length !== 1 || !rows[0]) throw new Error("Missing fixture membership");
	return rows[0];
}

/** Removes the enrollment and returns the sequence of its tombstone. */
async function remove(f: RemovalFixture, enrollment: Enrollment): Promise<number> {
	const result = await f.store.removeEnrollment({
		groupId: enrollment.groupId,
		deviceId: enrollment.deviceId,
		actorId: actor(f),
	});
	if (result.kind !== "removed" || !result.removals[0]) throw new Error("Not removed");
	return result.removals[0].removal_seq;
}

const removalEffects = (f: RemovalFixture, table: string) =>
	f.rows<Record<string, unknown>>(
		`SELECT * FROM ${table} WHERE effect_id LIKE 'device-removal:%' AND device_id LIKE ?
		ORDER BY effect_id`,
		`${f.prefix}%`,
	);

function registerMembershipRevocation(test: RemovalTest) {
	test("A3 a removal revokes each active membership of the device in a scope of that group, with an advanced epoch, a receipt and an audit row", async ({
		fixture: f,
	}) => {
		// Arrange: the device has an active and an already revoked membership, and a peer an active one.
		const removed = await target(f);
		const peer = await target(f, "peer");
		await enroll(f, removed);
		await enroll(f, peer);
		const active = await scope(f, "active", removed.groupId);
		const revoked = await scope(f, "revoked", removed.groupId);
		for (const deviceId of [removed.deviceId, peer.deviceId]) await grant(f, active, deviceId);
		await grant(f, revoked, removed.deviceId);
		await f.store.revokeScopeMembership({
			effectId: `${f.prefix}-earlier`,
			scopeId: revoked,
			deviceId: removed.deviceId,
		});
		const before = {
			active: await membership(f, active, removed.deviceId),
			revoked: await membership(f, revoked, removed.deviceId),
			peer: await membership(f, active, peer.deviceId),
		};
		// Act
		const seq = await remove(f, removed);
		// Assert
		const effectId = await removalEffectId(f, seq, before.active.row_id);
		const epoch = before.active.membership_epoch + 1;
		expect(await membership(f, active, removed.deviceId)).toEqual({
			...before.active,
			status: "revoked",
			membership_epoch: epoch,
			updated_at: CLOCK,
		});
		expect(await membership(f, revoked, removed.deviceId)).toEqual(before.revoked);
		expect(await membership(f, active, peer.deviceId)).toEqual(before.peer);
		expect(await removalEffects(f, "coordinator_scope_membership_effect_receipts")).toMatchObject([
			{ effect_id: effectId, action: "revoke", outcome_applied: 1, membership_epoch: epoch },
		]);
		expect(await removalEffects(f, "coordinator_scope_membership_audit_log")).toMatchObject([
			{
				effect_id: effectId,
				action: "revoke",
				status: "revoked",
				membership_epoch: epoch,
				previous_status: "active",
				previous_membership_epoch: before.active.membership_epoch,
				actor_type: "device_removal",
				actor_id: actor(f),
				created_at: CLOCK,
			},
		]);
	});
}

function registerLaterGrant(test: RemovalTest) {
	test("A3 after a removal, a grant at the old epoch grants nothing and the next epoch grants again", async ({
		fixture: f,
	}) => {
		// Arrange: the removal is lifted and the device enrolled again, as a rejoin will do.
		const device = await target(f);
		await enroll(f, device);
		const scopeId = await scope(f, "scope", device.groupId);
		const granted = await grant(f, scopeId, device.deviceId);
		await remove(f, device);
		await liftTombstones(f, device.deviceId);
		await enroll(f, device);
		const revoked = await membership(f, scopeId, device.deviceId);
		// Act
		const stale = await grant(f, scopeId, device.deviceId, granted.membership_epoch).then(
			() => "granted",
			(error: Error) => error.message,
		);
		const afterStale = await membership(f, scopeId, device.deviceId);
		const next = await grant(f, scopeId, device.deviceId);
		// Assert
		expect(stale).toBe("membershipEpoch must not move backwards.");
		expect(afterStale).toEqual(revoked);
		expect(revoked).toMatchObject({
			status: "revoked",
			membership_epoch: granted.membership_epoch + 1,
		});
		expect(next).toMatchObject({
			status: "active",
			membership_epoch: granted.membership_epoch + 2,
		});
	});
}

const without = (row: Record<string, unknown> | undefined, ...fields: string[]) =>
	Object.fromEntries(Object.entries(row ?? {}).filter(([field]) => !fields.includes(field)));

/** A caller can persist this predictable effect ID before the membership exists. */
async function reservePredictedEffect(f: RemovalFixture, deviceId: string, scopeId: string) {
	const [next] = await f.rows<{ seq: number; row_id: number }>(
		`SELECT COALESCE((SELECT seq FROM sqlite_sequence
			WHERE name = 'coordinator_device_removals'), 0) + 1 AS seq,
			COALESCE((SELECT MAX(rowid) FROM coordinator_scope_memberships), 0) + 1 AS row_id`,
	);
	if (!next) throw new Error("Missing fixture counters");
	const effectId = `device-removal:${next.seq}:${next.row_id}`;
	expect(await f.store.revokeScopeMembership({ effectId, scopeId, deviceId })).toBe(false);
	const receipt = await f.rows(
		"SELECT * FROM coordinator_scope_membership_effect_receipts WHERE effect_id = ?",
		effectId,
	);
	expect(receipt).toMatchObject([{ outcome_applied: 0 }]);
	return { ...next, effectId, receipt };
}

/** The effect names the actual removal, not just its predictable sequence. */
async function removalEffectId(f: RemovalFixture, seq: number, rowId: number) {
	const [row] = await f.rows<{ removal_id: string }>(
		"SELECT removal_id FROM coordinator_device_removals WHERE removal_seq = ?",
		seq,
	);
	if (!row) throw new Error("Missing removal tombstone");
	expect(row.removal_id).toMatch(/^[a-f0-9-]{36}$/u);
	return `device-removal:${row.removal_id}:${seq}:${rowId}`;
}

function registerRemovalEffectIsolation(test: RemovalTest) {
	test("a caller's predicted no-op receipt cannot obstruct removal, and a later removal has a distinct effect ID", async ({
		fixture: f,
	}) => {
		// Arrange: reserve the old internal ID before the membership exists.
		const device = await target(f);
		await enroll(f, device);
		const scopeId = await scope(f, "scope", device.groupId);
		const reserved = await reservePredictedEffect(f, device.deviceId, scopeId);
		await grant(f, scopeId, device.deviceId);
		const original = await membership(f, scopeId, device.deviceId);
		expect(original.row_id).toBe(reserved.row_id);
		// Act: remove, then lift, re-enroll, grant and remove again.
		const first = await remove(f, device);
		const firstId = await removalEffectId(f, first, original.row_id);
		const firstRows = await revocationRows(f, [scopeId, device.deviceId], firstId);
		await liftTombstones(f, device.deviceId);
		await enroll(f, device);
		await grant(f, scopeId, device.deviceId);
		const second = await remove(f, device);
		const secondId = await removalEffectId(f, second, original.row_id);
		const secondRows = await revocationRows(f, [scopeId, device.deviceId], secondId);
		// Assert: the prior receipt and first removal's history are unchanged.
		expect(first).toBe(reserved.seq);
		expect(secondId).not.toBe(firstId);
		expect(secondId.split(":")[1]).not.toBe(firstId.split(":")[1]);
		expect(firstRows.receipt).toMatchObject({ effect_id: firstId, outcome_applied: 1 });
		expect(secondRows.receipt).toMatchObject({ effect_id: secondId, outcome_applied: 1 });
		expect(firstRows.audit).toMatchObject({ effect_id: firstId });
		expect(secondRows.audit).toMatchObject({ effect_id: secondId });
		expect(secondRows.membership).toMatchObject({
			status: "revoked",
			membership_epoch: original.membership_epoch + 3,
		});
		expect((await revocationRows(f, [scopeId, device.deviceId], firstId)).receipt).toEqual(
			firstRows.receipt,
		);
		expect((await revocationRows(f, [scopeId, device.deviceId], firstId)).audit).toEqual(
			firstRows.audit,
		);
		expect(
			await f.rows(
				"SELECT * FROM coordinator_scope_membership_effect_receipts WHERE effect_id = ?",
				reserved.effectId,
			),
		).toEqual(reserved.receipt);
	});
}

/** The membership, and the receipt and audit row of one effect. */
async function revocationRows(
	f: RemovalFixture,
	where: readonly [string, string],
	effectId: string,
) {
	const first = async (sql: string, ...values: string[]) => (await f.rows(sql, ...values))[0];
	return {
		membership: await first(
			"SELECT * FROM coordinator_scope_memberships WHERE scope_id = ? AND device_id = ?",
			...where,
		),
		receipt: await first(
			"SELECT * FROM coordinator_scope_membership_effect_receipts WHERE effect_id = ?",
			effectId,
		),
		audit: await first(
			"SELECT * FROM coordinator_scope_membership_audit_log WHERE effect_id = ?",
			effectId,
		),
	};
}

function registerMembershipRevocationRows(test: RemovalTest) {
	test("a removal leaves the membership, receipt and audit rows that the membership revocation leaves, apart from the effect ID and the times", async ({
		fixture: f,
	}) => {
		// Arrange: one membership, revoked by the membership revocation and put back as it was.
		const device = await target(f);
		await enroll(f, device);
		const scopeId = await scope(f, "scope", device.groupId);
		await grant(f, scopeId, device.deviceId);
		const where = [scopeId, device.deviceId] as const;
		const granted = await membership(f, ...where);
		const manualEffect = `${f.prefix}-manual`;
		await f.store.revokeScopeMembership({
			effectId: manualEffect,
			scopeId,
			deviceId: device.deviceId,
			actorType: "device_removal",
			actorId: actor(f),
		});
		const manual = await revocationRows(f, where, manualEffect);
		await f.exec(
			`UPDATE coordinator_scope_memberships SET status = ?, membership_epoch = ?, updated_at = ?
			WHERE scope_id = ? AND device_id = ?`,
			granted.status,
			granted.membership_epoch,
			granted.updated_at,
			...where,
		);
		// Act
		const seq = await remove(f, device);
		const removal = await revocationRows(f, where, await removalEffectId(f, seq, granted.row_id));
		// Assert
		expect(without(removal.membership, "updated_at")).toEqual(
			without(manual.membership, "updated_at"),
		);
		expect(without(removal.receipt, "effect_id", "updated_at", "created_at")).toEqual(
			without(manual.receipt, "effect_id", "updated_at", "created_at"),
		);
		expect(without(removal.audit, "event_id", "effect_id", "created_at")).toEqual(
			without(manual.audit, "event_id", "effect_id", "created_at"),
		);
		expect(removal.receipt).toMatchObject({ updated_at: CLOCK, created_at: CLOCK });
		expect(Object.keys(removal.audit ?? {}).length).toBeGreaterThan(10);
	});
}

/** A device enrolled in two groups, with a membership in a scope of each and two elsewhere. */
async function arrangeScopesWithoutGroup(f: RemovalFixture) {
	const first = await target(f);
	const second = { ...first, groupId: `${f.prefix}-g2` };
	await enroll(f, first);
	await enroll(f, second);
	const scopes = {
		first: await scope(f, "in-first", first.groupId),
		second: await scope(f, "in-second", second.groupId),
		withoutGroup: await scope(f, "without-group", null),
		missing: await scope(f, "missing", first.groupId),
	};
	for (const scopeId of Object.values(scopes)) await grant(f, scopeId, first.deviceId);
	await f.exec("DELETE FROM coordinator_scopes WHERE scope_id = ?", scopes.missing);
	const statuses = async () => {
		const status: Record<string, string> = {};
		for (const [name, scopeId] of Object.entries(scopes))
			status[name] = `${(await membership(f, scopeId, first.deviceId)).status}`;
		return status;
	};
	return { first, second, scopes, statuses };
}

function registerScopesWithoutGroup(test: RemovalTest) {
	test("a membership in a scope without a group survives a removal that leaves the device another enrollment", async ({
		fixture: f,
	}) => {
		// Arrange
		const { first, statuses } = await arrangeScopesWithoutGroup(f);
		// Act
		await remove(f, first);
		// Assert: only the membership in the scope of the group it left is revoked.
		expect(await statuses()).toMatchObject({
			first: "revoked",
			second: "active",
			withoutGroup: "active",
		});
	});

	test("a membership in a scope without a group is revoked when the last enrollment of the device goes", async ({
		fixture: f,
	}) => {
		// Arrange
		const { first, second, scopes, statuses } = await arrangeScopesWithoutGroup(f);
		await remove(f, first);
		const before = await membership(f, scopes.withoutGroup, first.deviceId);
		// Act
		const seq = await remove(f, second);
		// Assert: revoked once, by the removal that left the device ID without an enrollment.
		expect(await statuses()).toMatchObject({ second: "revoked", withoutGroup: "revoked" });
		expect(await membership(f, scopes.withoutGroup, first.deviceId)).toMatchObject({
			membership_epoch: before.membership_epoch + 1,
		});
		expect(
			await f.rows(
				"SELECT 1 FROM coordinator_scope_membership_audit_log WHERE effect_id = ?",
				await removalEffectId(f, seq, before.row_id),
			),
		).toHaveLength(1);
	});

	test("a membership whose scope row is missing is treated as one in a scope without a group", async ({
		fixture: f,
	}) => {
		// Arrange: the scope named the first group before its row was deleted.
		const { first, second, statuses } = await arrangeScopesWithoutGroup(f);
		// Act
		await remove(f, first);
		const afterFirst = (await statuses()).missing;
		await remove(f, second);
		// Assert
		expect([afterFirst, (await statuses()).missing]).toEqual(["active", "revoked"]);
	});
}

function insertGrant(
	f: RemovalFixture,
	grant: { id: string; groupId: string; seed: string; worker: string; expiresAt?: string },
	revokedAt: string | null = null,
) {
	return f.exec(
		`INSERT INTO coordinator_bootstrap_grants(grant_id, group_id, seed_device_id,
			worker_device_id, expires_at, created_at, revoked_at)
		VALUES (?, ?, ?, ?, ?, '2026-11-01T00:00:00.000Z', ?)`,
		`${f.prefix}-${grant.id}`,
		grant.groupId,
		grant.seed,
		grant.worker,
		grant.expiresAt ?? "2099-01-01T00:00:00.000Z",
		revokedAt,
	);
}

function insertJoinRequest(
	f: RemovalFixture,
	request: { id: string; groupId: string; deviceId: string; status?: string },
) {
	return f.exec(
		`INSERT INTO coordinator_join_requests(request_id, group_id, device_id, public_key,
			fingerprint, token, status, created_at)
		VALUES (?, ?, ?, 'requested-key', 'fp', 'token', ?, '2026-11-01T00:00:00.000Z')`,
		`${f.prefix}-${request.id}`,
		request.groupId,
		request.deviceId,
		request.status ?? "pending",
	);
}

const grants = async (f: RemovalFixture) =>
	Object.fromEntries(
		(
			await f.rows<{ grant_id: string; revoked_at: string | null }>(
				"SELECT grant_id, revoked_at FROM coordinator_bootstrap_grants WHERE grant_id LIKE ?",
				`${f.prefix}-%`,
			)
		).map((row) => [row.grant_id.slice(f.prefix.length + 1), row.revoked_at]),
	);

const requests = async (f: RemovalFixture) =>
	Object.fromEntries(
		(
			await f.rows<{ request_id: string; status: string; reviewed_at: string | null }>(
				`SELECT request_id, status, reviewed_at, reviewed_by FROM coordinator_join_requests
				WHERE request_id LIKE ?`,
				`${f.prefix}-%`,
			)
		).map(({ request_id, ...row }) => [request_id.slice(f.prefix.length + 1), row]),
	);

function registerGrantRevocation(test: RemovalTest) {
	test("A4 a removal revokes the bootstrap grants that name the device in that group, expired or not", async ({
		fixture: f,
	}) => {
		// Arrange: the device stays enrolled in a second group.
		const removed = await target(f);
		const elsewhere = { ...removed, groupId: `${f.prefix}-g2` };
		const peer = `${f.prefix}-peer`;
		await enroll(f, removed);
		await enroll(f, elsewhere);
		const g1 = removed.groupId;
		const d = removed.deviceId;
		await insertGrant(f, { id: "as-seed", groupId: g1, seed: d, worker: peer });
		await insertGrant(f, { id: "as-worker", groupId: g1, seed: peer, worker: d });
		await insertGrant(f, {
			id: "expired",
			groupId: g1,
			seed: d,
			worker: peer,
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		await insertGrant(f, { id: "revoked-before", groupId: g1, seed: d, worker: peer }, "earlier");
		await insertGrant(f, { id: "other-group", groupId: elsewhere.groupId, seed: d, worker: peer });
		await insertGrant(f, { id: "other-devices", groupId: g1, seed: peer, worker: `${peer}-2` });
		// Act: the legacy removal of one group.
		const removedNow = await f.store.removeDevice(g1, d);
		// Assert
		expect(removedNow).toBe(true);
		expect(await grants(f)).toEqual({
			"as-seed": CLOCK,
			"as-worker": CLOCK,
			expired: CLOCK,
			"revoked-before": "earlier",
			"other-group": null,
			"other-devices": null,
		});
	});
}

function registerJoinRequestDenial(test: RemovalTest) {
	test("A4 a removal denies every pending join request of the device ID, in any group, and no other", async ({
		fixture: f,
	}) => {
		// Arrange
		const removed = await target(f);
		const peer = await target(f, "peer");
		await enroll(f, removed);
		await enroll(f, peer);
		const d = removed.deviceId;
		const other = `${f.prefix}-g3`;
		await insertJoinRequest(f, { id: "same-group", groupId: removed.groupId, deviceId: d });
		await insertJoinRequest(f, { id: "other-group", groupId: other, deviceId: d });
		await insertJoinRequest(f, { id: "approved", groupId: other, deviceId: d, status: "approved" });
		await insertJoinRequest(f, { id: "peer", groupId: other, deviceId: peer.deviceId });
		const pending = { status: "pending", reviewed_at: null, reviewed_by: null };
		// Act: a device that is not enrolled first, which removes and denies nothing.
		const absent = await f.store.removeEnrollment({ groupId: other, deviceId: d });
		const untouched = await requests(f);
		await remove(f, removed);
		// Assert
		const denied = { status: "denied", reviewed_at: CLOCK, reviewed_by: actor(f) };
		expect(absent).toEqual({ kind: "not_enrolled" });
		expect(untouched).toMatchObject({ "same-group": pending, "other-group": pending });
		expect(await requests(f)).toEqual({
			"same-group": denied,
			"other-group": denied,
			approved: { status: "approved", reviewed_at: null, reviewed_by: null },
			peer: pending,
		});
	});
}

/** A device with one membership, one bootstrap grant and one pending join request. */
async function arrangeDependents(f: RemovalFixture) {
	const removed = await target(f);
	await enroll(f, removed);
	const scopeId = await scope(f, "scope", removed.groupId);
	await grant(f, scopeId, removed.deviceId);
	await insertGrant(f, {
		id: "grant",
		groupId: removed.groupId,
		seed: removed.deviceId,
		worker: `${f.prefix}-peer`,
	});
	await insertJoinRequest(f, {
		id: "request",
		groupId: `${f.prefix}-g3`,
		deviceId: removed.deviceId,
	});
	const state = async () => ({
		tombstones: await f.rows(
			"SELECT 1 FROM coordinator_device_removals WHERE device_id = ?",
			removed.deviceId,
		),
		enrolled: await f.rows("SELECT 1 FROM enrolled_devices WHERE device_id = ?", removed.deviceId),
		membership: await membership(f, scopeId, removed.deviceId),
		receipts: await removalEffects(f, "coordinator_scope_membership_effect_receipts"),
		audit: await removalEffects(f, "coordinator_scope_membership_audit_log"),
		grants: await grants(f),
		requests: await requests(f),
	});
	return { removed, state };
}

function registerSuppressedDependentWrites(test: RemovalTest) {
	// A trigger that makes one write of the removal change no row without an error.
	const suppressed = {
		"membership revocation": "BEFORE UPDATE ON coordinator_scope_memberships",
		"membership receipt": "BEFORE INSERT ON coordinator_scope_membership_effect_receipts",
		"membership audit row": "BEFORE INSERT ON coordinator_scope_membership_audit_log",
		"bootstrap grant revocation": "BEFORE UPDATE ON coordinator_bootstrap_grants",
		"join request denial": "BEFORE UPDATE ON coordinator_join_requests",
	} as const;
	for (const [write, event] of Object.entries(suppressed)) {
		test(`A6 a removal whose ${write} a trigger suppresses records no tombstone and changes nothing`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { removed, state } = await arrangeDependents(f);
			const before = await state();
			await f.exec(`CREATE TRIGGER removal_fixture_ignore_write ${event}
				BEGIN SELECT RAISE(IGNORE); END`);
			try {
				// Act
				const pending = f.store.removeEnrollment({
					groupId: removed.groupId,
					deviceId: removed.deviceId,
				});
				// Assert
				await expect(pending).rejects.toThrow("device_removal_incomplete");
				expect(await state()).toEqual(before);
				expect(before).toMatchObject({
					tombstones: [],
					enrolled: [{}],
					membership: { status: "active" },
					receipts: [],
					audit: [],
					grants: { grant: null },
					requests: { request: { status: "pending" } },
				});
			} finally {
				await f.exec("DROP TRIGGER IF EXISTS removal_fixture_ignore_write");
			}
		});
	}
}
