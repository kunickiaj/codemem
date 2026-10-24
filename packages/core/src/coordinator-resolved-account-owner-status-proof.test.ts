import { expect } from "vitest";
import { backendTest } from "./coordinator-auth-link-test-fixtures.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	history,
	originalController,
	revoke,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import {
	deterministicReviewTests,
	projectLabel,
} from "./coordinator-owner-resolution-review-test-fixtures.js";
import { ResolvedAccountOwnerStatusOperations } from "./coordinator-resolved-account-owner-status.js";
import {
	appendLegitimateFact,
	databaseSnapshot,
	expectDisplayOnly,
	expectNoDisclosure,
	overflowSources,
	replaceFacts,
	safeProfile,
	selectedOwnerId,
	setupResolved,
	signer,
	sourceController,
} from "./coordinator-resolved-account-owner-status-test-fixtures.js";

deterministicReviewTests();
for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind}: caller-supplied complete fact metadata never replaces missing persisted proof`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		if (!h.fact) throw new Error("missing fixture fact");
		const options = {
			ownerIdentityId: selectedOwnerId,
			sourceRef: h.fact.resolution,
			verified: true,
			authority: "controller_attestation",
		};
		replaceFacts(f, []);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(h.backend)
			.readResolvedAccountOwnerStatus(signer, f.cfg, options)
			.catch((error: unknown) => error);
		// Assert
		if (result instanceof Error) expect(result.message).toMatch(/invalid_input|unavailable/);
		else expectNoDisclosure(result);
	});
	test(`${kind}: a complete valid candidate is not hidden by an earlier incomplete same-owner receipt`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		if (!h.fact) throw new Error("missing fixture fact");
		const second = await appendLegitimateFact(f, h);
		replaceFacts(f, [
			{ ...h.fact.resolution, source_review_receipt_id: "wrong-receipt" },
			second.resolution,
		]);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expect(result).toMatchObject({ state: "owner_confirmed", profile: safeProfile });
	});
	test(`${kind}: persisted exact-device/key fact displays selected A without changing ordinary authority or any database state`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		const ordinary = await f.store.readAccountLinkStatus(signer, f.cfg, {
			identityId: selectedOwnerId,
		});
		const before = databaseSnapshot(f);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expect(result).toEqual({
			version: 1,
			coordinatorId: f.cfg.coordinatorId,
			groupId: signer.groupId,
			deviceId: signer.deviceId,
			fingerprint: signer.fingerprint,
			state: "owner_confirmed",
			ownerIdentity: selectedOwnerId,
			profileState: "linked",
			profile: safeProfile,
		});
		expectDisplayOnly(result);
		expect(h.finalRead.count).toBe(1);
		expect(ordinary.state).not.toBe("linked");
		expect(
			await f.store.readAccountLinkStatus(signer, f.cfg, { identityId: selectedOwnerId }),
		).toEqual(ordinary);
		expect(databaseSnapshot(f)).toEqual(before);
	});
	test(`${kind}: ordinary controller A alone cannot replace a persisted fact`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind, { fact: false });
		await originalController(f, "old-source-group");
		const options = { ownerIdentityId: selectedOwnerId };
		const before = databaseSnapshot(f);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, options);
		// Assert
		expectNoDisclosure(result);
		expectDisplayOnly(result);
		expect(databaseSnapshot(f)).toEqual(before);
	});
	test.for([
		["same key, other device", { device_id: "other-device" }],
		["same device, other canonical key", { key_id: "f".repeat(64) }],
		["foreign coordinator", { coordinator_id: "foreign-coordinator" }],
		["foreign selected owner", { owner_identity_id: "identity-b" }],
		["unknown weak metadata", { reviewed_weak_labels_json: '[{"label":"identity-c"}]' }],
	] as const)(
		`${kind}: %s is not persisted proof for this selection`,
		async ([, patch], { fixture: f }) => {
			// Arrange
			const h = await setupResolved(f, kind);
			if (!h.fact) throw new Error("missing fixture fact");
			replaceFacts(f, [{ ...h.fact.resolution, ...patch }]);
			const before = databaseSnapshot(f);
			// Act
			const result = await new ResolvedAccountOwnerStatusOperations(
				h.backend,
			).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
			// Assert
			expectNoDisclosure(result);
			expect(databaseSnapshot(f)).toEqual(before);
		},
	);
	test.for([
		"public_key=public_key || ' changed-original-text'",
		"enrollment_identity_id='identity-c'",
	] as const)(
		`${kind}: original source %s must match exactly`,
		async (assignment, { fixture: f }) => {
			// Arrange
			const h = await setupResolved(f, kind);
			sourceController(f, h, assignment);
			// Act
			const result = await new ResolvedAccountOwnerStatusOperations(
				h.backend,
			).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
			// Assert
			expectNoDisclosure(result);
		},
	);
	test(`${kind}: absent original source denies even with a complete persisted sidecar`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		f.db.exec("DELETE FROM coordinator_auth_controller_attestations");
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expectNoDisclosure(result);
	});
	test(`${kind}: removed source group/enrollment and later authentic weak labels do not expire a stable declaration`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		f.db.exec(
			"DELETE FROM enrolled_devices WHERE group_id='old-source-group'; DELETE FROM groups WHERE group_id='old-source-group'",
		);
		history(f, "later-history", "identity-later");
		projectLabel(f);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expect(result).toMatchObject({
			state: "owner_confirmed",
			ownerIdentity: selectedOwnerId,
			profile: safeProfile,
		});
	});
	test(`${kind}: an unknown current enrollment label denies instead of borrowing reviewed C`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id='unknown-label' WHERE device_id=?")
			.run(signer.deviceId);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expectNoDisclosure(result);
	});
	test.for([
		{ rows: 501, commentBytes: 0 },
		{ rows: 250, commentBytes: 3600 },
	])(
		`${kind}: over-limit stored source inventory fails closed (%j)`,
		async (size, { fixture: f }) => {
			// Arrange
			const h = await setupResolved(f, kind);
			overflowSources(f, size);
			// Act
			const result = await new ResolvedAccountOwnerStatusOperations(h.backend)
				.readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId })
				.catch((error: unknown) => {
					expect(error).toBeInstanceOf(Error);
					expect((error as Error).message).toMatch(/unavailable|upgrade_required/);
					return null;
				});
			// Assert
			if (result !== null) expectNoDisclosure(result);
		},
	);
	test(`${kind}: multiple legitimate same-owner writer receipts do not require a one-row count`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		await appendLegitimateFact(f, h);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expect(result).toMatchObject({ state: "owner_confirmed", profile: safeProfile });
	});
	test(`${kind}: two individually invalid facts cannot synthesize one source receipt`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		if (!h.fact) throw new Error("missing fixture fact");
		replaceFacts(f, [
			{ ...h.fact.resolution, source_review_receipt_id: "wrong-receipt" },
			{
				...h.fact.resolution,
				resolution_id: "partial-second",
				source_evidence_digest: "f".repeat(64),
			},
		]);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expectNoDisclosure(result);
	});
	test(`${kind}: original account device/key retirement is not account revocation`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		await revoke(f, "ed25519_key", true);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expect(result).toMatchObject({
			state: "owner_confirmed",
			profileState: "linked",
			profile: safeProfile,
		});
		expect(CANONICAL_PUBLIC_KEY).not.toBe(signer.publicKey);
	});
}
