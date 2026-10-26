import { expect, vi } from "vitest";
import { backendTest } from "./coordinator-auth-link-test-fixtures.js";
import type { LegacyOwnerResolutionRecord } from "./coordinator-legacy-owner-resolution-metadata.js";
import { deterministicReviewTests } from "./coordinator-owner-resolution-review-test-fixtures.js";
import { ResolvedAccountOwnerStatusOperations } from "./coordinator-resolved-account-owner-status.js";
import {
	appendLegitimateFact,
	databaseSnapshot,
	expectDisplayOnly,
	expectNoDisclosure,
	replaceFacts,
	selectedOwnerId,
	setupResolved,
	signer,
	sourceController,
	withheldProfile,
} from "./coordinator-resolved-account-owner-status-test-fixtures.js";

deterministicReviewTests();
function reference(row: LegacyOwnerResolutionRecord) {
	return {
		attestationId: row.source_attestation_id,
		reviewReceiptId: row.source_review_receipt_id,
		reviewEvidenceDigest: row.source_evidence_digest,
		resolutionId: row.resolution_id,
		resolutionEvidenceDigest: row.resolution_evidence_digest,
	};
}
for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind}: genuine ordinary-controller references confirm A without writes or mutation authority`, async ({
		fixture: f,
	}) => {
		// Arrange: the source IDs are ordinary storage-contract IDs, not generated prefixes.
		const h = await setupResolved(f, kind);
		if (!h.fact) throw new Error("fixture fact missing");
		const expectedReceipt = reference(h.fact.resolution);
		const before = databaseSnapshot(f);
		const ordinary = await f.store.readAccountLinkStatus(signer, f.cfg, {
			identityId: selectedOwnerId,
		});
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, {
			ownerIdentityId: selectedOwnerId,
			expectedReceipt,
		});
		// Assert
		expect(expectedReceipt).toMatchObject({
			attestationId: "original-controller",
			reviewReceiptId: "original-receipt",
		});
		expect(result).toMatchObject({ state: "owner_confirmed", profile: withheldProfile });
		expectDisplayOnly(result);
		expect(ordinary.state).not.toBe("linked");
		expect(
			await f.store.readAccountLinkStatus(signer, f.cfg, { identityId: selectedOwnerId }),
		).toEqual(ordinary);
		expect(databaseSnapshot(f)).toEqual(before);
	});
	test.for([
		"attestationId",
		"reviewReceiptId",
		"reviewEvidenceDigest",
		"resolutionId",
		"resolutionEvidenceDigest",
	] as const)(`${kind}: wrong %s cannot borrow a valid A fact`, async (field, { fixture: f }) => {
		// Arrange
		const h = await setupResolved(f, kind);
		if (!h.fact) throw new Error("fixture fact missing");
		const expectedReceipt = {
			...reference(h.fact.resolution),
			[field]: field.endsWith("Digest") ? "0".repeat(64) : "not-the-pasted-receipt",
		};
		const before = databaseSnapshot(f);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, {
			ownerIdentityId: selectedOwnerId,
			expectedReceipt,
		});
		// Assert
		expectNoDisclosure(result);
		expect(databaseSnapshot(f)).toEqual(before);
	});
	test(`${kind}: either complete checked-writer receipt works but cross-row resolution ID/digest does not`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		if (!h.fact) throw new Error("fixture fact missing");
		const second = await appendLegitimateFact(f, h);
		const firstRef = reference(h.fact.resolution);
		const secondRef = reference(second.resolution);
		const reader = new ResolvedAccountOwnerStatusOperations(h.backend);
		// Act
		const first = await reader.readResolvedAccountOwnerStatus(signer, f.cfg, {
			ownerIdentityId: selectedOwnerId,
			expectedReceipt: firstRef,
		});
		const next = await reader.readResolvedAccountOwnerStatus(signer, f.cfg, {
			ownerIdentityId: selectedOwnerId,
			expectedReceipt: secondRef,
		});
		const mixed = await reader.readResolvedAccountOwnerStatus(signer, f.cfg, {
			ownerIdentityId: selectedOwnerId,
			expectedReceipt: { ...firstRef, resolutionId: secondRef.resolutionId },
		});
		// Assert: both components really exist, but never together on one record.
		expect(firstRef.resolutionId).not.toBe(secondRef.resolutionId);
		expect(firstRef.resolutionEvidenceDigest).not.toBe(secondRef.resolutionEvidenceDigest);
		expect(first).toMatchObject({ state: "owner_confirmed", profile: withheldProfile });
		expect(next).toMatchObject({ state: "owner_confirmed", profile: withheldProfile });
		expectNoDisclosure(mixed);
	});
	test.for([
		"undefined",
		"null",
		"missing-field",
		"extra-field",
		"getter",
		"inherited",
		"uppercase-digest",
		"outer-getter",
		"outer-inherited",
	])(
		`${kind}: supplied %s receipt fails before querying and is not ignored`,
		async (mode, { fixture: f }) => {
			// Arrange
			const h = await setupResolved(f, kind);
			if (!h.fact) throw new Error("fixture fact missing");
			let expectedReceipt: unknown = reference(h.fact.resolution);
			const access = vi.fn(() => {
				throw new Error("receipt getter must not run");
			});
			if (mode === "undefined") expectedReceipt = undefined;
			if (mode === "null") expectedReceipt = null;
			if (mode === "missing-field") {
				const { resolutionId: _, ...rest } = reference(h.fact.resolution);
				expectedReceipt = rest;
			}
			if (mode === "extra-field")
				expectedReceipt = { ...reference(h.fact.resolution), authority: "controller_attestation" };
			if (mode === "getter")
				Object.defineProperty(expectedReceipt, "resolutionId", { get: access });
			if (mode === "inherited") expectedReceipt = Object.create(expectedReceipt);
			if (mode === "uppercase-digest")
				expectedReceipt = {
					...reference(h.fact.resolution),
					reviewEvidenceDigest: h.fact.resolution.source_evidence_digest.toUpperCase(),
				};
			const first = vi.spyOn(h.backend, "first");
			const all = vi.spyOn(h.backend, "all");
			const options = { ownerIdentityId: selectedOwnerId, expectedReceipt };
			if (mode === "outer-getter")
				Object.defineProperty(options, "expectedReceipt", { get: access });
			if (mode === "outer-inherited") {
				Object.setPrototypeOf(options, { expectedReceipt });
				Reflect.deleteProperty(options, "expectedReceipt");
			}
			// Act
			const pending = new ResolvedAccountOwnerStatusOperations(
				h.backend,
			).readResolvedAccountOwnerStatus(signer, f.cfg, options);
			// Assert
			await expect(pending).rejects.toThrow(/unavailable|invalid_input/);
			expect(access).not.toHaveBeenCalled();
			expect(first).not.toHaveBeenCalled();
			expect(all).not.toHaveBeenCalled();
		},
	);
	test.for(["receipt-swapped", "source-revoked"])(
		`${kind}: final profile SELECT denies %s despite another valid A receipt`,
		async (mode, { fixture: f }) => {
			// Arrange: immutable fact replacement models imported corruption, not a legal UPDATE.
			const h = await setupResolved(f, kind);
			if (!h.fact) throw new Error("fixture fact missing");
			const fact = h.fact;
			const second = await appendLegitimateFact(f, h);
			const expectedReceipt = reference(fact.resolution);
			h.finalRead.inject = () => {
				if (mode === "source-revoked")
					sourceController(f, h, "revoked_at='2026-10-02T00:00:00.000Z'");
				else
					replaceFacts(f, [
						{
							...fact.resolution,
							resolution_evidence_digest: second.resolution.resolution_evidence_digest,
						},
						second.resolution,
					]);
			};
			// Act
			const result = await new ResolvedAccountOwnerStatusOperations(
				h.backend,
			).readResolvedAccountOwnerStatus(signer, f.cfg, {
				ownerIdentityId: selectedOwnerId,
				expectedReceipt,
			});
			// Assert
			expect(h.finalRead.count).toBe(1);
			expectNoDisclosure(result);
		},
	);
	test(`${kind}: absent expectedReceipt preserves the accepted unconstrained read`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expect(result).toMatchObject({ state: "owner_confirmed", profile: withheldProfile });
		expectDisplayOnly(result);
	});
}
