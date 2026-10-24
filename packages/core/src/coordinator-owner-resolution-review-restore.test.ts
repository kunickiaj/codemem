import { createHash } from "node:crypto";
import { expect } from "vitest";
import { backendTest } from "./coordinator-auth-link-test-fixtures.js";
import { review } from "./coordinator-auth-store-test-fixtures.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import {
	buildReview,
	controllerTable,
	history,
	now,
	originalController,
	resolutionTable,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { OwnerResolutionReviewOperations } from "./coordinator-owner-resolution-review.js";
import {
	anotherGroup,
	deterministicReviewTests,
	existingFact,
	expectSafeDto,
	scope,
	selection,
	setupReview,
	signer,
	unrelatedChurn,
} from "./coordinator-owner-resolution-review-test-fixtures.js";

deterministicReviewTests();
for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind} same-owner other-device receipt cannot displace the exact device and key receipt`, async ({
		fixture: f,
	}) => {
		// Arrange: both receipts have accepted source controllers, not fabricated authorization rows.
		const h = await setupReview(f, kind);
		const first = await existingFact(f, h);
		const otherSigner = { ...signer, groupId: "other-source", deviceId: "other-laptop" };
		await f.store.createGroup(otherSigner.groupId);
		await f.store.enrollDevice(otherSigner.groupId, otherSigner);
		const source = await f.store.createAuthControllerAttestation(
			review({
				...otherSigner,
				attestationId: "other-controller",
				reviewReceiptId: "other-controller-receipt",
			}),
		);
		if (source.kind !== "created") throw new Error("other source controller rejected");
		const base = await buildReview(f);
		const legacyHistory = await f.store.captureAuthControllerLegacyHistory({
			coordinatorId: f.cfg.coordinatorId,
			...otherSigner,
		});
		const collection = await h.evidence.collect({
			canonicalOwnerId: "identity-a",
			actualSigner: otherSigner,
			verifiedHistory: legacyHistory,
		});
		if (collection.kind !== "collected") throw new Error("other subject evidence unavailable");
		const ownershipEvidenceDigest = await h.evidence.reviewedEvidenceDigest(
			collection.recheckSnapshot,
		);
		if (!ownershipEvidenceDigest) throw new Error("other subject evidence digest unavailable");
		const otherReview = {
			...base,
			controllerReview: review({
				...otherSigner,
				attestationId: "other-review-controller",
				reviewReceiptId: "other-review-receipt",
				verifiedSnapshot: {
					...base.controllerReview.verifiedSnapshot,
					enrollmentIdentityId: null,
					invites: [],
					legacyHistory,
				},
			}),
			existingController: source.attestation,
			resolutionId: "resolution-0-other-device",
			ownershipEvidenceDigest,
		};
		const consentDigest = createHash("sha256").update(JSON.stringify(otherReview)).digest("hex");
		otherReview.consent = {
			...base.consent,
			evidenceDigest: consentDigest,
			confirmedDigest: consentDigest,
		};
		const other = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review: otherReview,
			now,
		});
		expect(other.resolution.device_id).toBe(otherSigner.deviceId);
		expect(other.resolution.key_id).toBe(first.resolution.key_id);
		const before = snapshot(f);
		const batches = h.batchCount();
		// Act
		const result = await new OwnerResolutionReviewOperations(
			h.backend,
		).previewOwnerResolutionReview(selection, f.cfg);
		// Assert: key-only authority is not borrowed, and the unrelated receipt causes no ambiguity.
		expect(result).toMatchObject({
			state: "restored",
			attestation_id: first.controller.attestation_id,
			owner_resolution: {
				disposition: "reused",
				resolution_id: first.resolution.resolution_id,
				evidence_digest: first.resolution.resolution_evidence_digest,
			},
		});
		expectSafeDto(result);
		expect(snapshot(f)).toEqual(before);
		expect(h.batchCount()).toBe(batches);
	});
	test(`${kind} revoked oldest source does not hide a later valid exact-subject receipt in a fresh group`, async ({
		fixture: f,
	}) => {
		// Arrange: independent accepted A controllers back two immutable exact-subject receipts.
		const h = await setupReview(f, kind);
		const first = await existingFact(f, h);
		const source = await originalController(f, "second-source-group");
		const second = await commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review: await buildReview(f, {
				existingController: source,
				resolutionId: "resolution-second",
			}),
			now,
		});
		expect(second.controller.attestation_id).not.toBe(first.controller.attestation_id);
		f.db
			.prepare(`UPDATE ${controllerTable} SET revoked_at=? WHERE attestation_id=?`)
			.run(now, first.controller.attestation_id);
		const selected = await anotherGroup(f);
		const before = snapshot(f);
		const batches = h.batchCount();
		// Act: the requester has no current-group controller tombstone to bypass.
		const result = await new OwnerResolutionReviewOperations(
			h.backend,
		).previewOwnerResolutionReview(selected, f.cfg);
		// Assert: only the surviving source is reused; neither immutable receipt is repaired.
		expect(result).toMatchObject({
			state: "restored",
			attestation_id: second.controller.attestation_id,
			recovery_receipt: {
				disposition: "reused",
				review_receipt_id: second.controller.review_receipt_id,
				evidence_digest: second.controller.evidence_digest,
			},
			owner_resolution: {
				disposition: "reused",
				resolution_id: second.resolution.resolution_id,
				evidence_digest: second.resolution.resolution_evidence_digest,
			},
		});
		expectSafeDto(result);
		expect(snapshot(f)).toEqual(before);
		expect(h.batchCount()).toBe(batches);
		expect(f.db.prepare(`SELECT * FROM ${resolutionTable}`).all()).toEqual([
			first.resolution,
			second.resolution,
		]);
		expect(
			f.db.prepare(`SELECT * FROM ${controllerTable} WHERE group_id=?`).all(selected.groupId),
		).toEqual([]);
	});
	for (const location of ["same group", "other group"] as const) {
		test(`${kind} multiple legitimate same-owner exact-subject receipts restore deterministically in ${location}`, async ({
			fixture: f,
		}) => {
			// Arrange: append through the checked writer with fresh evidence and explicit consent.
			const h = await setupReview(f, kind);
			const first = await existingFact(f, h);
			const secondReview = await buildReview(f, {
				existingController: first.controller,
				resolutionId: "resolution-second",
			});
			const second = await commitReviewedOwnerResolution({
				backend: h.backend,
				evidence: h.evidence,
				review: secondReview,
				now,
			});
			expect(second).toMatchObject({
				controllerDisposition: "reused",
				resolutionDisposition: "created",
			});
			expect(second.controller).toEqual(first.controller);
			expect(second.resolution.resolution_evidence_digest).not.toBe(
				first.resolution.resolution_evidence_digest,
			);
			const selected = location === "same group" ? selection : await anotherGroup(f);
			const before = snapshot(f);
			const batches = h.batchCount();
			// Act: fresh operation instances must pick the same existing receipt without renewing it.
			const result = await new OwnerResolutionReviewOperations(
				h.backend,
			).previewOwnerResolutionReview(selected, f.cfg);
			const repeated = await new OwnerResolutionReviewOperations(
				h.backend,
			).previewOwnerResolutionReview(selected, f.cfg);
			// Assert: receipt count is not an ownership conflict; only stored authority may be reused.
			expect(result.state).toBe("restored");
			const chosen = [first.resolution, second.resolution].find(
				(row) => row.resolution_id === result.owner_resolution?.resolution_id,
			);
			expect(chosen).toBeDefined();
			expect(result).toMatchObject({
				purpose: "existing_account_owner",
				resolution_scope: scope,
				group_id: selected.groupId,
				attestation_id: first.controller.attestation_id,
				recovery_receipt: {
					disposition: "reused",
					review_receipt_id: first.controller.review_receipt_id,
					evidence_digest: first.controller.evidence_digest,
				},
				owner_resolution: {
					disposition: "reused",
					resolution_id: chosen?.resolution_id,
					evidence_digest: chosen?.resolution_evidence_digest,
					created_at: chosen?.created_at,
				},
			});
			expect(repeated).toEqual(result);
			expectSafeDto(result);
			expect(snapshot(f)).toEqual(before);
			expect(h.batchCount()).toBe(batches);
			expect(f.db.prepare(`SELECT * FROM ${resolutionTable}`).all()).toEqual([
				first.resolution,
				second.resolution,
			]);
			if (location === "other group")
				expect(
					f.db.prepare(`SELECT * FROM ${controllerTable} WHERE group_id=?`).all(selected.groupId),
				).toEqual([]);
		});
	}
	test(`${kind} valid global source cannot bypass a matching current controller tombstone`, async ({
		fixture: f,
	}) => {
		// Arrange: the valid source is elsewhere; the current group retains a revoked A controller.
		const h = await setupReview(f, kind);
		await existingFact(f, h, { retainedSource: true });
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id=NULL WHERE device_id=? AND group_id=?")
			.run(signer.deviceId, signer.groupId);
		expect(
			await f.store.createAuthControllerAttestation(
				review({
					...signer,
					attestationId: "current-tombstone",
					reviewReceiptId: "tombstone-receipt",
				}),
			),
		).toMatchObject({ kind: "created" });
		f.db.exec(
			"UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked' WHERE attestation_id='current-tombstone'",
		);
		f.db
			.prepare(
				"UPDATE enrolled_devices SET identity_id='identity-c' WHERE device_id=? AND group_id=?",
			)
			.run(signer.deviceId, signer.groupId);
		const before = snapshot(f);
		// Act
		const result = await new OwnerResolutionReviewOperations(
			h.backend,
		).previewOwnerResolutionReview(selection, f.cfg);
		// Assert
		expect(result.state).toBe("needs_review");
		expect(result).not.toHaveProperty("owner_resolution");
		expect(snapshot(f)).toEqual(before);
	});
	for (const location of ["same group", "other group", "deleted source group"] as const) {
		test(`${kind} verified global fact restores in ${location} with original receipts and zero writes`, async ({
			fixture: f,
		}) => {
			// Arrange: the fact and source are created by the checked writer, not fabricated receipt rows.
			const h = await setupReview(f, kind);
			const fact = await existingFact(f, h, {
				retainedSource: location === "deleted source group",
			});
			const selected = location === "same group" ? selection : await anotherGroup(f);
			if (location === "deleted source group") {
				f.db.prepare("DELETE FROM enrolled_devices WHERE group_id=?").run(fact.controller.group_id);
				f.db.prepare("DELETE FROM groups WHERE group_id=?").run(fact.controller.group_id);
			}
			const before = snapshot(f);
			const batches = h.batchCount();
			// Act
			const result = await new OwnerResolutionReviewOperations(
				h.backend,
			).previewOwnerResolutionReview(selected, f.cfg);
			// Assert: group-two receives no controller, grant, enrollment, or actor authority.
			expect(result).toMatchObject({
				state: "restored",
				purpose: "existing_account_owner",
				resolution_scope: scope,
				group_id: selected.groupId,
				attestation_id: fact.controller.attestation_id,
				recovery_receipt: {
					disposition: "reused",
					review_receipt_id: fact.controller.review_receipt_id,
					evidence_digest: fact.controller.evidence_digest,
				},
				owner_resolution: {
					disposition: "reused",
					resolution_id: fact.resolution.resolution_id,
					evidence_digest: fact.resolution.resolution_evidence_digest,
					created_at: fact.resolution.created_at,
				},
			});
			expectSafeDto(result);
			expect(result.owner_resolution_digest).toMatch(/^[a-f0-9]{64}$/);
			expect(snapshot(f)).toEqual(before);
			expect(h.batchCount()).toBe(batches);
			if (selected.groupId !== fact.controller.group_id)
				expect(
					f.db.prepare(`SELECT * FROM ${controllerTable} WHERE group_id=?`).all(selected.groupId),
				).toEqual([]);
		});
	}
	test(`${kind} more weak D history changes fresh digest but preserves all original resolution metadata`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupReview(f, kind);
		const fact = await existingFact(f, h);
		const operations = new OwnerResolutionReviewOperations(h.backend);
		const original = await operations.previewOwnerResolutionReview(selection, f.cfg);
		history(f, "history-d", "identity-d");
		const before = snapshot(f);
		// Act
		const result = await operations.previewOwnerResolutionReview(selection, f.cfg);
		// Assert: readonly lookup never renews the declaration to include unreviewed history.
		expect(result.state).toBe("restored");
		expect(result.owner_resolution_digest).not.toBe(original.owner_resolution_digest);
		expect(result.owner_resolution).toEqual(original.owner_resolution);
		expect(result.recovery_receipt).toEqual(original.recovery_receipt);
		expect(f.db.prepare(`SELECT * FROM ${resolutionTable}`).get()).toEqual(fact.resolution);
		expect(Object.keys(fact.resolution)).toHaveLength(20);
		expect(snapshot(f)).toEqual(before);
	});
	for (const mutation of [
		"DELETE FROM coordinator_auth_controller_attestations",
		"UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked'",
		"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='replacement-receipt'",
		"UPDATE coordinator_auth_controller_attestations SET device_id='different-device'",
		"UPDATE coordinator_auth_controller_attestations SET created_at='2026-10-01T00:00:00.000Z'",
	]) {
		test(`${kind} invalid retained source cannot silently renew or fall back: ${mutation}`, async ({
			fixture: f,
		}) => {
			// Arrange
			const h = await setupReview(f, kind);
			await existingFact(f, h);
			f.db.exec(mutation);
			const before = snapshot(f);
			const batches = h.batchCount();
			const operations = new OwnerResolutionReviewOperations(h.backend);
			// Act
			const result = await operations.previewOwnerResolutionReview(selection, f.cfg);
			// Assert: even explicit fresh confirmation must not repair an invalid immutable reference.
			expect(result.state).toBe("needs_review");
			expect(result).not.toHaveProperty("owner_resolution_digest");
			expect(result).not.toHaveProperty("owner_resolution");
			await expect(
				operations.confirmOwnerResolutionReview(
					{ ...selection, confirmOwnerResolutionDigest: "a".repeat(64) },
					f.cfg,
				),
			).rejects.toMatchObject({ code: "review_stale" });
			expect(snapshot(f)).toEqual(before);
			expect(h.batchCount()).toBe(batches);
		});
	}
	test(`${kind} matching key on OTHER device cannot restore a global fact for the original device`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupReview(f, kind);
		await existingFact(f, h);
		await f.store.createGroup("group-two");
		await f.store.enrollDevice("group-two", { ...signer, deviceId: "other-device" });
		const selected = { ...selection, groupId: "group-two", deviceId: "other-device" };
		const before = snapshot(f);
		// Act
		const result = await new OwnerResolutionReviewOperations(
			h.backend,
		).previewOwnerResolutionReview(selected, f.cfg);
		// Assert
		expect(result.state).toBe("needs_review");
		expect(result).not.toHaveProperty("owner_resolution");
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} unrelated people and discovery-only valid-key false positives do not churn confirmation`, async ({
		fixture: f,
	}) => {
		// Arrange: this parser-compatible key is valid but has different raw bytes from the requester.
		const h = await setupReview(f, kind);
		const operations = new OwnerResolutionReviewOperations(h.backend);
		const original = await operations.previewOwnerResolutionReview(selection, f.cfg);
		await unrelatedChurn(f);
		const before = snapshot(f);
		// Act
		const result = await operations.previewOwnerResolutionReview(selection, f.cfg);
		// Assert
		expect(result.state).toBe("ready");
		expect(result.owner_resolution_digest).toBe(original.owner_resolution_digest);
		expect(snapshot(f)).toEqual(before);
	});
}
