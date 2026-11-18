import { expect } from "vitest";
import {
	type Enrollment,
	enroll,
	insertTombstone,
	liftTombstones,
	opaqueKey,
	type RemovalChange,
	type RemovalFixture,
	type RemovalTest,
	target,
} from "./coordinator-device-removal-test-harness.js";
import {
	changeEnrollmentKey,
	deleteEnrollmentWithoutTombstone,
	seedEnrollment,
} from "./coordinator-enrollment-test-fixtures.js";

const TABLES = [
	"coordinator_device_removals",
	"enrolled_devices",
	"presence_records",
	"coordinator_reciprocal_approvals",
	"coordinator_scope_memberships",
	"coordinator_scope_membership_effect_receipts",
	"coordinator_scope_membership_audit_log",
	"coordinator_bootstrap_grants",
	"coordinator_join_requests",
];
const snapshot = (f: RemovalFixture) =>
	Promise.all(TABLES.map((table) => f.rows(`SELECT * FROM ${table} ORDER BY rowid`)));
const ids = (device: Enrollment) => ({ deviceIds: [device.deviceId] });
async function preview(f: RemovalFixture, device: Enrollment) {
	const result = await f.store.previewDeviceRemoval(ids(device));
	if (result.kind !== "ready") throw new Error(result.error);
	return { ...ids(device), expectedDigest: result.expected_digest };
}
const seed = (f: RemovalFixture, device: Enrollment) =>
	seedEnrollment(f.exec, {
		groupId: device.groupId,
		deviceId: device.deviceId,
		...device.key,
	});

export function registerDeviceRemovalCommitContract(test: RemovalTest) {
	registerCommitSuccess(test);
	registerOpaqueCommit(test);
	registerCommitLimit(test);
	registerCommitDrift(test);
	registerCommitSuppression(test);
	registerCommitValidation(test);
}

/** One membership, presence, reciprocal approval, grant and join request per target. */
async function dependents(f: RemovalFixture, device: Enrollment) {
	const scopeId = `${device.groupId}-${device.deviceId}-scope`;
	await f.store.createGroup(device.groupId);
	await f.store.createScope({ scopeId, label: "Removal", groupId: device.groupId });
	await f.store.grantScopeMembership({
		effectId: `${scopeId}-grant`,
		scopeId,
		deviceId: device.deviceId,
	});
	await f.store.upsertPresence({
		groupId: device.groupId,
		deviceId: device.deviceId,
		addresses: ["http://127.0.0.1:9000"],
		ttlS: 300,
	});
	await f.store.createReciprocalApproval({
		groupId: device.groupId,
		requestingDeviceId: device.deviceId,
		requestedDeviceId: `${f.prefix}-peer`,
	});
	await f.exec(
		`INSERT INTO coordinator_bootstrap_grants
		(grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at)
		VALUES (?, ?, ?, ?, '2020-01-01T00:00:00Z', 'then')`,
		scopeId,
		device.groupId,
		device.deviceId,
		`${f.prefix}-peer`,
	);
	await f.exec(
		`INSERT INTO coordinator_join_requests
		(request_id, group_id, device_id, public_key, fingerprint, token, status, created_at)
		VALUES (?, ?, ?, ?, ?, 'token', 'pending', 'then')`,
		scopeId,
		`${f.prefix}-other`,
		device.deviceId,
		device.key.publicKey,
		device.key.fingerprint,
	);
	return scopeId;
}

async function successFixture(f: RemovalFixture) {
	const first = await target(f, "named");
	const second = { ...first, groupId: `${f.prefix}-g2` };
	const alias = { ...first, deviceId: `${f.prefix}-alias` };
	const surviving = await target(f, "alias", "g3");
	for (const row of [first, second, alias, surviving]) await seed(f, row);
	await f.store.removeDevice(alias.groupId, alias.deviceId);
	await liftTombstones(f, alias.deviceId);
	await seed(f, alias);
	const scopes = [];
	for (const row of [first, second, alias]) scopes.push(await dependents(f, row));
	await f.store.setDeviceEnabled(first.groupId, first.deviceId, false);
	await f.store.archiveGroup(second.groupId);
	await insertTombstone(f, await target(f, "old", "old-group"));
	const old = await f.rows("SELECT * FROM coordinator_device_removals");
	return { first, second, alias, surviving, scopes, old };
}

