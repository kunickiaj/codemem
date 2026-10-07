import { expect } from "vitest";
import {
	AUTH_CONTROLLER_ACTIVE_SQL,
	AUTH_CONTROLLER_INSERT_SQL,
	AUTH_CONTROLLER_RETRY_ACTIVE_SQL,
	type CoordinatorAuthControllerReviewInput,
} from "./coordinator-auth-controller.js";
import { review } from "./coordinator-auth-store-test-fixtures.js";
import {
	enrollRevocation,
	type RevocationFixture,
	type revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

type ControllerTest = ReturnType<typeof revocationHarness>;
type Gate = (query: string) => Promise<void>;
type Guarded = (f: RevocationFixture, gate: Gate) => D1CoordinatorStore;
export const controllerTables = [
	"enrolled_devices",
	"coordinator_invites",
	"coordinator_device_revocations",
	"coordinator_auth_controller_attestations",
	"coordinator_identity_group_grants",
	"coordinator_auth_account_links",
	"coordinator_auth_sessions",
	"coordinator_auth_session_receipts",
];

function controllerReview(f: RevocationFixture, snapshot = false) {
	const input = review({
		...f.input,
		coordinatorId: `${f.input.groupId}-coordinator`,
		attestationId: `${f.input.deviceId}-attestation`,
		reviewReceiptId: `${f.input.deviceId}-receipt`,
	});
	if (snapshot) input.verifiedSnapshot = { enrollmentIdentityId: null, invites: [] };
	return input;
}
async function history(f: RevocationFixture) {
	return Promise.all(
		controllerTables.filter((t) => t !== "coordinator_device_revocations").map((t) => f.rows(t)),
	);
}
async function revoke(f: RevocationFixture, subject: "device" | "key") {
	let tuple = f.input;
	if (subject === "key") {
		tuple = { ...f.input, deviceId: `${f.input.deviceId}-seed`, fingerprint: "c".repeat(64) };
		await f.store.enrollDevice(tuple.groupId, tuple);
	}
	expect(await f.store.createDeviceRevocation(tuple)).toMatchObject({ kind: "revoked" });
}
async function active(f: RevocationFixture, input: CoordinatorAuthControllerReviewInput) {
	return f.store.getActiveAuthControllerAttestation(input.coordinatorId, input.attestationId);
}

export function registerControllerRevocationContract(test: ControllerTest) {
	registerOrdinary(test);
	registerDenials(test);
	registerAliases(test);
	registerIdentityTransitions(test);
	registerEvidence(test);
}
function registerOrdinary(test: ControllerTest) {
	for (const publicKey of [CANONICAL_PUBLIC_KEY, "opaque-controller-fixture-key"]) {
		test(`preserves create, exact retry, and snapshot retry for ${publicKey.slice(0, 20)}`, async ({
			fixture: f,
		}) => {
			// Arrange: canonical and opaque legacy keys retain the same reviewed proof.
			f.input.publicKey = publicKey;
			await enrollRevocation(f);
			const input = controllerReview(f);
			// Act
			const created = await f.store.createAuthControllerAttestation(input);
			const retry = await f.store.createAuthControllerAttestation(input);
			const snapshotRetry = await f.store.createAuthControllerAttestation(
				controllerReview(f, true),
			);
			const current = await active(f, input);
			// Assert
			expect(created).toEqual({ kind: "created", attestation: current });
			expect(current).not.toBeNull();
			expect([retry, snapshotRetry]).toEqual(
				Array(2).fill({ kind: "existing", attestation: current }),
			);
			expect(await f.rows("coordinator_auth_controller_attestations")).toEqual([current]);
		});
	}
}
function registerDenials(test: ControllerTest) {
	for (const subject of ["device", "key"] as const) {
		for (const existing of [false, true]) {
			test(`${subject} revocation denies ${existing ? "retry and active authority" : "new insertion"} without rewriting history`, async ({
				fixture: f,
			}) => {
				// Arrange: the revocation is created against a real exact enrolled tuple.
				await enrollRevocation(f);
				const input = controllerReview(f);
				if (existing)
					expect(await f.store.createAuthControllerAttestation(input)).toMatchObject({
						kind: "created",
					});
				await revoke(f, subject);
				const before = await history(f);
				// Act
				const ordinary = await f.store.createAuthControllerAttestation(input);
				const reviewed = await f.store.createAuthControllerAttestation(controllerReview(f, true));
				const current = await active(f, input);
				// Assert: revocation cannot be overridden by matching evidence or a fresh receipt.
				expect(ordinary).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
				expect(reviewed).toEqual({ kind: "rejected", error: "review_stale" });
				expect(current).toBeNull();
				expect(await history(f)).toEqual(before);
			});
		}
	}
	test("device revocation also denies an opaque legacy key without deleting its attestation", async ({
		fixture: f,
	}) => {
		// Arrange
		f.input.publicKey = "opaque-controller-fixture-key";
		await enrollRevocation(f);
		const input = controllerReview(f);
		await f.store.createAuthControllerAttestation(input);
		await revoke(f, "device");
		const before = await history(f);
		// Act
		const result = await f.store.createAuthControllerAttestation(input);
		const current = await active(f, input);
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
		expect(current).toBeNull();
		expect(await history(f)).toEqual(before);
	});
}
function registerAliases(test: ControllerTest) {
	for (const publicKey of [
		`${CANONICAL_PUBLIC_KEY} fixture@example.invalid`,
		CANONICAL_PUBLIC_KEY.replace(/\+/g, "-").replace(/\//g, "_"),
	]) {
		test(`uses the enrolled canonical key, not caller fingerprint metadata: ${publicKey.slice(-24)}`, async ({
			fixture: f,
		}) => {
			// Arrange: a different device's revocation has the same crypto identity, not the same metadata.
			await enrollRevocation(f);
			await f.exec(
				"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE group_id = ? AND device_id = ?",
				publicKey,
				"d".repeat(64),
				f.input.groupId,
				f.input.deviceId,
			);
			const input = controllerReview(f);
			input.publicKey = publicKey;
			input.fingerprint = "d".repeat(64);
			Object.assign(input, { keyId: "e".repeat(64), actorHint: "identity-other" });
			const created = await f.store.createAuthControllerAttestation(input);
			const trusted = await active(f, input);
			await revoke(f, "key");
			const before = await history(f);
			// Act
			const result = await f.store.createAuthControllerAttestation(input);
			// Assert
			expect(created).toEqual({ kind: "created", attestation: trusted });
			expect(trusted).not.toBeNull();
			expect(result).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
			expect(await active(f, input)).toBeNull();
			expect(await history(f)).toEqual(before);
		});
	}
}
async function seedEvidence(f: RevocationFixture) {
	const input = controllerReview(f, true);
	const invite = {
		inviteId: `${f.input.deviceId}-invite`,
		kind: "add_device" as const,
		actorId: input.identityId,
		assignedIdentityId: null,
		targetIdentityId: input.identityId,
		digest: "c".repeat(64),
	};
	input.verifiedSnapshot = { enrollmentIdentityId: null, invites: [invite] };
	await f.exec(
		`INSERT INTO coordinator_invites (
		invite_id, group_id, token, policy, expires_at, created_at, consumed_at,
		bound_device_id, bound_public_key, bound_fingerprint, invite_kind,
		recipient_actor_id, assigned_identity_id, target_identity_id, reviewed_preview_digest
	) VALUES (?, ?, ?, 'auto', '2030', 'now', 'consumed', ?, ?, ?, ?, ?, ?, ?, ?)`,
		invite.inviteId,
		input.groupId,
		invite.inviteId,
		input.deviceId,
		input.publicKey,
		input.fingerprint,
		invite.kind,
		invite.actorId,
		invite.assignedIdentityId,
		invite.targetIdentityId,
		invite.digest,
	);
	return { input, invite };
}
function registerIdentityTransitions(test: ControllerTest) {
	test("keeps reviewed authority across same-identity binding while snapshot retry and revocation remain stricter", async ({
		fixture: f,
	}) => {
		// Arrange: the reviewed actor is explicit; the enrollment label starts null.
		await enrollRevocation(f);
		const input = controllerReview(f, true);
		const created = await f.store.createAuthControllerAttestation(input);
		// Act
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?",
			input.identityId,
			input.groupId,
			input.deviceId,
		);
		const sameIdentity = await active(f, input);
		const staleSnapshot = await f.store.createAuthControllerAttestation(input);
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?",
			"identity-other",
			input.groupId,
			input.deviceId,
		);
		const conflictingIdentity = await active(f, input);
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?",
			input.identityId,
			input.groupId,
			input.deviceId,
		);
		await revoke(f, "device");
		const revoked = await active(f, input);
		// Assert: live authority does not silently approve stale review evidence.
		expect(created).toEqual({ kind: "created", attestation: sameIdentity });
		expect(sameIdentity).not.toBeNull();
		expect(staleSnapshot).toEqual({ kind: "rejected", error: "review_stale" });
		expect([conflictingIdentity, revoked]).toEqual([null, null]);
		expect(await f.rows("coordinator_auth_controller_attestations")).toEqual([sameIdentity]);
	});
}
function registerEvidence(test: ControllerTest) {
	test("captures nested reviewed evidence before the first await without accepting later stale evidence", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		const { input, invite } = await seedEvidence(f);
		const original = structuredClone(input);
		// Act: caller mutation must not replace the evidence captured for this operation.
		const pending = f.store.createAuthControllerAttestation(input);
		invite.digest = "d".repeat(64);
		invite.actorId = "identity-other";
		invite.targetIdentityId = "identity-other";
		input.identityId = "identity-other";
		input.evidenceDigest = "e".repeat(64);
		const created = await pending;
		const retry = await f.store.createAuthControllerAttestation(original);
		await f.exec(
			"UPDATE coordinator_invites SET reviewed_preview_digest = ? WHERE invite_id = ?",
			"f".repeat(64),
			invite.inviteId,
		);
		const stale = await f.store.createAuthControllerAttestation(original);
		// Assert
		expect(created).toMatchObject({
			kind: "created",
			attestation: { identity_id: original.identityId, evidence_digest: original.evidenceDigest },
		});
		expect(retry).toMatchObject({ kind: "existing" });
		expect(stale).toEqual({ kind: "rejected", error: "review_stale" });
		expect(await f.rows("coordinator_auth_controller_attestations")).toHaveLength(1);
	});
}

