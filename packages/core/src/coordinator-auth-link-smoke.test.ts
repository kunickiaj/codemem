import { describe, expect, it } from "vitest";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkFinalizeInput,
} from "./coordinator-auth-link.js";
import {
	type Backend,
	enroll,
	type Fixture,
	review,
	setupStore,
} from "./coordinator-auth-store-test-fixtures.js";

const cfgMeta: CoordinatorAuthLinkConfig = {
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.example.test",
	enabled: true,
	revision: "a".repeat(64),
};
const now = 1_791_028_800_000;

// Trusted persistence inputs only; no provider verification or browser sessions.
async function confirmedFlow({ store }: Fixture) {
	const reviewed = review();
	await enroll(store, reviewed);
	expect(await store.createAuthControllerAttestation(reviewed)).toMatchObject({ kind: "created" });
	const { groupId, deviceId, publicKey, fingerprint } = reviewed;
	const signer = { groupId, deviceId, publicKey, fingerprint };
	const enrollment = await store.getEnrollment(signer.groupId, signer.deviceId);
	const input: CoordinatorAuthLinkFinalizeInput = {
		purpose: "coordinator-account-link-v1",
		coordinatorId: cfgMeta.coordinatorId,
		attemptId: "attempt-a",
		identityId: reviewed.identityId,
		groupId,
		deviceId,
		fingerprint,
		runtimeVerifierHash: "b".repeat(64),
		completionSecretHash: "d".repeat(64),
		signer,
	};
	const browser = { attemptId: input.attemptId, browserTransactionHash: "c".repeat(64) };
	const metadata = { attemptId: input.attemptId, expiresAtMs: now + 600_000 };
	const created = await store.createAuthLinkAttempt(
		{
			attemptId: input.attemptId,
			signer,
			runtimeVerifierHash: input.runtimeVerifierHash,
			loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
		},
		cfgMeta,
	);
	const claimed = await store.claimAuthLinkAttempt(browser, cfgMeta);
	const account = { issuer: cfgMeta.issuer, subject: "opaque-subject-a" };
	const verified = await store.recordAuthLinkOidcVerified({ ...browser, account }, cfgMeta);
	const confirmed = await store.confirmAuthLinkAttempt(
		{ ...browser, completionSecretHash: input.completionSecretHash },
		cfgMeta,
	);
	expect(created).toMatchObject({ kind: "created", status: { ...metadata, state: "pending" } });
	expect(claimed).toEqual({ kind: "applied", status: { ...metadata, state: "browser_claimed" } });
	expect(verified).toEqual({
		kind: "applied",
		status: { ...metadata, state: "oidc_verified" },
		target: { identityId: reviewed.identityId, groupId: signer.groupId, deviceId: signer.deviceId },
	});
	expect(confirmed).toEqual({ kind: "applied", status: { ...metadata, state: "confirmed" } });
	return { cfg: cfgMeta, input, metadata, enrollment };
}

for (const backend of ["SQLite", "D1"] as const satisfies readonly Backend[]) {
	const test = it.extend<{ fixture: Fixture }>({
		fixture: async ({ task: _task }, use) => {
			const fixture = setupStore(backend, { authClock: () => now });
			try {
				await use(fixture);
			} finally {
				await fixture.store.close();
				if (fixture.db.open) fixture.db.close();
			}
		},
	});
	describe(`${backend} account-link operations smoke`, () => {
		test("finalizes once, returns only public status on retry, and preserves enrollment", async ({
			fixture,
		}) => {
			// Arrange: an explicitly reviewed existing actor and device key.
			const { cfg, input, metadata, enrollment } = await confirmedFlow(fixture);
			// Act
			const applied = await fixture.store.finalizeAuthLinkAttempt(input, cfg);
			const retry = await fixture.store.finalizeAuthLinkAttempt(input, cfg);
			const status = await fixture.store.getAuthLinkAttemptStatus(
				input.attemptId,
				{ kind: "device", signer: input.signer },
				cfg,
			);
			// Assert: retries cannot duplicate effects or expose browser credentials.
			expect(applied).toEqual({ kind: "applied", status: { ...metadata, state: "finalized" } });
			expect(retry).toEqual({ kind: "existing", status: { ...metadata, state: "finalized" } });
			expect(status).toEqual({ ...metadata, state: "finalized" });
			expect(fixture.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toHaveLength(
				1,
			);
			expect(
				fixture.db.prepare("SELECT * FROM coordinator_auth_link_audit_log").all(),
			).toHaveLength(1);
			expect(await fixture.store.getEnrollment(input.groupId, input.deviceId)).toEqual(enrollment);
		});
		test("rolls back an aborted audit insert and permits a clean retry", async ({ fixture }) => {
			// Arrange: fail only this fixture's audit write, after link insertion.
			const { cfg, input, metadata, enrollment } = await confirmedFlow(fixture);
			fixture.db.exec(`CREATE TEMP TRIGGER smoke_fail_audit BEFORE INSERT ON coordinator_auth_link_audit_log
				WHEN NEW.coordinator_id = 'coordinator-a' AND NEW.attempt_id = 'attempt-a'
				BEGIN SELECT RAISE(ABORT, 'smoke_audit_failure'); END`);
			// Act
			const failed = fixture.store.finalizeAuthLinkAttempt(input, cfg);
			// Assert: the failed transaction consumes nothing.
			await expect(failed).rejects.toThrow("auth_link_persistence_error");
			expect(
				fixture.db.prepare("SELECT state, link_id FROM coordinator_auth_link_attempts").all(),
			).toEqual([{ state: "confirmed", link_id: null }]);
			expect(fixture.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([]);
			expect(fixture.db.prepare("SELECT * FROM coordinator_auth_link_audit_log").all()).toEqual([]);
			// Arrange / Act: remove the injected fault and retry the same commitments.
			fixture.db.exec("DROP TRIGGER smoke_fail_audit");
			const retry = await fixture.store.finalizeAuthLinkAttempt(input, cfg);
			// Assert
			expect(retry).toEqual({ kind: "applied", status: { ...metadata, state: "finalized" } });
			expect(fixture.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toHaveLength(
				1,
			);
			expect(
				fixture.db.prepare("SELECT * FROM coordinator_auth_link_audit_log").all(),
			).toHaveLength(1);
			expect(await fixture.store.getEnrollment(input.groupId, input.deviceId)).toEqual(enrollment);
		});
	});
}
