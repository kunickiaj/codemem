import { expect, it } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	MALFORMED_KEYS,
	NODE_ONLY_ALIASES,
} from "./coordinator-ed25519-key-id-test-fixtures.js";

export type RevocationFixture = {
	store: Store;
	input: {
		groupId: string;
		deviceId: string;
		publicKey: string;
		fingerprint: string;
		actorId: string;
	};
	exec: (sql: string, ...values: unknown[]) => Promise<void>;
	rows: (table: string) => Promise<unknown[]>;
};
export const revocationSideEffectTables = [
	"groups",
	"enrolled_devices",
	"coordinator_identity_group_grants",
	"coordinator_auth_controller_attestations",
	"coordinator_auth_account_links",
	"coordinator_auth_sessions",
	"coordinator_auth_session_receipts",
	"coordinator_scopes",
	"coordinator_scope_memberships",
	"coordinator_scope_membership_audit_log",
	"coordinator_legacy_team_completions",
];
export function revocationHarness(
	fixture: (use: (f: RevocationFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: RevocationFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
export function revocationInput(prefix = "revoke") {
	return {
		groupId: `${prefix}-group`,
		deviceId: `${prefix}-device`,
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "a".repeat(64),
		actorId: `${prefix}-operator`,
	};
}
export async function enrollRevocation(f: RevocationFixture) {
	await f.store.createGroup(f.input.groupId);
	await f.store.enrollDevice(f.input.groupId, f.input);
}
export function nonceInput(f: RevocationFixture, nonce = "nonce-a") {
	return {
		groupId: f.input.groupId,
		deviceId: f.input.deviceId,
		publicKey: f.input.publicKey,
		nonce,
		createdAt: "2026-10-06T00:00:00.000Z",
	};
}
const aliases = [...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES];
export function registerDeviceRevocationContract(test: ReturnType<typeof revocationHarness>) {
	registerCreation(test);
	registerInputValidation(test);
	registerLifecycle(test);
	registerNonRevokingChanges(test);
	registerAliases(test);
	registerQueries(test);
	registerNamespaceIsolation(test);
	registerUnrelatedDevice(test);
	registerNonceSuccess(test);
	registerNonceState(test);
	registerMalformedEdAdmission(test);
	registerOverlappingSubjects(test);
	registerLegacyLongIds(test);
}
type RevocationTest = ReturnType<typeof revocationHarness>;
function registerLegacyLongIds(test: RevocationTest) {
	test("admits registered legacy group and device IDs longer than 256 characters without expanding revocation creation", async ({
		fixture: f,
	}) => {
		// Arrange: legacy registration accepts exact long IDs, unlike revocation creation.
		f.input.groupId = `${f.input.groupId}-${"g".repeat(257)}`;
		f.input.deviceId = `${f.input.deviceId}-${"d".repeat(257)}`;
		await enrollRevocation(f);
		// Act
		const admission = await f.store.recordAuthorizedNonce(nonceInput(f));
		const revocation = await f.store.createDeviceRevocation(f.input);
		// Assert
		expect(admission).toBe("recorded");
		expect(await f.rows("request_nonces")).toHaveLength(1);
		expect(revocation).toEqual({ kind: "rejected", error: "invalid_input" });
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});
	test("a registered long-ID alias cannot bypass a canonical-key revocation", async ({
		fixture: f,
	}) => {
		// Arrange: register the historical alias before revoking its shared key.
		await enrollRevocation(f);
		const alias = {
			...f.input,
			groupId: `${f.input.groupId}-${"g".repeat(257)}`,
			deviceId: `${f.input.deviceId}-${"d".repeat(257)}`,
		};
		await f.store.createGroup(alias.groupId);
		await f.store.enrollDevice(alias.groupId, alias);
		await f.store.createDeviceRevocation(f.input);
		const before = await f.rows("coordinator_device_revocations");
		// Act: exact known enrollment does not narrow global canonical-key denial.
		const admission = await f.store.recordAuthorizedNonce({ ...nonceInput(f), ...alias });
		// Assert
		expect(admission).toBe("device_revoked");
		expect(await f.rows("request_nonces")).toEqual([]);
		expect(await f.rows("coordinator_device_revocations")).toEqual(before);
		expect(await f.store.listDeviceRevocations({ publicKey: alias.publicKey })).toMatchObject([
			{ subject_kind: "ed25519_key", subject_value: EXPECTED_KEY_ID },
		]);
	});
}
function registerMalformedEdAdmission(test: RevocationTest) {
	for (const malformed of MALFORMED_KEYS) {
		test(`direct nonce admission rejects malformed Ed25519 ${malformed.name} without consuming a nonce`, async ({
			fixture: f,
		}) => {
			// Arrange: only disposable metadata bypasses the normal signature verifier.
			f.input.publicKey = malformed.publicKey;
			await enrollRevocation(f);
			// Act
			const admission = await f.store.recordAuthorizedNonce(nonceInput(f));
			// Assert: a failed Ed25519 parse must not take the opaque-key fallback.
			expect(admission).toBe("unknown_device");
			expect(await f.rows("request_nonces")).toEqual([]);
		});
	}
	test("direct nonce admission still accepts an opaque legacy fixture key", async ({
		fixture: f,
	}) => {
		// Arrange: pk1 is fixture evidence, never a real-verifier credential.
		f.input.publicKey = "pk1";
		await enrollRevocation(f);
		// Act
		const admission = await f.store.recordAuthorizedNonce(nonceInput(f));
		// Assert
		expect(admission).toBe("recorded");
		expect(await f.rows("request_nonces")).toHaveLength(1);
	});
}
function registerOverlappingSubjects(test: RevocationTest) {
	test("revoking a new device alias preserves the old key action and gives only the new ID a new action", async ({
		fixture: f,
	}) => {
		// Arrange: both aliases exist before the first global key revocation.
		await enrollRevocation(f);
		const alias = {
			...f.input,
			deviceId: `${f.input.deviceId}-alias`,
			publicKey: `${f.input.publicKey} second-device-comment`,
			actorId: "second-operator",
		};
		await f.store.enrollDevice(alias.groupId, alias);
		await f.store.createDeviceRevocation(f.input);
		const first = await f.store.listDeviceRevocations(f.input);
		const oldKey = first.find((record) => record.subject_kind === "ed25519_key");
		// Act
		const result = await f.store.createDeviceRevocation(alias);
		const records = await f.store.listDeviceRevocations(alias);
		const beforeRetry = await f.rows("coordinator_device_revocations");
		const retry = await f.store.createDeviceRevocation({ ...alias, actorId: "retry-operator" });
		// Assert: overlapping subjects never overwrite retained action IDs or evidence.
		expect(result).toEqual({ kind: "revoked", records });
		expect(records).toHaveLength(2);
		expect(records.find((record) => record.subject_kind === "ed25519_key")).toEqual(oldKey);
		const newDevice = records.find((record) => record.subject_kind === "device_id");
		expect(newDevice).toMatchObject({
			subject_value: alias.deviceId,
			evidence_public_key: alias.publicKey,
			actor_id: alias.actorId,
		});
		expect(newDevice?.revocation_id).not.toBe(oldKey?.revocation_id);
		expect(newDevice?.created_at).not.toBe(oldKey?.created_at);
		expect(await f.store.listDeviceRevocations(f.input)).toEqual(first);
		expect(retry).toEqual(result);
		expect(await f.rows("coordinator_device_revocations")).toEqual(beforeRetry);
		expect(beforeRetry).toHaveLength(3);
	});
}
function registerUnrelatedDevice(test: RevocationTest) {
	test("a tombstone does not deny an unrelated enrolled ID and key", async ({ fixture: f }) => {
		// Arrange
		await enrollRevocation(f);
		await f.store.createDeviceRevocation(f.input);
		const other = {
			...f.input,
			deviceId: `${f.input.deviceId}-unrelated`,
			publicKey: "unrelated-fixture-key",
		};
		await f.store.enrollDevice(other.groupId, other);
		// Act
		const result = await f.store.recordAuthorizedNonce({ ...nonceInput(f), ...other });
		// Assert
		expect(result).toBe("recorded");
		expect(await f.store.listDeviceRevocations(other)).toEqual([]);
		expect(await f.rows("request_nonces")).toHaveLength(1);
	});
}
function registerCreation(test: RevocationTest) {
	test("creates two global subjects atomically without changing any human or group authority", async ({
		fixture: f,
	}) => {
		// Arrange: the legacy fingerprint is evidence, not canonical ownership proof.
		await enrollRevocation(f);
		const before = await Promise.all(revocationSideEffectTables.map(f.rows));
		// Act
		const result = await f.store.createDeviceRevocation(f.input);
		// Assert
		expect(result).toMatchObject({ kind: "revoked" });
		const records = await f.store.listDeviceRevocations({
			deviceId: f.input.deviceId,
			publicKey: f.input.publicKey,
		});
		expect(records).toHaveLength(2);
		expect(records[0]?.revocation_id).toBeTypeOf("string");
		expect(records[0]?.revocation_id).toBe(records[1]?.revocation_id);
		expect(records[0]?.created_at).toBe(records[1]?.created_at);
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					subject_kind: "device_id",
					subject_value: f.input.deviceId,
					evidence_public_key: f.input.publicKey,
					evidence_fingerprint: f.input.fingerprint,
					actor_id: f.input.actorId,
				}),
				expect.objectContaining({ subject_kind: "ed25519_key", subject_value: EXPECTED_KEY_ID }),
			]),
		);
		expect(await Promise.all(revocationSideEffectTables.map(f.rows))).toEqual(before);
	});
}
function registerInputValidation(test: RevocationTest) {
	for (const field of ["groupId", "deviceId", "publicKey", "fingerprint"] as const) {
		test(`rejects a mismatched current ${field} without creating any subject`, async ({
			fixture: f,
		}) => {
			// Arrange
			await enrollRevocation(f);
			const input = { ...f.input, [field]: `${f.input[field]}-other` };
			// Act
			const result = await f.store.createDeviceRevocation(input);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
			expect(await f.rows("coordinator_device_revocations")).toEqual([]);
		});
	}
	for (const field of ["groupId", "deviceId", "publicKey", "fingerprint"] as const) {
		test(`rejects an empty ${field} before mutation`, async ({ fixture: f }) => {
			// Arrange
			await enrollRevocation(f);
			// Act
			const result = await f.store.createDeviceRevocation({ ...f.input, [field]: "" });
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
			expect(await f.rows("coordinator_device_revocations")).toEqual([]);
		});
	}
	test("requires exact raw public-key evidence even for a canonical alias", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		// Act
		const result = await f.store.createDeviceRevocation({
			...f.input,
			publicKey: `${f.input.publicKey} comment`,
		});
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});
}
function registerLifecycle(test: RevocationTest) {
	test("allows a disabled current enrollment and preserves first records on exact retry", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		await f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, false);
		const first = await f.store.createDeviceRevocation(f.input);
		const before = await f.rows("coordinator_device_revocations");
		// Act
		const retry = await f.store.createDeviceRevocation({
			...f.input,
			actorId: "different-operator",
		});
		// Assert: IDs, actor and timestamps cannot change on retry.
		expect(retry).toEqual(first);
		expect(await f.rows("coordinator_device_revocations")).toEqual(before);
	});
	test("retains tombstones after removal but rejects new revocation without current evidence", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		await f.store.createDeviceRevocation(f.input);
		const before = await f.store.listDeviceRevocations({ deviceId: f.input.deviceId });
		await f.store.removeDevice(f.input.groupId, f.input.deviceId);
		// Act
		const retry = await f.store.createDeviceRevocation(f.input);
		// Assert
		expect(retry).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
		expect(await f.store.listDeviceRevocations({ deviceId: f.input.deviceId })).toEqual(before);
	});
}
function registerNonRevokingChanges(test: RevocationTest) {
	test("opaque fixture keys create only a device ID tombstone", async ({ fixture: f }) => {
		// Arrange: fake key strings are never used with a real signature verifier.
		f.input.publicKey = "opaque-fixture-key";
		await enrollRevocation(f);
		// Act
		await f.store.createDeviceRevocation(f.input);
		// Assert
		expect(await f.store.listDeviceRevocations({ deviceId: f.input.deviceId })).toMatchObject([
			{ subject_kind: "device_id", subject_value: f.input.deviceId },
		]);
		expect(await f.store.listDeviceRevocations({ publicKey: f.input.publicKey })).toEqual([]);
	});
	for (const action of ["disable", "archive", "remove"] as const) {
		test(`${action} does not implicitly create global revocations`, async ({ fixture: f }) => {
			// Arrange
			await enrollRevocation(f);
			// Act
			if (action === "disable")
				await f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, false);
			if (action === "archive") await f.store.archiveGroup(f.input.groupId);
			if (action === "remove") await f.store.removeDevice(f.input.groupId, f.input.deviceId);
			// Assert
			expect(await f.rows("coordinator_device_revocations")).toEqual([]);
		});
	}
}
function registerAliases(test: RevocationTest) {
	for (const alias of aliases) {
		test(`finds and denies the global key subject through ${alias.name}`, async ({
			fixture: f,
		}) => {
			// Arrange: historical aliases exist before their canonical key is revoked.
			await enrollRevocation(f);
			const other = {
				...f.input,
				groupId: `${f.input.groupId}-other`,
				deviceId: `${f.input.deviceId}-other`,
				publicKey: alias.publicKey,
			};
			await f.store.createGroup(other.groupId);
			await f.store.enrollDevice(other.groupId, other);
			await f.store.createDeviceRevocation(f.input);
			// Act: neither a different group nor a new ID narrows the database-wide query.
			const records = await f.store.listDeviceRevocations({
				deviceId: other.deviceId,
				publicKey: alias.publicKey,
			});
			const admission = await f.store.recordAuthorizedNonce({ ...nonceInput(f), ...other });
			// Assert
			expect(records).toMatchObject([
				{ subject_kind: "ed25519_key", subject_value: EXPECTED_KEY_ID },
			]);
			expect(admission).toBe("device_revoked");
			expect(await f.rows("request_nonces")).toEqual([]);
		});
	}
}
function registerQueries(test: RevocationTest) {
	test("uses ID OR key queries, returns stable sorted records, and never lists all on empty input", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		await f.store.createDeviceRevocation(f.input);
		// Act
		const records = await f.store.listDeviceRevocations({
			deviceId: f.input.deviceId,
			publicKey: "unrelated-key",
		});
		// Assert
		expect(records).toMatchObject([{ subject_kind: "device_id", subject_value: f.input.deviceId }]);
		const keyRecords = await f.store.listDeviceRevocations({
			deviceId: "unrelated-device",
			publicKey: f.input.publicKey,
		});
		expect(keyRecords).toMatchObject([
			{ subject_kind: "ed25519_key", subject_value: EXPECTED_KEY_ID },
		]);
		const both = await f.store.listDeviceRevocations(f.input);
		expect(both).toHaveLength(2);
		expect(both.map((r) => `${r.subject_kind}:${r.subject_value}`)).toEqual(
			both.map((r) => `${r.subject_kind}:${r.subject_value}`).sort(),
		);
		await expect(f.store.listDeviceRevocations({})).rejects.toThrow("invalid_input");
		expect(
			await f.store.listDeviceRevocations({
				deviceId: "unrelated-device",
				publicKey: "unrelated-key",
			}),
		).toEqual([]);
	});
}
function registerNamespaceIsolation(test: RevocationTest) {
	test("two coordinator identity namespaces share revocations without changing either grant", async ({
		fixture: f,
	}) => {
		// Arrange: coordinator labels scope human identity, never revocation subjects.
		await enrollRevocation(f);
		for (const suffix of ["a", "b"]) {
			const review = {
				...f.input,
				coordinatorId: `coordinator-${suffix}`,
				identityId: `identity-${suffix}`,
				attestationId: `attestation-${suffix}`,
				reviewReceiptId: `receipt-${suffix}`,
				evidenceDigest: "b".repeat(64),
			};
			expect(await f.store.createAuthControllerAttestation(review)).toMatchObject({
				kind: "created",
			});
			expect(await f.store.issueIdentityGroupGrantFromControllerAttestation(review)).toMatchObject({
				kind: "created",
			});
		}
		const before = await Promise.all(revocationSideEffectTables.map(f.rows));
		await f.store.createDeviceRevocation(f.input);
		// Act: extra caller labels cannot narrow the database-wide key/ID match.
		const query = {
			deviceId: f.input.deviceId,
			publicKey: f.input.publicKey,
			coordinatorId: "coordinator-b",
			groupId: "unrelated-group",
		};
		const result = await f.store.listDeviceRevocations(query);
		// Assert
		expect(result).toHaveLength(2);
		expect(await Promise.all(revocationSideEffectTables.map(f.rows))).toEqual(before);
		const labeledNonce = { ...nonceInput(f), coordinatorId: query.coordinatorId };
		expect(await f.store.recordAuthorizedNonce(labeledNonce)).toBe("device_revoked");
	});
}
function registerNonceSuccess(test: RevocationTest) {
	test("records eligible nonces, rejects exact replay, and accepts a fresh nonce", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		const input = nonceInput(f);
		// Act
		const results = [
			await f.store.recordAuthorizedNonce(input),
			await f.store.recordAuthorizedNonce(input),
			await f.store.recordAuthorizedNonce({ ...input, nonce: "nonce-b" }),
		];
		// Assert
		expect(results).toEqual(["recorded", "nonce_replay", "recorded"]);
		expect(await f.rows("request_nonces")).toHaveLength(2);
	});
	test("rejects a revoked device ID even after the current key changes", async ({ fixture: f }) => {
		// Arrange
		await enrollRevocation(f);
		await f.store.createDeviceRevocation(f.input);
		await f.exec(
			"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
			"new-fixture-key",
			f.input.groupId,
			f.input.deviceId,
		);
		// Act
		const result = await f.store.recordAuthorizedNonce({
			...nonceInput(f),
			publicKey: "new-fixture-key",
		});
		// Assert
		expect(result).toBe("device_revoked");
		expect(await f.rows("request_nonces")).toEqual([]);
	});
	test("revocation after successful nonce insertion does not retroactively cancel admitted work", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		const admitted = await f.store.recordAuthorizedNonce(nonceInput(f));
		// Act
		await f.store.createDeviceRevocation(f.input);
		const next = await f.store.recordAuthorizedNonce(nonceInput(f, "nonce-after"));
		// Assert
		expect(admitted).toBe("recorded");
		expect(next).toBe("device_revoked");
		expect(await f.rows("request_nonces")).toHaveLength(1);
	});
}
function registerNonceState(test: RevocationTest) {
	const changes = [
		{
			name: "changed key",
			sql: "UPDATE enrolled_devices SET public_key = 'different-key'",
			status: "unknown_device",
		},
		{
			name: "disabled device",
			sql: "UPDATE enrolled_devices SET enabled = 0",
			status: "device_disabled",
		},
		{ name: "removed device", sql: "DELETE FROM enrolled_devices", status: "unknown_device" },
		{
			name: "archived group",
			sql: "UPDATE groups SET archived_at = '2026-10-06T00:00:00.000Z'",
			status: "group_archived",
		},
		{ name: "removed group", sql: "DELETE FROM groups", status: "group_not_found" },
	];
	for (const change of changes) {
		test(`rejects ${change.name} at nonce insertion with no consumed nonce`, async ({
			fixture: f,
		}) => {
			// Arrange
			await enrollRevocation(f);
			// SQL fixtures contain only this test's disposable rows.
			await f.exec(
				`${change.sql} WHERE ${change.sql.includes("groups") ? "group_id" : "device_id"} = ?`,
				change.sql.includes("groups") ? f.input.groupId : f.input.deviceId,
			);
			// Act
			const result = await f.store.recordAuthorizedNonce(nonceInput(f));
			// Assert
			expect(result).toBe(change.status);
			expect(await f.rows("request_nonces")).toEqual([]);
		});
	}
}
