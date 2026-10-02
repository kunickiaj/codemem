import { describe, expect } from "vitest";
import { snapshot } from "./coordinator-auth-link-test-fixtures.js";
import {
	backendTest,
	credentialHash,
	expectIssued,
	grants,
	linked,
	linkId,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} account profile smoke`, () => {
		const test = backendTest(backend);
		test("records a display snapshot without changing authority; retries cannot replace it", async ({
			fixture: f,
		}) => {
			// Arrange: reviewed account link and ordinary sign-in, with a fixed fixture clock.
			await linked(f);
			const issued = await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
			expectIssued(issued, f);
			const authority = [grants(f), snapshot(f), sessionRows(f)];
			const profile = { displayName: "Example User" };

			// Act: record minimal verified display metadata and retry with different metadata.
			const recorded = await f.store.recordAuthAccountProfile({ credentialHash, profile }, f.cfg);
			const account = await f.store.readAuthSessionAccount(credentialHash, f.cfg);
			const session = await f.store.readAuthSession(credentialHash, f.cfg);
			const beforeRetry = f.db.prepare("SELECT * FROM coordinator_auth_account_profiles").all();
			const retried = await f.store.recordAuthAccountProfile(
				{ credentialHash, profile: { displayName: "Replacement User" } },
				f.cfg,
			);

			// Assert: profile is display-only and same-session writes preserve the first snapshot.
			expect(recorded).toEqual({ kind: "recorded" });
			expect(session).not.toBeNull();
			if (issued.kind !== "issued") throw new Error("Expected ordinary sign-in to issue a session");
			expect(session).toEqual(issued.session);
			expect(account).toEqual({ session, profile });
			expect(retried).toEqual({ kind: "recorded" });
			expect(f.db.prepare("SELECT * FROM coordinator_auth_account_profiles").all()).toEqual(
				beforeRetry,
			);
			expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toEqual(account);
			expect([grants(f), snapshot(f), sessionRows(f)]).toEqual(authority);
		});

		test("clears only revoked display data while preserving tombstones and receipt proof", async ({
			fixture: f,
		}) => {
			// Arrange: a live session with recorded display metadata.
			await linked(f);
			expectIssued(await f.store.signInWithAuthAccount(signInInput(f), f.cfg), f);
			expect(
				await f.store.recordAuthAccountProfile(
					{ credentialHash, profile: { displayName: "Example User" } },
					f.cfg,
				),
			).toEqual({ kind: "recorded" });
			const input = { linkId: linkId(f) };
			const scope = { coordinatorId: f.cfg.coordinatorId };
			const displayRows = f.db.prepare("SELECT * FROM coordinator_auth_account_profiles").all();

			// Act / Assert: clearing an active account must leave its display snapshot intact.
			expect(await f.store.clearRevokedAuthAccountProfile(input, scope)).toEqual({
				kind: "cleared",
				deletedCount: 0,
			});
			expect(f.db.prepare("SELECT * FROM coordinator_auth_account_profiles").all()).toEqual(
				displayRows,
			);
			expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).not.toBeNull();

			// Act: the existing revoke operation hides the profile without purging display data.
			expect(await f.store.revokeAuthAccountLink(input, scope)).toEqual({ kind: "revoked" });
			expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toBeNull();
			expect(await f.store.readAuthSession(credentialHash, f.cfg)).toBeNull();
			expect(f.db.prepare("SELECT * FROM coordinator_auth_account_profiles").all()).toEqual(
				displayRows,
			);
			const proof = [grants(f), snapshot(f), sessionRows(f)];
			const cleared = await f.store.clearRevokedAuthAccountProfile(input, scope);

			// Assert: explicit purge deletes only display data, not revocation or replay proof.
			expect(cleared).toEqual({ kind: "cleared", deletedCount: 1 });
			expect(f.db.prepare("SELECT * FROM coordinator_auth_account_profiles").all()).toEqual([]);
			expect([grants(f), snapshot(f), sessionRows(f)]).toEqual(proof);
			expect(
				f.db.prepare("SELECT revoked_at_ms FROM coordinator_auth_account_links").get(),
			).toEqual({
				revoked_at_ms: f.now,
			});
			expect(sessionRows(f)[0]).toHaveLength(1);
		});
	});
}
