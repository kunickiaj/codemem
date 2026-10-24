import { expect } from "vitest";
import { backendTest } from "./coordinator-auth-link-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	buildReview,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import {
	deterministicReviewTests,
	existingFact,
	projectLabel,
	reconnectTarget,
	setupReview,
	signer,
	unrelatedChurn,
} from "./coordinator-owner-resolution-review-test-fixtures.js";

deterministicReviewTests();
for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind} controls prove discovery-only key spelling is valid, unrelated, and hash-stable`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind);
		const original = await buildReview(f);
		// Act
		const key = await unrelatedChurn(f);
		const fresh = await buildReview(f);
		// Assert
		expect(await ed25519KeyIdForRevocation(key)).toMatch(/^[a-f0-9]{64}$/);
		expect(await ed25519KeyIdForRevocation(key)).not.toBe(
			await ed25519KeyIdForRevocation(signer.publicKey),
		);
		expect(fresh.ownershipEvidenceDigest).toBe(original.ownershipEvidenceDigest);
	});
	test(`${kind} controls retain real account birth across a valid successor generation`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind);
		reconnectTarget(f);
		const before = snapshot(f);
		// Act
		const successor = await buildReview(f);
		// Assert
		expect(successor.controllerReview.verifiedSnapshot?.accountOwnerTarget?.linkId).toBe(
			"successor-link",
		);
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} controls prove actual linked A independently of current weak C`, async ({
		fixture: f,
	}) => {
		// Arrange: accepted account birth occurs on a different device and key.
		const h = await setupReview(f, kind);
		projectLabel(f);
		const review = await buildReview(f);
		const origin = f.db
			.prepare("SELECT * FROM enrolled_devices WHERE device_id='device-a'")
			.get() as {
			group_id: string;
			device_id: string;
			public_key: string;
			fingerprint: string;
		};
		const before = snapshot(f);
		// Act
		const target = await f.store.readAccountOwnerTarget(
			{
				targetIdentityId: "identity-a",
				signer: {
					groupId: origin.group_id,
					deviceId: origin.device_id,
					publicKey: origin.public_key,
					fingerprint: origin.fingerprint,
				},
			},
			f.cfg,
		);
		const ordinary = await f.store.readAccountOwnerTarget(
			{ targetIdentityId: "identity-a", signer },
			f.cfg,
		);
		const status = await f.store.readAccountLinkStatus(signer, f.cfg, { identityId: "identity-a" });
		const collected = await h.evidence.collect({
			canonicalOwnerId: "identity-a",
			actualSigner: signer,
			verifiedHistory: review.controllerReview.verifiedSnapshot?.legacyHistory,
		});
		// Assert: a raw link alone is not used as proof; weak C is not ordinary A authority.
		expect(target).toMatchObject({ kind: "ready", linkId: "claim-a" });
		expect(origin.device_id).not.toBe(signer.deviceId);
		expect(origin.public_key).not.toBe(signer.publicKey);
		expect(ordinary).toEqual({ kind: "unavailable" });
		expect(status.state).not.toBe("linked");
		expect(collected).toMatchObject({ kind: "collected", decision: "weak_label_review_required" });
		if (collected.kind !== "collected") throw new Error("control collection unavailable");
		expect(JSON.stringify(collected.weakLabels)).toContain("identity-c");
		expect(JSON.stringify(collected.weakLabels)).toContain("identity-project");
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} controls reject broken account birth provenance`, async ({ fixture: f }) => {
		// Arrange
		await setupReview(f, kind);
		f.db.exec("UPDATE coordinator_auth_link_attempts SET account_subject='wrong-birth-subject'");
		const before = snapshot(f);
		// Act / Assert
		await expect(buildReview(f)).rejects.toThrow("fixture target proof unavailable");
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} controls verify actual retained source with all original receipt pins`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupReview(f, kind);
		const fact = await existingFact(f, h, { retainedSource: true });
		const before = snapshot(f);
		// Act
		const valid = await h.evidence.verifyControllerSource({
			sourceRef: fact.resolution,
			expectedOwnerId: "identity-a",
			actualSigner: signer,
		});
		const wrong = await h.evidence.verifyControllerSource({
			sourceRef: { ...fact.resolution, source_review_receipt_id: "wrong-receipt" },
			expectedOwnerId: "identity-a",
			actualSigner: signer,
		});
		// Assert
		expect(Object.keys(fact.controller)).toHaveLength(13);
		expect(Object.keys(fact.resolution)).toHaveLength(20);
		expect(valid).toEqual({ kind: "verified_controller_source" });
		expect(wrong).toEqual({ kind: "source_mismatch" });
		expect(snapshot(f)).toEqual(before);
	});
}
