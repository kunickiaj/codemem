import { createHash } from "node:crypto";
import { expect } from "vitest";
import { backendTest, NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	controllerTable,
	history,
	originalController,
	resolutionTable,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { OwnerResolutionReviewOperations } from "./coordinator-owner-resolution-review.js";
import {
	deterministicReviewTests,
	expectSafeDto,
	projectLabel,
	reconnectTarget,
	scope,
	selection,
	setupReview,
	signer,
} from "./coordinator-owner-resolution-review-test-fixtures.js";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
deterministicReviewTests();
for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind} fresh explicit confirmation creates only both receipts even after clock advances`, async ({
		fixture: f,
	}) => {
		// Arrange: prospective creation time is not evidence to be confirmed.
		const h = await setupReview(f, kind);
		let clock = NOW;
		const operations = new OwnerResolutionReviewOperations(h.backend, () => clock);
		const preview = await operations.previewOwnerResolutionReview(selection, f.cfg);
		const unaffected = snapshot(f, [controllerTable, resolutionTable]);
		clock += 60_000;
		const fresh = await operations.previewOwnerResolutionReview(selection, f.cfg);
		// Act
		const result = await operations.confirmOwnerResolutionReview(
			{ ...selection, confirmOwnerResolutionDigest: preview.owner_resolution_digest },
			f.cfg,
		);
		// Assert: ID formulas match existing factories; no id/hash cycle or new authority enum.
		const controllerId = `controller-v1:${sha([f.cfg.coordinatorId, selection.groupId, selection.deviceId, selection.fingerprint])}`;
		expect(fresh.owner_resolution_digest).toBe(preview.owner_resolution_digest);
		expect(result).toMatchObject({
			state: "ready",
			purpose: "existing_account_owner",
			resolution_scope: scope,
			attestation_id: controllerId,
			recovery_receipt: {
				disposition: "created",
				evidence_digest: preview.owner_resolution_digest,
				review_receipt_id: `review-v1:${sha([controllerId, selection.identityId, preview.owner_resolution_digest])}`,
			},
			owner_resolution: {
				disposition: "created",
				resolution_id: expect.any(String),
				evidence_digest: preview.owner_resolution_digest,
				created_at: new Date(clock).toISOString(),
			},
		});
		const controller = f.db.prepare(`SELECT * FROM ${controllerTable}`).get();
		const resolution = f.db.prepare(`SELECT * FROM ${resolutionTable}`).get();
		expect(controller).toMatchObject({
			attestation_id: result.attestation_id,
			device_id: signer.deviceId,
			public_key: signer.publicKey,
			identity_id: "identity-a",
			enrollment_identity_id: "identity-c",
			evidence_digest: preview.owner_resolution_digest,
		});
		expect(resolution).toMatchObject({
			resolution_id: result.owner_resolution?.resolution_id,
			source_attestation_id: result.attestation_id,
			source_review_receipt_id: result.recovery_receipt?.review_receipt_id,
			resolution_evidence_digest: preview.owner_resolution_digest,
		});
		expect(snapshot(f, [controllerTable, resolutionTable])).toEqual(unaffected);
		expect(h.batchCount()).toBe(1);
		expectSafeDto(result);
	});
	for (const sourceGroup of [signer.groupId, "removed-source-group"]) {
		test(`${kind} fresh scoped consent reuses old normal A controller from ${sourceGroup} without renewing its original receipt`, async ({
			fixture: f,
		}) => {
			// Arrange: ordinary controller exists before C was assigned by retained history.
			const h = await setupReview(f, kind, false);
			const original = await originalController(f, sourceGroup);
			if (sourceGroup !== signer.groupId) {
				f.db.prepare("DELETE FROM enrolled_devices WHERE group_id=?").run(sourceGroup);
				f.db.prepare("DELETE FROM groups WHERE group_id=?").run(sourceGroup);
			}
			f.db
				.prepare("UPDATE enrolled_devices SET identity_id='identity-c' WHERE device_id=?")
				.run(signer.deviceId);
			const operations = new OwnerResolutionReviewOperations(h.backend, () => NOW);
			const preview = await operations.previewOwnerResolutionReview(selection, f.cfg);
			const before = snapshot(f, [resolutionTable]);
			// Act
			const result = await operations.confirmOwnerResolutionReview(
				{ ...selection, confirmOwnerResolutionDigest: preview.owner_resolution_digest },
				f.cfg,
			);
			// Assert
			expect(result).toMatchObject({
				attestation_id: original.attestation_id,
				recovery_receipt: {
					disposition: "reused",
					review_receipt_id: original.review_receipt_id,
					evidence_digest: original.evidence_digest,
				},
				owner_resolution: {
					disposition: "created",
					evidence_digest: preview.owner_resolution_digest,
				},
			});
			expect(f.db.prepare(`SELECT * FROM ${controllerTable}`).get()).toEqual(original);
			expect(snapshot(f, [resolutionTable])).toEqual(before);
		});
	}
	for (const [name, confirm] of Object.entries({
		missing: {},
		wrong: { confirmOwnerResolutionDigest: "0".repeat(64) },
		ordinary: { confirmEvidenceDigest: "a".repeat(64) },
	})) {
		test(`${kind} ${name} confirmation cannot create receipts`, async ({ fixture: f }) => {
			// Arrange
			const h = await setupReview(f, kind);
			const operations = new OwnerResolutionReviewOperations(h.backend);
			await operations.previewOwnerResolutionReview(selection, f.cfg);
			const before = snapshot(f);
			// Act / Assert
			await expect(
				operations.confirmOwnerResolutionReview({ ...selection, ...confirm }, f.cfg),
			).rejects.toMatchObject({ code: "review_stale" });
			expect(snapshot(f)).toEqual(before);
			expect(h.batchCount()).toBe(0);
		});
	}
	for (const change of [
		"history",
		"Project",
		"target generation",
		"config revision",
		"retained source",
	] as const) {
		test(`${kind} ${change} changes require new human confirmation`, async ({ fixture: f }) => {
			// Arrange
			const h = await setupReview(f, kind, change !== "retained source");
			if (change === "retained source") await originalController(f);
			const operations = new OwnerResolutionReviewOperations(h.backend);
			const preview = await operations.previewOwnerResolutionReview(selection, f.cfg);
			let config = f.cfg;
			if (change === "history") history(f, "history-d", "identity-d");
			if (change === "Project") projectLabel(f);
			if (change === "target generation") reconnectTarget(f);
			if (change === "config revision") config = { ...f.cfg, revision: "f".repeat(64) };
			if (change === "retained source")
				f.db.exec(
					"UPDATE coordinator_auth_controller_attestations SET created_at='2026-10-01T00:00:00.000Z'",
				);
			const before = snapshot(f);
			// Act
			const fresh = await operations.previewOwnerResolutionReview(selection, config);
			// Assert: changed state remains otherwise confirmable; this checks freshness, not only denial.
			expect(fresh.state).toBe("ready");
			expect(fresh.owner_resolution_digest).toMatch(/^[a-f0-9]{64}$/);
			expect(fresh.owner_resolution_digest).not.toBe(preview.owner_resolution_digest);
			await expect(
				operations.confirmOwnerResolutionReview(
					{ ...selection, confirmOwnerResolutionDigest: preview.owner_resolution_digest },
					config,
				),
			).rejects.toMatchObject({ code: "review_stale" });
			expect(snapshot(f)).toEqual(before);
			expect(h.batchCount()).toBe(0);
		});
	}
	test(`${kind} lost reply makes old empty-evidence confirmation stale; status restores without writing`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupReview(f, kind);
		const operations = new OwnerResolutionReviewOperations(h.backend);
		const preview = await operations.previewOwnerResolutionReview(selection, f.cfg);
		const request = { ...selection, confirmOwnerResolutionDigest: preview.owner_resolution_digest };
		const applied = await operations.confirmOwnerResolutionReview(request, f.cfg);
		const before = snapshot(f);
		const batches = h.batchCount();
		// Act / Assert
		await expect(operations.confirmOwnerResolutionReview(request, f.cfg)).rejects.toMatchObject({
			code: "review_stale",
		});
		const restored = await operations.previewOwnerResolutionReview(selection, f.cfg);
		expect(restored).toMatchObject({
			state: "restored",
			attestation_id: applied.attestation_id,
			recovery_receipt: { ...applied.recovery_receipt, disposition: "reused" },
			owner_resolution: { ...applied.owner_resolution, disposition: "reused" },
		});
		expect(snapshot(f)).toEqual(before);
		expect(h.batchCount()).toBe(batches);
	});
	for (const phase of ["writer", "after commit", "postcommit read"] as const) {
		test(`${kind} unexpected ${phase} failure reports unknown outcome rather than claiming rollback`, async ({
			fixture: f,
		}) => {
			// Arrange
			const h = await setupReview(f, kind);
			const operations = new OwnerResolutionReviewOperations(h.backend);
			const preview = await operations.previewOwnerResolutionReview(selection, f.cfg);
			const fail = () => {
				throw new Error("synthetic private backend failure");
			};
			if (phase === "writer") h.hooks.beforeBatch = fail;
			if (phase === "after commit") h.hooks.afterBatch = fail;
			if (phase === "postcommit read")
				h.hooks.beforeFirst = () => {
					if (h.batchCount() > 0) fail();
				};
			// Act / Assert
			await expect(
				operations.confirmOwnerResolutionReview(
					{ ...selection, confirmOwnerResolutionDigest: preview.owner_resolution_digest },
					f.cfg,
				),
			).rejects.toMatchObject({ code: "owner_resolution_outcome_unknown" });
			h.hooks.beforeBatch = undefined;
			h.hooks.afterBatch = undefined;
			h.hooks.beforeFirst = undefined;
			const restored = await operations.previewOwnerResolutionReview(selection, f.cfg);
			expect(restored.state).toBe(phase === "writer" ? "ready" : "restored");
			for (const table of [controllerTable, resolutionTable])
				expect(f.db.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(
					phase === "writer" ? 0 : 1,
				);
		});
	}
}
