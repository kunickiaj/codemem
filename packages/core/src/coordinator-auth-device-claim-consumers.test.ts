import { expect } from "vitest";
import {
	input,
	seedEnrollmentSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { browserConfig, materials } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	attempt,
	backendTest,
	completionHash,
	finalize,
	type LinkFixture,
} from "./coordinator-auth-link-test-fixtures.js";

const account = { issuer: browserConfig.issuer, subject: "trusted-test-google-subject" };
const credentialHash = "8".repeat(64);
const profile = {
	displayName: "Example Person",
	email: "person@example.test",
	emailVerified: true,
};
const request = () =>
	attempt({
		authority: { kind: "device_claim", identityId: input.identityId },
		signer: input.signer,
		browserStartHash: "e".repeat(64),
	});
const proof = () => finalize({ signer: input.signer, fingerprint: input.signer.fingerprint });
const rows = (f: LinkFixture, table: string) =>
	f.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
const authority = (f: LinkFixture) =>
	[
		"enrolled_devices",
		"coordinator_identity_group_grants",
		"coordinator_auth_controller_attestations",
	].map((table) => rows(f, table));
async function linked(f: LinkFixture) {
	f.db.exec(seedEnrollmentSql);
	await f.store.createAuthLinkAttempt(request(), f.cfg);
	const start = {
		...materials(),
		purpose: "link" as const,
		attemptId: "attempt-a",
		browserStartHash: request().browserStartHash,
	};
	await f.store.startAuthBrowserTransaction(start, browserConfig);
	const binder = { attemptId: start.attemptId, binderHash: start.binderHash };
	const bound = await f.store.resolveAuthLinkBrowserTransaction(binder, browserConfig);
	if (!bound) throw new Error("device browser not bound");
	await f.store.consumeAuthBrowserTransaction(start, browserConfig);
	const browser = { attemptId: start.attemptId, ...bound };
	await f.store.recordAuthLinkOidcVerified({ ...browser, account }, f.cfg);
	await f.store.readAuthLinkCompletionDestination(browser, f.cfg);
	await f.store.confirmAuthLinkAttempt({ ...browser, completionSecretHash: completionHash }, f.cfg);
	const before = authority(f);
	expect(await f.store.finalizeAuthLinkAttempt(proof(), f.cfg)).toMatchObject({ kind: "applied" });
	expect(authority(f)).toEqual(before);
	return { ...browser, binderHash: start.binderHash, credentialHash };
}
for (const backend of ["SQLite", "D1"] as const) {
	const test = backendTest(backend);
	test(`${backend} device link redeems only its browser binding and reads the same account`, async ({
		fixture: f,
	}) => {
		// Arrange: fake trusted Google claims; no provider HTTP or client admin onboarding.
		const redeem = await linked(f);
		const before = authority(f);
		// Act / Assert: a wrong binder cannot consume the valid redemption.
		expect(
			await f.store.redeemAuthLinkSessionWithBrowserTransaction(
				{ ...redeem, binderHash: "9".repeat(64) },
				browserConfig,
			),
		).toMatchObject({ kind: "rejected" });
		const issued = await f.store.redeemAuthLinkSessionWithBrowserTransaction(redeem, browserConfig);
		expect(issued).toMatchObject({
			kind: "issued",
			session: {
				identityId: input.identityId,
				account,
				linkId: rows(f, "coordinator_auth_account_links")[0]?.link_id,
			},
		});
		if (issued.kind !== "issued") throw new Error("device link session not issued");
		expect(await f.store.readAuthSession(credentialHash, f.cfg)).toEqual(issued.session);
		expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toEqual({
			session: issued.session,
			profile: {},
		});
		expect(await f.store.readAuthSessionAccount("9".repeat(64), f.cfg)).toBeNull();
		expect(
			await f.store.recordAuthAccountProfile({ credentialHash: "9".repeat(64), profile }, f.cfg),
		).toEqual({ kind: "not_recorded" });
		expect(authority(f)).toEqual(before);
	});
	test(`${backend} account survives device disablement but operator revocation retains proof and blocks replacement`, async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const claims = rows(f, "coordinator_auth_device_claims");
		f.db.exec(
			"UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'; UPDATE coordinator_identity_group_grants SET status='revoked',revoked_at='revoked'",
		);
		const before = authority(f);
		const start = materials(2);
		await f.store.startAuthBrowserTransaction(start, browserConfig);
		const consumed = await f.store.consumeAuthBrowserTransaction(start, browserConfig);
		if (consumed.kind !== "consumed") throw new Error("signin browser not consumed");
		// Act
		const issued = await f.store.signInWithConsumedBrowserTransaction(
			{
				browserTransactionHash: consumed.browserTransactionHash,
				account,
				credentialHash: "7".repeat(64),
			},
			browserConfig,
		);
		// Assert: account access is not continuing device authority.
		expect(issued).toMatchObject({
			kind: "issued",
			session: { identityId: input.identityId, account },
		});
		if (issued.kind !== "issued") throw new Error("device account signin not issued");
		expect(issued.session.linkId).toBe(rows(f, "coordinator_auth_account_links")[0]?.link_id);
		expect(await f.store.readAuthSession("7".repeat(64), f.cfg)).toEqual(issued.session);
		expect(
			await f.store.recordAuthAccountProfile({ credentialHash: "7".repeat(64), profile }, f.cfg),
		).toEqual({ kind: "recorded" });
		expect(await f.store.readAuthSessionAccount("7".repeat(64), f.cfg)).toEqual({
			session: issued.session,
			profile,
		});
		expect(await f.store.finalizeAuthLinkAttempt(proof(), f.cfg)).toMatchObject({
			kind: "rejected",
		});
		expect(await f.store.revokeAuthAccountLink({ linkId: issued.session.linkId }, f.cfg)).toEqual({
			kind: "revoked",
		});
		expect(await f.store.readAuthSession("7".repeat(64), f.cfg)).toBeNull();
		expect(await f.store.readAuthSessionAccount("7".repeat(64), f.cfg)).toBeNull();
		expect(
			await f.store.signInWithAuthAccount(
				{ browserTransactionHash: "6".repeat(64), account, credentialHash: "5".repeat(64) },
				f.cfg,
			),
		).toEqual({ kind: "rejected", error: "account_not_linked" });
		expect(rows(f, "coordinator_auth_device_claims")).toEqual(claims);
		expect(rows(f, "coordinator_auth_account_links")).toEqual([
			expect.objectContaining({ link_id: issued.session.linkId, revoked_at_ms: f.now }),
		]);
		expect(rows(f, "coordinator_auth_link_audit_log")).toEqual([
			expect.objectContaining({ action: "link_created" }),
			expect.objectContaining({
				action: "link_revoked",
				link_id: issued.session.linkId,
				device_claim_id: claims[0]?.claim_id,
			}),
		]);
		expect(authority(f)).toEqual(before);
		f.db.exec("UPDATE enrolled_devices SET enabled=1 WHERE device_id='device-a'");
		expect(
			await f.store.createAuthLinkAttempt({ ...request(), attemptId: "replacement" }, f.cfg),
		).toMatchObject({ kind: "rejected" });
	});
}
