import { afterEach, beforeEach, expect, vi } from "vitest";
import { backendTest, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import {
	backendFor,
	buildReview,
	controllerTable,
	history,
	now,
	originalController,
	resolutionTable,
	revoke,
	seed,
	signer,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";

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
	test(`${kind} creates controller and resolution for proved weak current C without changing any other table`, async ({
		fixture: f,
	}) => {
		// Arrange: no laptop ownership binding or prior controller is seeded.
		const h = backendFor(f, kind);
		await seed(f, h, { weakCurrent: true });
		const review = await buildReview(f);
		const before = snapshot(f, [controllerTable, resolutionTable]);
		// Act
		const result = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review,
			now,
		});
		// Assert: explicit consent creates receipts only, not enrollment, grants, or sharing.
		expect(result).toMatchObject({
			controllerDisposition: "created",
			resolutionDisposition: "created",
		});
		expect(Object.keys(result.controller)).toHaveLength(13);
		expect(Object.keys(result.resolution)).toHaveLength(20);
		expect(result.controller).toMatchObject({
			public_key: signer.publicKey,
			identity_id: "identity-a",
			enrollment_identity_id: "identity-c",
		});
		expect(result.resolution).toMatchObject({
			resolution_id: review.resolutionId,
			key_id: await ed25519KeyIdForRevocation(signer.publicKey),
			owner_identity_id: "identity-a",
			source_public_key: signer.publicKey,
			source_attestation_id: result.controller.attestation_id,
			source_review_receipt_id: result.controller.review_receipt_id,
			source_evidence_digest: result.controller.evidence_digest,
			resolution_evidence_digest: review.consent.evidenceDigest,
		});
		expect(JSON.parse(result.resolution.reviewed_weak_labels_json).length).toBeGreaterThan(0);
		expect(h.batchCount()).toBe(1);
		expect(snapshot(f, [controllerTable, resolutionTable])).toEqual(before);
	});
	test(`${kind} reuses an ORIGINAL ordinary controller only after fresh resolution consent`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		await seed(f, h);
		const original = await originalController(f);
		const review = await buildReview(f, { existingController: original });
		const before = snapshot(f, [resolutionTable]);
		// Act
		const result = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review,
			now,
		});
		// Assert: old digest, receipt, text, fingerprint, snapshot, and time are immutable.
		expect(result).toMatchObject({
			controllerDisposition: "reused",
			resolutionDisposition: "created",
		});
		expect(result.controller).toEqual(original);
		expect(result.resolution.source_review_receipt_id).toBe(original.review_receipt_id);
		expect(result.resolution.source_evidence_digest).toBe(original.evidence_digest);
		expect(snapshot(f, [resolutionTable])).toEqual(before);
	});
	test(`${kind} exact retry uses fresh explicit consent but retains both original receipts after more weak history`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		await seed(f, h);
		const first = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review: await buildReview(f),
			now,
		});
		history(f, "history-d", "identity-d");
		const review = await buildReview(f, {
			existingController: first.controller,
			existingResolution: first.resolution,
		});
		const before = snapshot(f);
		// Act
		const retry = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review,
			now,
		});
		// Assert: retry is not a renewal and weak metadata does not need rewriting.
		expect(retry).toEqual({
			...first,
			controllerDisposition: "reused",
			resolutionDisposition: "reused",
		});
		expect(review.consent.evidenceDigest).not.toBe(first.resolution.resolution_evidence_digest);
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} same owner may explicitly append another resolution ID without rewriting the old one`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		await seed(f, h);
		const first = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review: await buildReview(f),
			now,
		});
		const review = await buildReview(f, {
			existingController: first.controller,
			resolutionId: "resolution-second",
		});
		const before = snapshot(f, [resolutionTable]);
		// Act
		const second = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review,
			now,
		});
		// Assert
		expect(second).toMatchObject({
			controllerDisposition: "reused",
			resolutionDisposition: "created",
		});
		expect(
			f.db
				.prepare(`SELECT * FROM ${resolutionTable} WHERE resolution_id=?`)
				.get(first.resolution.resolution_id),
		).toEqual(first.resolution);
		expect(f.db.prepare(`SELECT * FROM ${resolutionTable}`).all()).toHaveLength(2);
		expect(snapshot(f, [resolutionTable])).toEqual(before);
	});
	test(`${kind} missing referenced controller cannot be recreated while reusing its old resolution`, async ({
		fixture: f,
	}) => {
		// Arrange: created/reused is invalid when the immutable source is absent.
		const h = backendFor(f, kind);
		await seed(f, h);
		const first = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review: await buildReview(f),
			now,
		});
		f.db.prepare(`DELETE FROM ${controllerTable}`).run();
		const review = await buildReview(f, { existingResolution: first.resolution });
		const before = snapshot(f);
		// Act / Assert
		await expect(
			commitReviewedOwnerResolution({ backend: h.backend, evidence: h.evidence, review, now }),
		).rejects.toThrow();
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} retained source group removal and public-key alias preserve original source text`, async ({
		fixture: f,
	}) => {
		// Arrange: canonical key matches while source group/text/fingerprint are distinct.
		const h = backendFor(f, kind);
		await seed(f, h);
		const original = await originalController(
			f,
			"old-source-group",
			`${signer.publicKey} retained-alias`,
		);
		f.db.prepare("DELETE FROM enrolled_devices WHERE group_id=?").run(original.group_id);
		f.db.prepare("DELETE FROM groups WHERE group_id=?").run(original.group_id);
		const review = await buildReview(f, { existingController: original });
		const before = snapshot(f, [resolutionTable]);
		// Act
		const result = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review,
			now,
		});
		// Assert: source receipt is separate from CURRENT request-group eligibility.
		expect(result.controllerDisposition).toBe("reused");
		expect(result.controller).toEqual(original);
		expect(result.resolution.source_public_key).toBe(original.public_key);
		expect(result.resolution.source_group_id).toBe(original.group_id);
		expect(snapshot(f, [resolutionTable])).toEqual(before);
	});
	for (const subject of ["device_id", "ed25519_key"] as const) {
		test(`${kind} retired origin ${subject} does not revoke linked owner A`, async ({
			fixture: f,
		}) => {
			// Arrange: capture the real generation before retiring only the origin device/key.
			const h = backendFor(f, kind);
			await seed(f, h);
			const review = await buildReview(f);
			await revoke(f, subject, true);
			const before = snapshot(f, [controllerTable, resolutionTable]);
			// Act
			const result = await commitReviewedOwnerResolution({
				backend: h.backend,
				evidence: h.evidence,
				review,
				now,
			});
			// Assert
			expect(result.controller.identity_id).toBe("identity-a");
			expect(snapshot(f, [controllerTable, resolutionTable])).toEqual(before);
		});
	}
}
