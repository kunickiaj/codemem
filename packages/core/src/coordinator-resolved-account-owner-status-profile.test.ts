import { expect } from "vitest";
import { backendTest } from "./coordinator-auth-link-test-fixtures.js";
import {
	deterministicReviewTests,
	reconnectTarget,
} from "./coordinator-owner-resolution-review-test-fixtures.js";
import { ResolvedAccountOwnerStatusOperations } from "./coordinator-resolved-account-owner-status.js";
import {
	databaseSnapshot,
	expectDisplayOnly,
	safeProfile,
	selectedOwnerId,
	setupResolved,
	signer,
} from "./coordinator-resolved-account-owner-status-test-fixtures.js";

deterministicReviewTests();
for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test.for([0, null])(
		`${kind}: email verification %j never discloses an unverified email`,
		async (verified, { fixture: f }) => {
			// Arrange
			const h = await setupResolved(f, kind);
			f.db.prepare("UPDATE coordinator_auth_link_profiles SET email_verified=?").run(verified);
			const before = databaseSnapshot(f);
			// Act
			const result = await new ResolvedAccountOwnerStatusOperations(
				h.backend,
			).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
			// Assert
			expect(result).toMatchObject({
				state: "owner_confirmed",
				profileState: "linked",
				profile: { displayName: safeProfile.displayName, pictureUrl: safeProfile.pictureUrl },
			});
			expect(result.profile).not.toHaveProperty("email");
			expect(databaseSnapshot(f)).toEqual(before);
		},
	);
	test(`${kind}: control text and credential-bearing pictures are filtered by the existing safe-profile policy`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		f.db
			.prepare("UPDATE coordinator_auth_link_profiles SET display_name=?,picture_url=?")
			.run("Unsafe\u0001name", "https://user:password@lh3.googleusercontent.com/image");
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expect(result).toMatchObject({
			state: "owner_confirmed",
			profileState: "linked",
			profile: { email: safeProfile.email },
		});
		expect(result.profile).not.toHaveProperty("displayName");
		expect(result.profile).not.toHaveProperty("pictureUrl");
	});
	test.for([
		"DELETE FROM coordinator_auth_account_links",
		"UPDATE coordinator_auth_account_links SET revoked_at_ms=1791028800001",
	])(
		`${kind}: disconnected account (%s) preserves independent owner proof but never stale profile`,
		async (sql, { fixture: f }) => {
			// Arrange: only remove/revoke the Google link, not the independent selected source.
			const h = await setupResolved(f, kind);
			const factBefore = f.db.prepare("SELECT * FROM coordinator_legacy_owner_resolutions").all();
			f.db.exec(sql);
			const before = databaseSnapshot(f);
			// Act
			const result = await new ResolvedAccountOwnerStatusOperations(
				h.backend,
			).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
			// Assert
			expect(result).toMatchObject({
				state: "owner_confirmed",
				ownerIdentity: selectedOwnerId,
				profileState: "account_unlinked",
				profile: null,
			});
			expectDisplayOnly(result);
			expect(f.db.prepare("SELECT * FROM coordinator_legacy_owner_resolutions").all()).toEqual(
				factBefore,
			);
			expect(databaseSnapshot(f)).toEqual(before);
		},
	);
	test(`${kind}: broken current account birth is unavailable, not a false disconnected account`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		f.db.exec(
			"UPDATE coordinator_auth_link_attempts SET account_subject='wrong-generation-subject'",
		);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expect(result).toMatchObject({
			state: "owner_confirmed",
			ownerIdentity: selectedOwnerId,
			profileState: "unavailable",
			profile: null,
		});
	});
	test(`${kind}: a valid successor generation cannot inherit the old generation's profile`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		reconnectTarget(f);
		// Act
		const result = await new ResolvedAccountOwnerStatusOperations(
			h.backend,
		).readResolvedAccountOwnerStatus(signer, f.cfg, { ownerIdentityId: selectedOwnerId });
		// Assert
		expect(result.state).toBe("owner_confirmed");
		expect(JSON.stringify(result.profile)).not.toContain(safeProfile.email);
		if (result.profile !== null)
			expect(result.profile).not.toHaveProperty("displayName", safeProfile.displayName);
	});
	test(`${kind}: unsupported sidecar schema and storage failures throw unavailable/upgrade errors, never false unlink`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		f.db.exec("DROP INDEX idx_legacy_owner_resolutions_key");
		const unavailable = {
			...h.backend,
			async first<T>(): Promise<T | null> {
				throw new Error("synthetic storage failure");
			},
			async all<T>(): Promise<T[]> {
				throw new Error("synthetic storage failure");
			},
		};
		// Act / Assert
		await expect(
			new ResolvedAccountOwnerStatusOperations(h.backend).readResolvedAccountOwnerStatus(
				signer,
				f.cfg,
				{ ownerIdentityId: selectedOwnerId },
			),
		).rejects.toThrow(/unavailable|upgrade_required/);
		await expect(
			new ResolvedAccountOwnerStatusOperations(unavailable).readResolvedAccountOwnerStatus(
				signer,
				f.cfg,
				{ ownerIdentityId: selectedOwnerId },
			),
		).rejects.toThrow(/unavailable|upgrade_required/);
	});
}
