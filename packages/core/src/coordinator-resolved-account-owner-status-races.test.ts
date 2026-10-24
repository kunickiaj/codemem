import { expect } from "vitest";
import type { LinkFixture } from "./coordinator-auth-link-test-fixtures.js";
import { backendTest } from "./coordinator-auth-link-test-fixtures.js";
import { revoke } from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import {
	deterministicReviewTests,
	reconnectTarget,
} from "./coordinator-owner-resolution-review-test-fixtures.js";
import { ResolvedAccountOwnerStatusOperations } from "./coordinator-resolved-account-owner-status.js";
import type { ResolvedHarness } from "./coordinator-resolved-account-owner-status-test-fixtures.js";
import {
	databaseSnapshot,
	expectNoDisclosure,
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

async function readOrUnavailable(f: LinkFixture, h: ResolvedHarness) {
	try {
		return await new ResolvedAccountOwnerStatusOperations(h.backend).readResolvedAccountOwnerStatus(
			signer,
			f.cfg,
			{ ownerIdentityId: selectedOwnerId },
		);
	} catch (error) {
		// A storage/schema race may fail with the public unavailable error, never a
		// successful false-unlink response or raw SQL exception containing private data.
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/unavailable|upgrade_required/);
		return null;
	}
}

for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	const races = [
		[
			"persisted fact changed with unchanged accepted schema",
			(f: LinkFixture, h: ResolvedHarness) => {
				if (!h.fact) throw new Error("missing fixture fact");
				replaceFacts(f, [{ ...h.fact.resolution, source_review_receipt_id: "raced-fact-receipt" }]);
			},
		],
		[
			"new strong other-owner source requiring opaque evidence recheck",
			(f: LinkFixture) => strongOtherOwner(f),
		],
		[
			"source revocation",
			(f: LinkFixture, h: ResolvedHarness) =>
				sourceController(f, h, "revoked_at='2026-10-02T00:00:00.000Z'"),
		],
		[
			"original receipt mutation",
			(f: LinkFixture, h: ResolvedHarness) =>
				sourceController(f, h, "review_receipt_id='raced-receipt'"),
		],
		[
			"persisted fact removal",
			(f: LinkFixture) => f.db.exec("DROP TABLE coordinator_legacy_owner_resolutions"),
		],
		[
			"current enrollment disabled",
			(f: LinkFixture) =>
				f.db
					.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?")
					.run(signer.deviceId),
		],
		[
			"current raw key changed",
			(f: LinkFixture) =>
				f.db
					.prepare(
						"UPDATE enrolled_devices SET public_key=public_key || ' changed-text' WHERE device_id=?",
					)
					.run(signer.deviceId),
		],
		[
			"current fingerprint changed",
			(f: LinkFixture) =>
				f.db
					.prepare("UPDATE enrolled_devices SET fingerprint=? WHERE device_id=?")
					.run("f".repeat(64), signer.deviceId),
		],
		[
			"current group archived",
			(f: LinkFixture) =>
				f.db
					.prepare("UPDATE groups SET archived_at='2026-10-02T00:00:00.000Z' WHERE group_id=?")
					.run(signer.groupId),
		],
	] as const;
	test.for(races)(
		`${kind}: final consistent read catches %s after preliminary checks`,
		async ([, mutate], { fixture: f }) => {
			// Arrange: execute the mutation immediately before the actual profile-bearing
			// SQL, after all preliminary collector/source awaits have completed.
			const h = await setupResolved(f, kind);
			let afterMutation: ReturnType<typeof databaseSnapshot> | undefined;
			h.finalRead.inject = () => {
				mutate(f, h);
				afterMutation = databaseSnapshot(f);
			};
			// Act
			const result = await readOrUnavailable(f, h);
			// Assert
			expect(h.finalRead.count).toBe(1);
			expect(afterMutation).toBeDefined();
			if (result !== null) expectNoDisclosure(result);
			expect(databaseSnapshot(f)).toEqual(afterMutation);
		},
	);
	test.for(["device_id", "ed25519_key"] as const)(
		`${kind}: final read catches global requester %s revocation`,
		async (subject, { fixture: f }) => {
			// Arrange: compute the actual canonical key outside the synchronous SQL hook,
			// then insert exactly that real tombstone after preliminary source checks.
			const h = await setupResolved(f, kind);
			await revoke(f, subject);
			const row = f.db.prepare("SELECT * FROM coordinator_device_revocations").get() as Record<
				string,
				unknown
			>;
			f.db.exec("DELETE FROM coordinator_device_revocations");
			h.finalRead.inject = () => {
				const entries = Object.entries(row);
				f.db
					.prepare(
						`INSERT INTO coordinator_device_revocations (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
					)
					.run(...entries.map(([, value]) => value));
			};
			// Act
			const result = await readOrUnavailable(f, h);
			// Assert
			expect(h.finalRead.count).toBe(1);
			if (result !== null) expectNoDisclosure(result);
			expect(f.db.prepare("SELECT * FROM coordinator_device_revocations").all()).toEqual([row]);
		},
	);
	test(`${kind}: final read of a disconnected account returns no cached profile but preserves independent owner proof`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		h.finalRead.inject = () => {
			f.db.exec("DELETE FROM coordinator_auth_account_links");
		};
		// Act
		const result = await readOrUnavailable(f, h);
		// Assert
		expect(h.finalRead.count).toBe(1);
		if (result !== null)
			expect(result).toMatchObject({
				state: "owner_confirmed",
				ownerIdentity: selectedOwnerId,
				profileState: "account_unlinked",
				profile: null,
			});
	});
	test(`${kind}: final generation rejoin may show the new verified profile, never the old generation`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		const nextProfile = {
			...safeProfile,
			displayName: "Current Generation A",
			email: "current-a@example.test",
		};
		h.finalRead.inject = () => {
			reconnectTarget(f);
			seedCurrentProfile(f, { attemptId: "successor-attempt", profile: nextProfile });
		};
		// Act
		const result = await readOrUnavailable(f, h);
		// Assert
		expect(h.finalRead.count).toBe(1);
		if (result === null) return;
		expect(JSON.stringify(result.profile)).not.toContain(safeProfile.email);
		if (result.profile !== null) expect(result.profile).toEqual(nextProfile);
	});
	test(`${kind}: a last-moment verified profile write is read consistently without cached email`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupResolved(f, kind);
		h.finalRead.inject = () => {
			f.db.exec(
				"UPDATE coordinator_auth_link_profiles SET display_name='New Verified Name',email='new-verified@example.test'",
			);
		};
		// Act
		const result = await readOrUnavailable(f, h);
		// Assert
		expect(h.finalRead.count).toBe(1);
		if (result === null) return;
		expect(JSON.stringify(result.profile)).not.toContain(safeProfile.email);
		if (result.profile !== null)
			expect(result.profile).toEqual({
				...safeProfile,
				displayName: "New Verified Name",
				email: "new-verified@example.test",
			});
	});
}
