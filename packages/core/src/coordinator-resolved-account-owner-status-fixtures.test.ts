import { expect } from "vitest";
import { backendTest } from "./coordinator-auth-link-test-fixtures.js";
import { buildReview } from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { captureLegacyOwnerResolutionRecord } from "./coordinator-legacy-owner-resolution-metadata.js";
import {
	deterministicReviewTests,
	reconnectTarget,
} from "./coordinator-owner-resolution-review-test-fixtures.js";
import {
	appendLegitimateFact,
	databaseSnapshot,
	overflowSources,
	replaceFacts,
	safeProfile,
	seedCurrentProfile,
	selectedOwnerId,
	setupResolved,
	signer,
	sourceController,
	strongOtherOwner,
} from "./coordinator-resolved-account-owner-status-test-fixtures.js";

deterministicReviewTests();
for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test.for([
		{ rows: 501, commentBytes: 0 },
		{ rows: 250, commentBytes: 3600 },
	])(
		`${kind} controls: actual persisted source rows exceed the collector row/byte limit (%j)`,
		async (size, { fixture: f }) => {
			// Arrange
			const h = await setupResolved(f, kind);
			const review = await buildReview(f);
			overflowSources(f, size);
			// Act
			const result = await h.evidence.collect({
				canonicalOwnerId: selectedOwnerId,
				actualSigner: signer,
				verifiedHistory: review.controllerReview.verifiedSnapshot?.legacyHistory,
			});
			// Assert
			expect(result).toEqual({ kind: "unavailable", authorizationUnavailable: true });
		},
	);
	test(`${kind} controls: a successor profile belongs to its verified new generation`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupResolved(f, kind);
		reconnectTarget(f);
		const profile = {
			...safeProfile,
			displayName: "Current Generation A",
			email: "current-a@example.test",
		};
		seedCurrentProfile(f, { attemptId: "successor-attempt", profile });
		const origin = f.db
			.prepare("SELECT * FROM enrolled_devices WHERE device_id='device-a'")
			.get() as { group_id: string; device_id: string; public_key: string; fingerprint: string };
		// Act
		const status = await f.store.readAccountLinkStatus(
			{
				groupId: origin.group_id,
				deviceId: origin.device_id,
				publicKey: origin.public_key,
				fingerprint: origin.fingerprint,
			},
			f.cfg,
			{ identityId: selectedOwnerId },
		);
		// Assert
		expect(status).toMatchObject({ state: "linked", account: profile });
		expect(f.db.prepare("SELECT count(*) AS n FROM coordinator_auth_link_profiles").get()).toEqual({
			n: 2,
		});
	});
	test(`${kind} controls: strong B is collected from a stored controller, never from a classification flag`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		const review = await buildReview(f);
		strongOtherOwner(f);
		// Act
		const result = await h.evidence.collect({
			canonicalOwnerId: selectedOwnerId,
			actualSigner: signer,
			verifiedHistory: review.controllerReview.verifiedSnapshot?.legacyHistory,
		});
		// Assert
		expect(result.kind).toBe("collected");
		if (result.kind !== "collected") throw new Error("fixture collection unavailable");
		expect(result.decision).toBe("owner_transfer_required");
	});
	test(`${kind} controls: imported sidecar fixture retains accepted DDL and cannot manufacture a valid mismatched source`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		if (!h.fact) throw new Error("missing fixture fact");
		replaceFacts(f, [{ ...h.fact.resolution, source_review_receipt_id: "wrong-receipt" }]);
		const persisted = f.db.prepare("SELECT * FROM coordinator_legacy_owner_resolutions").get();
		// Act
		const captured = await captureLegacyOwnerResolutionRecord(persisted);
		const result = await h.evidence.verifyControllerSource({
			sourceRef: persisted,
			expectedOwnerId: selectedOwnerId,
			actualSigner: signer,
		});
		// Assert
		expect(captured).not.toBeNull();
		expect(result).toEqual({ kind: "source_mismatch" });
	});
	test(`${kind} controls: injection runs at the real final-table SQL boundary, not during preliminary source SQL`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		let injected = 0;
		h.finalRead.inject = () => {
			injected++;
		};
		// Act
		await h.backend.first({
			sql: "SELECT count(*) AS n FROM coordinator_auth_controller_attestations",
			values: [],
		});
		const beforeFinal = injected;
		await h.backend.first({
			sql: "SELECT count(*) AS n FROM coordinator_auth_link_profiles CROSS JOIN coordinator_legacy_owner_resolutions WHERE EXISTS (SELECT 1 FROM sqlite_master)",
			values: [],
		});
		// Assert
		expect(beforeFinal).toBe(0);
		expect(injected).toBe(1);
		expect(h.finalRead.count).toBe(1);
	});
	test(`${kind} controls: actual account birth discloses verified current profile only to its ordinary origin`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupResolved(f, kind);
		const origin = f.db
			.prepare("SELECT * FROM enrolled_devices WHERE device_id='device-a'")
			.get() as { group_id: string; device_id: string; public_key: string; fingerprint: string };
		const before = databaseSnapshot(f);
		// Act
		const status = await f.store.readAccountLinkStatus(
			{
				groupId: origin.group_id,
				deviceId: origin.device_id,
				publicKey: origin.public_key,
				fingerprint: origin.fingerprint,
			},
			f.cfg,
			{ identityId: selectedOwnerId },
		);
		const requester = await f.store.readAccountLinkStatus(signer, f.cfg, {
			identityId: selectedOwnerId,
		});
		// Assert
		expect(status).toMatchObject({ state: "linked", account: safeProfile });
		expect(requester.state).not.toBe("linked");
		expect(databaseSnapshot(f)).toEqual(before);
	});
	test(`${kind} controls: checked writer persisted all twenty fact and thirteen original source fields`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		if (!h.fact) throw new Error("missing fixture fact");
		const persisted = f.db.prepare("SELECT * FROM coordinator_legacy_owner_resolutions").get();
		// Act
		const captured = await captureLegacyOwnerResolutionRecord(persisted);
		const proof = await h.evidence.verifyControllerSource({
			sourceRef: persisted,
			expectedOwnerId: selectedOwnerId,
			actualSigner: signer,
		});
		// Assert
		expect(captured).toEqual(h.fact.resolution);
		expect(Object.keys(captured ?? {})).toHaveLength(20);
		expect(Object.keys(h.fact.controller)).toHaveLength(13);
		expect(proof).toEqual({ kind: "verified_controller_source" });
	});
	test(`${kind} controls: original receipt mutation is not positive source proof`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		if (!h.fact) throw new Error("missing fixture fact");
		sourceController(f, h, "review_receipt_id='tampered-receipt'");
		// Act
		const proof = await h.evidence.verifyControllerSource({
			sourceRef: h.fact.resolution,
			expectedOwnerId: selectedOwnerId,
			actualSigner: signer,
		});
		// Assert
		expect(proof).toEqual({ kind: "source_mismatch" });
	});
	test(`${kind} controls: multiple same-owner receipts are independently produced by the checked writer`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		// Act
		const second = await appendLegitimateFact(f, h);
		// Assert
		expect(second.resolution.resolution_id).toBe("resolution-second");
		expect(
			f.db.prepare("SELECT count(*) AS n FROM coordinator_legacy_owner_resolutions").get(),
		).toEqual({ n: 2 });
		expect(
			await h.evidence.verifyControllerSource({
				sourceRef: second.resolution,
				expectedOwnerId: selectedOwnerId,
				actualSigner: signer,
			}),
		).toEqual({ kind: "verified_controller_source" });
	});
}
