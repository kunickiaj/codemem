import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";

type ReviewInput = Parameters<D1CoordinatorStore["createAuthControllerAttestation"]>[0];
type Attestation = NonNullable<
	Awaited<ReturnType<D1CoordinatorStore["getActiveAuthControllerAttestation"]>>
>;

const fixtures: ReviewInput[] = [];

afterEach(async () => {
	// Delete only this file's fixtures, including tombstones intentionally retained by removal.
	for (const review of fixtures.splice(0)) {
		await env.COORDINATOR_DB.batch([
			env.COORDINATOR_DB.prepare(
				"DELETE FROM coordinator_auth_controller_attestations WHERE coordinator_id = ?",
			).bind(review.coordinatorId),
			env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(
				review.groupId,
			),
			env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(review.groupId),
		]);
	}
});

async function createFixture() {
	const store = new D1CoordinatorStore(env.COORDINATOR_DB);
	const review: ReviewInput = {
		coordinatorId: randomUUID(),
		groupId: randomUUID(),
		deviceId: randomUUID(),
		identityId: randomUUID(),
		attestationId: randomUUID(),
		reviewReceiptId: randomUUID(),
		publicKey: "fixture-public-key",
		fingerprint: "a".repeat(64),
		evidenceDigest: "b".repeat(64),
	};
	fixtures.push(review);
	await store.createGroup(review.groupId, "Fixture group");
	// This is a store test, not a crypto verifier; the key is deliberately generic.
	await store.enrollDevice(review.groupId, {
		deviceId: review.deviceId,
		publicKey: review.publicKey,
		fingerprint: review.fingerprint,
	});
	return { store, review };
}

async function readAttestations(coordinatorId: string) {
	const rows = await env.COORDINATOR_DB.prepare(
		"SELECT * FROM coordinator_auth_controller_attestations WHERE coordinator_id = ?",
	)
		.bind(coordinatorId)
		.all<Attestation>();
	return rows.results;
}

it("requires explicit review for a fresh coordinator and retries without rewriting enrollment identity", async () => {
	// Arrange: this coordinator has no authority from enrollment labels alone.
	const { store, review } = await createFixture();
	const emptyRows = await readAttestations(review.coordinatorId);
	const beforeReview = await store.getActiveAuthControllerAttestation(
		review.coordinatorId,
		review.attestationId,
	);

	// Act: mismatched enrollment must fail before a trusted review can succeed.
	const mismatch = await store.createAuthControllerAttestation({
		...review,
		fingerprint: "c".repeat(64),
	});
	const afterMismatch = await readAttestations(review.coordinatorId);
	const created = await store.createAuthControllerAttestation(review);
	const active = await store.getActiveAuthControllerAttestation(
		review.coordinatorId,
		review.attestationId,
	);
	const retry = await store.createAuthControllerAttestation(review);
	const enrollment = await store.getEnrollment(review.groupId, review.deviceId);
	const rows = await readAttestations(review.coordinatorId);

	// Assert: retries return the same proof, not a second row or an identity update.
	expect(emptyRows).toEqual([]);
	expect(beforeReview).toBeNull();
	expect(mismatch).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
	expect(afterMismatch).toEqual([]);
	expect(created).toEqual({ kind: "created", attestation: active });
	expect(active).toEqual({
		attestation_id: review.attestationId,
		coordinator_id: review.coordinatorId,
		identity_id: review.identityId,
		group_id: review.groupId,
		device_id: review.deviceId,
		public_key: review.publicKey,
		fingerprint: review.fingerprint,
		review_receipt_id: review.reviewReceiptId,
		evidence_digest: review.evidenceDigest,
		enrollment_identity_id: null,
		revision: 1,
		created_at: expect.any(String),
		revoked_at: null,
	});
	expect(retry).toEqual({ kind: "existing", attestation: active });
	expect(enrollment).toEqual(expect.objectContaining({ identity_id: null }));
	expect(rows).toEqual([active]);
});

it("resolves concurrent reviews for one enrolled key to one proof and a domain conflict", async () => {
	// Arrange: a null enrollment identity permits either reviewed actor, but not both proofs.
	const { store, review } = await createFixture();
	const competingReview = {
		...review,
		identityId: randomUUID(),
		attestationId: randomUUID(),
		reviewReceiptId: randomUUID(),
	};

	// Act: real local D1 enforces the unique tuple in the conditional INSERT.
	// Promise.all must resolve; a raw D1 uniqueness error would fail this test.
	const results = await Promise.all([
		store.createAuthControllerAttestation(review),
		store.createAuthControllerAttestation(competingReview),
	]);
	const rows = await readAttestations(review.coordinatorId);
	const active = await Promise.all(
		[review, competingReview].map((input) =>
			store.getActiveAuthControllerAttestation(input.coordinatorId, input.attestationId),
		),
	);

	// Assert: do not depend on which invocation D1 schedules first.
	const winners = results.filter((result) => result.kind === "created");
	expect(winners).toHaveLength(1);
	expect(results.filter((result) => result.kind !== "created")).toEqual([
		{ kind: "rejected", error: "attestation_conflict" },
	]);
	expect(rows).toHaveLength(1);
	expect(winners).toEqual([{ kind: "created", attestation: rows[0] }]);
	expect(active.filter((attestation) => attestation !== null)).toEqual(rows);
	expect(active.filter((attestation) => attestation === null)).toHaveLength(1);
});

