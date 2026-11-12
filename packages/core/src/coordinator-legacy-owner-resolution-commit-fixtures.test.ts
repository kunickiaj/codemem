import { afterEach, beforeEach, expect, vi } from "vitest";
import { backendTest, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	backendFor,
	buildReview,
	originalController,
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
	const test = backendTest(kind, { accountSchema: "v2" });
	test(`${kind} fixture proves linked A through actual birth provenance and collects weak C read-only`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		const batch = vi.spyOn(h.backend, "batch");
		await seed(f, h, { weakCurrent: true });
		const setupCalls = batch.mock.calls.length;
		const baseline = h.batchCount();
		const review = await buildReview(f);
		const verifiedHistory = review.controllerReview.verifiedSnapshot?.legacyHistory;
		if (!verifiedHistory) throw new Error("fixture history missing");
		const before = snapshot(f);
		// Act
		const collected = await h.evidence.collect({
			canonicalOwnerId: "identity-a",
			actualSigner: signer,
			verifiedHistory,
		});
		const ordinary = await f.store.createAuthControllerAttestation(review.controllerReview);
		if (!h.backend.batch) throw new Error("fixture batch unavailable");
		const probe = await h.backend.batch([{ sql: "SELECT 1 AS fixture_batch_probe", values: [] }]);
		// Assert: C has canonical included history, but an ordinary confirmation cannot override it.
		expect(setupCalls).toBe(1);
		expect(baseline).toBe(0);
		expect(h.batchCount()).toBe(1);
		expect(batch).toHaveBeenCalledTimes(2);
		expect(probe).toEqual([0]);
		expect(review.controllerReview.verifiedSnapshot?.accountOwnerTarget).toMatchObject({
			linkId: "claim-a",
		});
		expect(collected).toMatchObject({ kind: "collected", decision: "weak_label_review_required" });
		if (collected.kind !== "collected") throw new Error("fixture collection unavailable");
		expect(collected.weakLabels.length).toBeGreaterThan(0);
		expect(ordinary.kind).toBe("rejected");
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} fixture creates an ordinary immutable controller without pre-seeding laptop ownership`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		await seed(f, h);
		const before = snapshot(f, ["coordinator_auth_controller_attestations"]);
		// Act
		const original = await originalController(f);
		const input = await buildReview(f, { existingController: original });
		const source = {
			coordinator_id: original.coordinator_id,
			resolution_id: "fixture-source-reference",
			resolution_version: 1,
			device_id: original.device_id,
			key_id: await ed25519KeyIdForRevocation(original.public_key),
			owner_identity_id: original.identity_id,
			purpose: "existing_account_owner",
			scope: "historical_included_owner_labels_only",
			source_attestation_id: original.attestation_id,
			source_group_id: original.group_id,
			source_controller_revision: original.revision,
			source_public_key: original.public_key,
			source_fingerprint: original.fingerprint,
			source_enrollment_identity_id: original.enrollment_identity_id,
			source_created_at: original.created_at,
			source_review_receipt_id: original.review_receipt_id,
			source_evidence_digest: original.evidence_digest,
			resolution_evidence_digest: input.consent.evidenceDigest,
			reviewed_weak_labels_json: "[]",
			created_at: new Date(NOW).toISOString(),
		};
		const verified = await h.evidence.verifyControllerSource({
			sourceRef: source,
			expectedOwnerId: "identity-a",
			actualSigner: signer,
		});
		const mismatched = await h.evidence.verifyControllerSource({
			sourceRef: { ...source, source_review_receipt_id: "not-original" },
			expectedOwnerId: "identity-a",
			actualSigner: signer,
		});
		// Assert
		expect(Object.keys(original)).toHaveLength(13);
		expect(input.existingController).toEqual(original);
		expect(verified).toEqual({ kind: "verified_controller_source" });
		expect(mismatched).toEqual({ kind: "source_mismatch" });
		expect(snapshot(f, ["coordinator_auth_controller_attestations"])).toEqual(before);
		expect(
			f.db
				.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id=?")
				.all(signer.deviceId),
		).toEqual([]);
	});
	test(`${kind} fixture detects broken actual link provenance rather than accepting a link row`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		await seed(f, h);
		f.db.exec("UPDATE coordinator_auth_link_attempts SET account_subject='not-the-born-subject'");
		const before = snapshot(f);
		// Act
		const target = await f.store.readAccountOwnerTarget(
			{ targetIdentityId: "identity-a", signer },
			f.cfg,
		);
		// Assert
		expect(target).toEqual({ kind: "unavailable" });
		expect(snapshot(f)).toEqual(before);
	});
}
