import { afterEach, beforeEach, expect, vi } from "vitest";
import type { LinkFixture } from "./coordinator-auth-link-test-fixtures.js";
import { backendTest, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	CANONICAL_PUBLIC_KEY,
	publicKeyFromWire,
	wireBytes,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	captureInternalOwnerResolutionReview,
	commitReviewedOwnerResolution,
} from "./coordinator-legacy-owner-resolution-commit.js";
import {
	backendFor,
	buildReview,
	controllerTable,
	type Harness,
	type InternalReviewFixture,
	now,
	originalController,
	resolutionTable,
	seed,
	signer,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";

async function boundReview(f: LinkFixture, h: Harness) {
	const review = await buildReview(f);
	const verifiedHistory = review.controllerReview.verifiedSnapshot?.legacyHistory;
	if (!verifiedHistory) throw new Error("synthetic review history unavailable");
	const collection = await h.evidence.collect({
		canonicalOwnerId: "identity-a",
		actualSigner: { ...signer },
		verifiedHistory,
	});
	expect(collection.kind).toBe("collected");
	if (collection.kind !== "collected") throw new Error("synthetic evidence unavailable");
	const ownershipEvidenceDigest = await h.evidence.reviewedEvidenceDigest(
		collection.recheckSnapshot,
	);
	expect(ownershipEvidenceDigest).toMatch(/^[a-f0-9]{64}$/u);
	expect(ownershipEvidenceDigest).toBe(review.ownershipEvidenceDigest);
	return { ...review, ownershipEvidenceDigest };
}

function projectInvite(f: LinkFixture) {
	// Real invite schema; this consumed Project row does not enter ownerInvites.
	f.db
		.prepare(`INSERT INTO coordinator_invites
		(invite_id,group_id,token,policy,created_at,expires_at,consumed_at,
		bound_device_id,bound_public_key,bound_fingerprint,invite_kind,
		assigned_identity_id,target_identity_id,recipient_actor_id,reviewed_preview_digest)
		VALUES (?,?,?,'open',?,?,?,?,?,?,'project_share',NULL,NULL,?,?)`)
		.run(
			"new-project-invite",
			signer.groupId,
			"synthetic-project-token",
			now,
			"2026-10-05T00:00:00.000Z",
			now,
			signer.deviceId,
			signer.publicKey,
			signer.fingerprint,
			"identity-d",
			"d".repeat(64),
		);
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test.for(["consumed project actor", "same owner other group controller"] as const)(
		`${kind} fixture control: %s is valid collected evidence without changing old review projections`,
		async (change, { fixture: f }) => {
			// Arrange: independently exercise the late-row fixture before checking digest freshness.
			const h = backendFor(f, kind);
			await seed(f, h, { weakCurrent: true });
			const old = await buildReview(f);
			if (change === "consumed project actor") projectInvite(f);
			else await originalController(f, "new-compatible-controller-group");
			const fresh = await buildReview(f);
			const verifiedHistory = fresh.controllerReview.verifiedSnapshot?.legacyHistory;
			if (!verifiedHistory) throw new Error("synthetic history unavailable");
			// Act
			const collected = await h.evidence.collect({
				canonicalOwnerId: "identity-a",
				actualSigner: { ...signer },
				verifiedHistory,
			});
			// Assert: this is not malformed-row denial or a changed history/owner-invite test.
			expect(collected).toMatchObject({
				kind: "collected",
				decision: "weak_label_review_required",
			});
			expect(fresh.controllerReview.verifiedSnapshot?.legacyHistory).toEqual(
				old.controllerReview.verifiedSnapshot?.legacyHistory,
			);
			expect(fresh.controllerReview.verifiedSnapshot?.invites).toEqual(
				old.controllerReview.verifiedSnapshot?.invites,
			);
			if (change === "consumed project actor") {
				expect(collected).toMatchObject({
					weakLabels: expect.arrayContaining([
						expect.objectContaining({ label: "identity-d", kind: "consumed_project_actor_label" }),
					]),
				});
			}
			expect(h.batchCount()).toBe(0);
		},
	);
	test(`${kind} unchanged reviewed evidence permits controller and resolution create`, async ({
		fixture: f,
	}) => {
		// Arrange: actual linked-owner provenance plus accepted historical weak C.
		const h = backendFor(f, kind);
		await seed(f, h, { weakCurrent: true });
		const review = await boundReview(f, h);
		const before = snapshot(f, [controllerTable, resolutionTable]);
		// Act
		const result = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review,
			now,
		});
		// Assert: digest is an additional freshness check, never a replacement for proof.
		expect(result).toMatchObject({
			controllerDisposition: "created",
			resolutionDisposition: "created",
		});
		expect(h.batchCount()).toBe(1);
		expect(snapshot(f, [controllerTable, resolutionTable])).toEqual(before);
	});

	test.for(["consumed project actor", "same owner other group controller"] as const)(
		`${kind} denies unreviewed %s arriving BEFORE writer collection`,
		async (change, { fixture: f }) => {
			// Arrange: confirmation has already reviewed old weak labels and full history.
			const h = backendFor(f, kind);
			await seed(f, h, { weakCurrent: true });
			const review = await boundReview(f, h);
			if (change === "consumed project actor") projectInvite(f);
			else await originalController(f, "new-compatible-controller-group");
			const rebuilt = await buildReview(f);
			expect(rebuilt.controllerReview.verifiedSnapshot?.legacyHistory).toEqual(
				review.controllerReview.verifiedSnapshot?.legacyHistory,
			);
			expect(rebuilt.controllerReview.verifiedSnapshot?.invites).toEqual(
				review.controllerReview.verifiedSnapshot?.invites,
			);
			const before = snapshot(f);
			// Act / Assert: no batch is allowed to write an unreviewed weak label or source.
			await expect(
				commitReviewedOwnerResolution({ backend: h.backend, evidence: h.evidence, review, now }),
			).rejects.toThrow();
			expect(h.batchCount()).toBe(0);
			expect(snapshot(f)).toEqual(before);
			expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${resolutionTable}`).get()).toEqual({ n: 0 });
		},
	);

	test(`${kind} unrelated person's different device and key do not stale confirmation`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		await seed(f, h, { weakCurrent: true });
		const review = await boundReview(f, h);
		const wire = wireBytes();
		wire[wire.length - 1] = (wire[wire.length - 1] ?? 0) ^ 1;
		const unrelatedKey = publicKeyFromWire(wire);
		const unrelatedKeyId = await ed25519KeyIdForRevocation(unrelatedKey);
		expect(unrelatedKeyId).toMatch(/^[a-f0-9]{64}$/u);
		expect(unrelatedKeyId).not.toBe(await ed25519KeyIdForRevocation(signer.publicKey));
		expect(unrelatedKeyId).not.toBe(await ed25519KeyIdForRevocation(CANONICAL_PUBLIC_KEY));
		f.db
			.prepare(`INSERT INTO coordinator_auth_controller_attestations
			(attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,
			review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at,revoked_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,1,?,NULL)`)
			.run(
				"unrelated-controller",
				f.cfg.coordinatorId,
				"identity-b",
				"other-group",
				"other-device",
				unrelatedKey,
				"f".repeat(64),
				"other-receipt",
				"e".repeat(64),
				"identity-b",
				now,
			);
		const before = snapshot(f, [controllerTable, resolutionTable]);
		// Act
		const result = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review,
			now,
		});
		// Assert
		expect(result).toMatchObject({
			controllerDisposition: "created",
			resolutionDisposition: "created",
		});
		expect(snapshot(f, [controllerTable, resolutionTable])).toEqual(before);
	});

	test(`${kind} well-formed but wrong private evidence digest denies before writes`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		await seed(f, h);
		const review = { ...(await buildReview(f)), ownershipEvidenceDigest: "0".repeat(64) };
		const before = snapshot(f);
		// Act
		const captured = captureInternalOwnerResolutionReview(review);
		// Assert: capture validates shape; the writer independently compares fresh data.
		expect(captured).not.toBeNull();
		await expect(
			commitReviewedOwnerResolution({ backend: h.backend, evidence: h.evidence, review, now }),
		).rejects.toThrow();
		expect(h.batchCount()).toBe(0);
		expect(snapshot(f)).toEqual(before);
	});

	test.for([
		"missing",
		"uppercase",
		"short",
		"object",
		"getter",
		"wrong scope",
		"missing consent",
	] as const)(
		`${kind} strict private review capture rejects %s evidence confirmation`,
		async (mode, { fixture: f }) => {
			// Arrange: start from real captured evidence before altering the intended field.
			const h = backendFor(f, kind);
			await seed(f, h);
			const base: InternalReviewFixture = await buildReview(f);
			const review: Record<string, unknown> = { ...base };
			const getter = vi.fn(() => base.ownershipEvidenceDigest);
			if (mode === "missing") delete review.ownershipEvidenceDigest;
			if (mode === "uppercase") review.ownershipEvidenceDigest = "A".repeat(64);
			if (mode === "short") review.ownershipEvidenceDigest = "abc";
			if (mode === "object") review.ownershipEvidenceDigest = { digest: "a".repeat(64) };
			if (mode === "getter")
				Object.defineProperty(review, "ownershipEvidenceDigest", { get: getter });
			if (mode === "wrong scope") review.consent = { ...base.consent, scope: "all_owner_labels" };
			if (mode === "missing consent") delete review.consent;
			const before = snapshot(f);
			// Act
			const captured = captureInternalOwnerResolutionReview(review);
			// Assert: no getter execution, query authority, or receipt writes from private metadata.
			expect(captured).toBeNull();
			expect(getter).not.toHaveBeenCalled();
			expect(h.batchCount()).toBe(0);
			expect(snapshot(f)).toEqual(before);
		},
	);
}