it("retains revoked tuples across removal and reenrollment and prevents receipt reuse", async () => {
	// Arrange: create an active proof before withdrawing the review.
	const { store, review } = await createFixture();
	const created = await store.createAuthControllerAttestation(review);
	const activeBefore = await store.getActiveAuthControllerAttestation(
		review.coordinatorId,
		review.attestationId,
	);

	// Act: enrollment removal must not cascade away the revocation tombstone.
	const revoked = await store.revokeAuthControllerAttestation(
		review.coordinatorId,
		review.attestationId,
	);
	const removed = await store.removeDevice(review.groupId, review.deviceId);
	const afterRemoval = await readAttestations(review.coordinatorId);
	await store.enrollDevice(review.groupId, {
		deviceId: review.deviceId,
		publicKey: review.publicKey,
		fingerprint: review.fingerprint,
	});
	const activeAfter = await store.getActiveAuthControllerAttestation(
		review.coordinatorId,
		review.attestationId,
	);
	const exactRetry = await store.createAuthControllerAttestation(review);
	const newReceipt = await store.createAuthControllerAttestation({
		...review,
		attestationId: randomUUID(),
		reviewReceiptId: randomUUID(),
	});
	const otherDeviceId = randomUUID();
	await store.enrollDevice(review.groupId, {
		deviceId: otherDeviceId,
		publicKey: "other-fixture-public-key",
		fingerprint: "c".repeat(64),
	});
	const reusedReceipt = await store.createAuthControllerAttestation({
		...review,
		deviceId: otherDeviceId,
		publicKey: "other-fixture-public-key",
		fingerprint: "c".repeat(64),
		attestationId: randomUUID(),
	});
	const rows = await readAttestations(review.coordinatorId);

	// Assert: neither new review IDs nor a different enrolled tuple revive the receipt.
	expect(created).toEqual({ kind: "created", attestation: activeBefore });
	expect(activeBefore).not.toBeNull();
	expect(revoked).toBe(true);
	expect(removed).toBe(true);
	expect(afterRemoval).toEqual([{ ...activeBefore, revoked_at: expect.any(String) }]);
	expect(activeAfter).toBeNull();
	expect(exactRetry).toEqual({ kind: "rejected", error: "attestation_revoked" });
	expect(newReceipt).toEqual({ kind: "rejected", error: "attestation_conflict" });
	expect(reusedReceipt).toEqual({ kind: "rejected", error: "attestation_conflict" });
	expect(rows).toEqual(afterRemoval);
});

it("checks the live key, fingerprint, enabled state, and group archive on every lookup", async () => {
	// Arrange: the stored proof remains unchanged while enrollment/group state changes.
	const { store, review } = await createFixture();
	const created = await store.createAuthControllerAttestation(review);
	const lookup = () =>
		store.getActiveAuthControllerAttestation(review.coordinatorId, review.attestationId);
	const original = await lookup();
	const enrollment = {
		deviceId: review.deviceId,
		publicKey: review.publicKey,
		fingerprint: review.fingerprint,
	};

	// Act: change each live gate separately, restoring it before the next gate.
	await store.enrollDevice(review.groupId, {
		...enrollment,
		publicKey: "replacement-fixture-public-key",
	});
	const replacedKey = await lookup();
	await store.enrollDevice(review.groupId, { ...enrollment, fingerprint: "c".repeat(64) });
	const replacedFingerprint = await lookup();
	await store.enrollDevice(review.groupId, enrollment);
	const restoredKey = await lookup();
	const disabled = await store.setDeviceEnabled(review.groupId, review.deviceId, false);
	const disabledLookup = await lookup();
	const enabled = await store.setDeviceEnabled(review.groupId, review.deviceId, true);
	const enabledLookup = await lookup();
	const archived = await store.archiveGroup(review.groupId, "2026-10-02T00:00:00Z");
	const archivedLookup = await lookup();
	const unarchived = await store.unarchiveGroup(review.groupId);
	const unarchivedLookup = await lookup();
	const rows = await readAttestations(review.coordinatorId);

	// Assert: no cached authority survives an invalid live enrollment or archived group.
	expect(created).toEqual({ kind: "created", attestation: original });
	expect(original).not.toBeNull();
	expect(replacedKey).toBeNull();
	expect(replacedFingerprint).toBeNull();
	expect(restoredKey).toEqual(original);
	expect(disabled).toBe(true);
	expect(disabledLookup).toBeNull();
	expect(enabled).toBe(true);
	expect(enabledLookup).toEqual(original);
	expect(archived).toBe(true);
	expect(archivedLookup).toBeNull();
	expect(unarchived).toBe(true);
	expect(unarchivedLookup).toEqual(original);
	expect(rows).toEqual([original]);
});