function registerCommitSuccess(test: RemovalTest) {
	test("A1 A2 A4 A7 A14 a commit removes the expanded set and all seven effects, excluding unrelated tombstones", async ({
		fixture: f,
	}) => {
		const { first, second, alias, surviving, scopes, old } = await successFixture(f);
		const request = await preview(f, first);
		const result = await f.store.removeDeviceEnrollments({
			...request,
			actorId: `${f.prefix}-operator`,
		});
		expect(result).toMatchObject({
			kind: "removed",
			device_ids: [first.deviceId],
			key_id: first.key.keyId,
			removal_id: expect.stringMatching(/^[a-f0-9-]{36}$/u),
		});
		if (result.kind !== "removed") throw new Error(result.error);
		expect(result.removals.map(({ group_id, device_id }) => [group_id, device_id])).toEqual([
			[alias.groupId, alias.deviceId],
			[first.groupId, first.deviceId],
			[second.groupId, second.deviceId],
		]);
		expect(result.removal_seq).toBe(Math.max(...result.removals.map((row) => row.removal_seq)));
		expect(new Set(result.removals.map((row) => row.removal_seq)).size).toBe(3);
		await assertEffects(f, result.removal_id, scopes);
		expect(
			await f.rows(
				"SELECT device_id, group_id FROM enrolled_devices WHERE device_id LIKE ?",
				`${f.prefix}%`,
			),
		).toEqual([{ device_id: surviving.deviceId, group_id: surviving.groupId }]);
		expect(
			await f.rows(
				"SELECT * FROM coordinator_device_removals WHERE removal_id <> ?",
				result.removal_id,
			),
		).toEqual(old);
		const tombstones = await f.rows(
			"SELECT public_key, fingerprint, key_id FROM coordinator_device_removals WHERE removal_id = ?",
			result.removal_id,
		);
		expect(tombstones).toEqual(
			[first, second, alias].map(({ key }) => ({
				public_key: key.publicKey,
				fingerprint: key.fingerprint,
				key_id: key.keyId,
			})),
		);
	});
}

function registerOpaqueCommit(test: RemovalTest) {
	test("A8 an opaque-key commit removes only named IDs and records null key IDs", async ({
		fixture: f,
	}) => {
		const first = { ...(await target(f)), key: opaqueKey("same text") };
		const other = { ...first, deviceId: `${f.prefix}-other` };
		await seed(f, first);
		await seed(f, other);
		const result = await f.store.removeDeviceEnrollments(await preview(f, first));
		expect(result).toMatchObject({
			kind: "removed",
			key_id: null,
			removals: [{ device_id: first.deviceId }],
		});
		expect(
			await f.rows(
				"SELECT key_id FROM coordinator_device_removals WHERE device_id = ?",
				first.deviceId,
			),
		).toEqual([{ key_id: null }]);
		expect(await f.store.getEnrollment(other.groupId, other.deviceId)).not.toBeNull();
	});
}

function registerCommitLimit(test: RemovalTest) {
	test("a 50-enrollment commit returns exactly the expanded set in deterministic order", async ({
		fixture: f,
	}) => {
		const device = await target(f);
		const rows = Array.from({ length: 50 }, (_, i) => ({
			...device,
			groupId: `${f.prefix}-g${String(i).padStart(2, "0")}`,
			deviceId: `${f.prefix}-d${i % 2}`,
		}));
		for (const row of rows) await seed(f, row);
		const deviceIds = [`${f.prefix}-d1`, `${f.prefix}-absent`, `${f.prefix}-d0`, `${f.prefix}-d1`];
		const ready = await f.store.previewDeviceRemoval({ deviceIds });
		if (ready.kind !== "ready") throw new Error(ready.error);
		const result = await f.store.removeDeviceEnrollments({
			deviceIds,
			expectedDigest: ready.expected_digest,
		});
		expect(result).toMatchObject({ kind: "removed", device_ids: [...new Set(deviceIds)].sort() });
		if (result.kind !== "removed") throw new Error(result.error);
		expect(result.removals.map(({ group_id, device_id }) => [group_id, device_id])).toEqual(
			rows.map((row) => [row.groupId, row.deviceId]),
		);
		expect(result.removal_seq).toBe(Math.max(...result.removals.map((row) => row.removal_seq)));
		expect(new Set(result.removals.map((row) => row.removal_seq)).size).toBe(50);
	});
	test("a target that grows beyond the UTF-8 tuple bound after preview is stale and writes nothing", async ({
		fixture: f,
	}) => {
		const device = { ...(await target(f)), key: opaqueKey("é".repeat(260_000)) };
		await seed(f, device);
		const request = await preview(f, device);
		await seed(f, { ...device, groupId: `${f.prefix}-g2` });
		const before = await snapshot(f);
		expect(await f.store.removeDeviceEnrollments(request)).toEqual({
			kind: "rejected",
			error: "removal_preview_stale",
		});
		expect(await snapshot(f)).toEqual(before);
	});
}