// Forward real statements; only the deterministic execution boundary is intercepted.
export function controllerGuardedD1(db: D1DatabaseLike, gate: Gate) {
	const wrap = (statement: D1PreparedStatementLike, query: string): D1PreparedStatementLike => ({
		bind: (...values) => wrap(statement.bind(...values), query),
		first: async <T>() => {
			await gate(query);
			return statement.first<T>();
		},
		all: async <T>() => {
			await gate(query);
			return statement.all<T>();
		},
		raw: async <T>() => {
			await gate(query);
			return statement.raw<T>();
		},
		run: async () => {
			await gate(query);
			return statement.run();
		},
	});
	return new D1CoordinatorStore({ prepare: (query) => wrap(db.prepare(query), query) });
}
export function registerControllerReadWriteGuards(test: ControllerTest, guarded: Guarded) {
	registerRevocationGates(test, guarded);
	registerReplacementGates(test, guarded);
	registerCommittedHistory(test, guarded);
}
function registerRevocationGates(test: ControllerTest, guarded: Guarded) {
	for (const stage of ["insert", "active", "retry"] as const) {
		test(`revocation immediately before the actual ${stage} SQL gate denies stale success`, async ({
			fixture: f,
		}) => {
			// Arrange
			await enrollRevocation(f);
			const input = controllerReview(f, true);
			if (stage !== "insert") await f.store.createAuthControllerAttestation(input);
			const before = await history(f);
			const sql = {
				insert: AUTH_CONTROLLER_INSERT_SQL,
				active: AUTH_CONTROLLER_ACTIVE_SQL,
				retry: AUTH_CONTROLLER_RETRY_ACTIVE_SQL,
			}[stage];
			let called = false;
			const racing = guarded(f, async (query) => {
				if (called || query !== sql) return;
				called = true;
				await revoke(f, "device");
			});
			// Act
			let result: unknown;
			if (stage === "active")
				result = await racing.getActiveAuthControllerAttestation(
					input.coordinatorId,
					input.attestationId,
				);
			else result = await racing.createAuthControllerAttestation(input);
			// Assert: the gate must actually execute, not simply fail at a mocked precheck.
			expect(called).toBe(true);
			if (stage === "active") expect(result).toBeNull();
			else expect(result).toEqual({ kind: "rejected", error: "review_stale" });
			expect(await history(f)).toEqual(before);
			expect(await active(f, input)).toBeNull();
		});
	}
}
function registerReplacementGates(test: ControllerTest, guarded: Guarded) {
	for (const stage of ["insert", "active", "retry"] as const) {
		test(`pins enrollment public key across hash/read and ${stage} SQL with a clean replacement control`, async ({
			fixture: f,
		}) => {
			// Arrange: revoke a DIFFERENT device's canonical key; the replacement key is clean.
			await enrollRevocation(f);
			const input = controllerReview(f);
			if (stage !== "insert") await f.store.createAuthControllerAttestation(input);
			const sql = {
				insert: AUTH_CONTROLLER_INSERT_SQL,
				active: AUTH_CONTROLLER_ACTIVE_SQL,
				retry: AUTH_CONTROLLER_RETRY_ACTIVE_SQL,
			}[stage];
			let called = false;
			const racing = guarded(f, async (query) => {
				if (called || query !== sql) return;
				called = true;
				await revoke(f, "key");
				await f.exec(
					"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
					UNRELATED_PUBLIC_KEY,
					input.groupId,
					input.deviceId,
				);
			});
			// Act
			let result: unknown;
			if (stage === "active")
				result = await racing.getActiveAuthControllerAttestation(
					input.coordinatorId,
					input.attestationId,
				);
			else result = await racing.createAuthControllerAttestation(input);
			await f.exec(
				"UPDATE enrolled_devices SET fingerprint = ? WHERE group_id = ? AND device_id = ?",
				"d".repeat(64),
				input.groupId,
				input.deviceId,
			);
			const clean = await f.store.createAuthControllerAttestation({
				...input,
				publicKey: UNRELATED_PUBLIC_KEY,
				fingerprint: "d".repeat(64),
				attestationId: `${input.attestationId}-clean`,
				reviewReceiptId: `${input.reviewReceiptId}-clean`,
			});
			// Assert: stale identity fails; clean key + clean device succeeds even after source-key R.
			expect(called).toBe(true);
			if (stage === "active") expect(result).toBeNull();
			else expect(result).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
			expect(clean).toMatchObject({ kind: "created" });
			expect(await active(f, input)).toBeNull();
		});
	}
}
function registerCommittedHistory(test: ControllerTest, guarded: Guarded) {
	test("post-insert revocation reports unavailable authority but preserves the committed proof and cannot resurrect it", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		const input = controllerReview(f);
		let called = false;
		const racing = guarded(f, async (query) => {
			if (called || query !== AUTH_CONTROLLER_ACTIVE_SQL) return;
			called = true;
			await revoke(f, "device");
		});
		// Act: INSERT commits before the live-authority read loses eligibility.
		const pending = racing.createAuthControllerAttestation(input);
		// Assert: an unavailable return is not a rollback claim.
		await expect(pending).rejects.toThrow("auth_controller_persistence_incomplete");
		expect(called).toBe(true);
		expect(await f.rows("coordinator_auth_controller_attestations")).toMatchObject([
			{ attestation_id: input.attestationId, revoked_at: null },
		]);
		expect(await active(f, input)).toBeNull();
		expect(await f.store.createAuthControllerAttestation(input)).toEqual({
			kind: "rejected",
			error: "enrollment_mismatch",
		});
	});
}