async function assertEffects(f: RemovalFixture, removalId: string, scopes: string[]) {
	for (const scopeId of scopes) {
		expect(
			await f.rows(
				"SELECT status, membership_epoch FROM coordinator_scope_memberships WHERE scope_id = ?",
				scopeId,
			),
		).toEqual([{ status: "revoked", membership_epoch: 1 }]);
		for (const table of [
			"coordinator_scope_membership_effect_receipts",
			"coordinator_scope_membership_audit_log",
		])
			expect(
				await f.rows(
					`SELECT effect_id FROM ${table} WHERE scope_id = ? AND action = 'revoke'`,
					scopeId,
				),
			).toEqual([{ effect_id: expect.stringContaining(`device-removal:${removalId}:`) }]);
		expect(
			await f.rows(
				"SELECT revoked_at FROM coordinator_bootstrap_grants WHERE grant_id = ?",
				scopeId,
			),
		).toEqual([{ revoked_at: expect.any(String) }]);
		expect(
			await f.rows("SELECT status FROM coordinator_join_requests WHERE request_id = ?", scopeId),
		).toEqual([{ status: "denied" }]);
	}
	expect(
		await f.rows("SELECT 1 FROM presence_records WHERE device_id LIKE ?", `${f.prefix}%`),
	).toEqual([]);
	expect(
		await f.rows(
			"SELECT 1 FROM coordinator_reciprocal_approvals WHERE requesting_device_id LIKE ?",
			`${f.prefix}%`,
		),
	).toEqual([]);
}

type Drift = "disappears" | "key changes" | "conflicting keys" | "alias appears" | "alias makes 51";
async function driftFixture(f: RemovalFixture, change: Drift) {
	const device = await target(f);
	await seed(f, device);
	const count = change === "alias makes 51" ? 50 : 2;
	if (change === "alias makes 51" || change === "conflicting keys")
		for (let i = 1; i < count; i++) await seed(f, { ...device, groupId: `${f.prefix}-g${i + 1}` });
	const request = await preview(f, device);
	const mutate: RemovalChange = (db) => {
		if (change === "disappears")
			return deleteEnrollmentWithoutTombstone(db, "device_id = ?", device.deviceId);
		if (change === "key changes" || change === "conflicting keys")
			return changeEnrollmentKey(
				db,
				opaqueKey("changed"),
				"device_id = ? AND group_id = ?",
				device.deviceId,
				device.groupId,
			);
		return seedEnrollment(db, {
			groupId: device.groupId,
			deviceId: `${f.prefix}-new-alias`,
			...device.key,
		});
	};
	return { request, mutate };
}

function registerCommitDrift(test: RemovalTest) {
	for (const boundary of ["after preview", "inside first write"] as const) {
		for (const change of [
			"disappears",
			"key changes",
			"conflicting keys",
			"alias appears",
			"alias makes 51",
		] as const) {
			test(`A5 A15 ${change} ${boundary} returns removal_preview_stale without removal writes`, async ({
				fixture: f,
			}) => {
				const { request, mutate } = await driftFixture(f, change);
				let store = f.store;
				if (boundary === "after preview") {
					await mutate(f.exec);
				} else {
					store = f.interleave(["INSERT INTO coordinator_device_removals"], mutate);
				}
				const before = await snapshot(f);
				const result = await store.removeDeviceEnrollments(request);
				expect(result).toEqual({ kind: "rejected", error: "removal_preview_stale" });
				const after = await snapshot(f);
				if (boundary === "after preview") expect(after).toEqual(before);
				else expect(after.filter((_, i) => i !== 1)).toEqual(before.filter((_, i) => i !== 1));
			});
		}
	}
}

const SUPPRESS = {
	"all tombstones": "BEFORE INSERT ON coordinator_device_removals",
	"one tombstone": "BEFORE INSERT ON coordinator_device_removals WHEN NEW.device_id LIKE '%-alias'",
	presence: "BEFORE DELETE ON presence_records",
	approval: "BEFORE DELETE ON coordinator_reciprocal_approvals",
	enrollment: "BEFORE DELETE ON enrolled_devices",
	receipt: "BEFORE INSERT ON coordinator_scope_membership_effect_receipts",
	audit: "BEFORE INSERT ON coordinator_scope_membership_audit_log",
	membership: "BEFORE UPDATE ON coordinator_scope_memberships",
	grant: "BEFORE UPDATE ON coordinator_bootstrap_grants",
	request: "BEFORE UPDATE ON coordinator_join_requests",
};
function registerCommitSuppression(test: RemovalTest) {
	for (const [name, event] of Object.entries(SUPPRESS)) {
		test(`A6 suppressed ${name} aborts the entire multi-enrollment removal with incomplete`, async ({
			fixture: f,
		}) => {
			const device = await target(f);
			const alias = { ...device, deviceId: `${f.prefix}-alias` };
			for (const row of [device, alias]) {
				await enroll(f, row);
				await dependents(f, row);
			}
			const request = await preview(f, device);
			const before = await snapshot(f);
			await f.exec(`CREATE TRIGGER commit_ignore ${event} BEGIN SELECT RAISE(IGNORE); END`);
			try {
				await expect(f.store.removeDeviceEnrollments(request)).rejects.toThrow(
					"device_removal_incomplete",
				);
				expect(await snapshot(f)).toEqual(before);
			} finally {
				await f.exec("DROP TRIGGER commit_ignore");
			}
		});
	}
	test("A6 an audit statement failure rolls back all writes of the multi-enrollment removal", async ({
		fixture: f,
	}) => {
		const device = await target(f);
		await enroll(f, device);
		await dependents(f, device);
		const request = await preview(f, device);
		const before = await snapshot(f);
		await f.exec(`CREATE TRIGGER commit_fail BEFORE INSERT ON coordinator_scope_membership_audit_log
			BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
		try {
			await expect(f.store.removeDeviceEnrollments(request)).rejects.toThrow(
				"device_removal_incomplete",
			);
			expect(await snapshot(f)).toEqual(before);
		} finally {
			await f.exec("DROP TRIGGER commit_fail");
		}
	});
}

function registerCommitValidation(test: RemovalTest) {
	test("A16 commit readiness takes precedence over a stale digest, including drift before the first write", async ({
		fixture: f,
	}) => {
		const device = await target(f);
		await seed(f, device);
		const request = await preview(f, device);
		const store = f.interleave(["INSERT INTO coordinator_device_removals"], () =>
			f.exec("UPDATE enrolled_devices SET key_id = NULL WHERE device_id = ?", device.deviceId),
		);
		await expect(store.removeDeviceEnrollments(request)).rejects.toThrow(
			"device_removal_unavailable",
		);
		await f.exec("UPDATE enrolled_devices SET key_id = NULL WHERE device_id = ?", device.deviceId);
		await expect(
			f.store.removeDeviceEnrollments({ ...request, expectedDigest: "0".repeat(64) }),
		).rejects.toThrow("device_removal_unavailable");
	});
	test("commit rejects invalid digest syntax before reading or writing", async ({ fixture: f }) => {
		for (const expectedDigest of ["", "z".repeat(64), "a".repeat(63), null])
			await expect(
				f.store.removeDeviceEnrollments({
					deviceIds: [`${f.prefix}-absent`],
					expectedDigest: expectedDigest as string,
				}),
			).rejects.toThrow("invalid_input");
	});
}
