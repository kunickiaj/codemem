import { env } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";
import { consumeSigninProof } from "../../core/src/coordinator-auth-browser-proof-test-fixtures.js";
import { config, input, NOW, seedEnrollmentSql } from "./device-claim-eligibility-fixture.js";

it("native D1 finalizes atomically, rolls back an audit fault, and retains the exact retry receipt", async () => {
	// Arrange: actual migrated D1 batch, trusted provider metadata, no external HTTP.
	await env.COORDINATOR_DB.batch(seedEnrollmentSql.split(";").map((sql) => sql.trim()).filter(Boolean).map((sql) => env.COORDINATOR_DB.prepare(sql)));
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	const request = { authority: { kind: "device_claim" as const, identityId: input.identityId }, signer: input.signer, attemptId: "attempt-a", runtimeVerifierHash: "b".repeat(64), browserStartHash: "e".repeat(64), loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete" };
	const browserConfig = { ...config, redirectUri: "https://coordinator.example.test/auth/callback" };
	const transaction = { purpose: "link" as const, attemptId: request.attemptId, browserStartHash: request.browserStartHash, stateHash: "3".repeat(64), binderHash: "4".repeat(64), nonce: "n".repeat(43), pkceVerifier: "p".repeat(43) };
	expect(await store.createAuthLinkAttempt(request, config)).toMatchObject({ kind: "created" });
	expect(await store.startAuthBrowserTransaction(transaction, browserConfig)).toMatchObject({ kind: "started" });
	const bound = await store.resolveAuthLinkBrowserTransaction({ attemptId: request.attemptId, binderHash: transaction.binderHash }, browserConfig);
	if (!bound) throw new Error("device browser not bound");
	expect(await store.consumeAuthBrowserTransaction({ stateHash: transaction.stateHash, binderHash: transaction.binderHash }, browserConfig)).toMatchObject({ kind: "consumed" });
	const browser = { attemptId: request.attemptId, ...bound };
	expect(await store.recordAuthLinkOidcVerified({ ...browser, account: { issuer: config.issuer, subject: "trusted-test-google-subject" } }, config)).toMatchObject({ kind: "applied" });
	expect(await store.readAuthLinkCompletionDestination(browser, config)).toEqual({ destination: request.loopbackRedirect });
	expect(await store.confirmAuthLinkAttempt({ ...browser, completionSecretHash: "d".repeat(64) }, config)).toMatchObject({ kind: "applied" });
	const proof = { purpose: "coordinator-account-link-v1" as const, coordinatorId: config.coordinatorId, attemptId: request.attemptId, groupId: input.signer.groupId, identityId: input.identityId, deviceId: input.signer.deviceId, fingerprint: input.signer.fingerprint, runtimeVerifierHash: request.runtimeVerifierHash, completionSecretHash: "d".repeat(64), signer: input.signer };
	const tables = ["coordinator_auth_link_attempts", "coordinator_auth_device_claims", "coordinator_auth_account_links", "coordinator_auth_link_audit_log", "enrolled_devices", "coordinator_identity_group_grants"];
	const snapshot = () => Promise.all(tables.map(async (name) => (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${name}`).all()).results));
	await env.COORDINATOR_DB.exec("CREATE TRIGGER finalization_fault BEFORE INSERT ON coordinator_auth_link_audit_log BEGIN SELECT RAISE(ABORT,'injected_finalization_failure'); END");
	const before = await snapshot();
	// Act: a failure late in the real D1 batch must undo attempt consumption, proof and link.
	const failed = await store.finalizeAuthLinkAttempt(proof, config).then(() => null, (error: unknown) => error);
	// Assert
	expect(String(failed)).toMatch(/auth_link_persistence_error|injected_finalization_failure/);
	expect(await snapshot()).toEqual(before);
	await env.COORDINATOR_DB.exec("DROP TRIGGER finalization_fault");
	// Act: identical proof succeeds after rollback, then retries without another INSERT.
	const result = await store.finalizeAuthLinkAttempt(proof, config);
	const committed = await snapshot();
	const retry = await store.finalizeAuthLinkAttempt(proof, config);
	// Assert
	expect(result).toMatchObject({ kind: "applied", status: { state: "finalized" } });
	expect(retry).toEqual({ ...result, kind: "existing" });
	expect(await snapshot()).toEqual(committed);
	const [attempts, claims, links, audits, enrollments, grants] = committed;
	expect(claims).toHaveLength(1);
	expect(links).toHaveLength(1);
	expect(audits).toHaveLength(1);
	expect(links?.[0]).toMatchObject({ authority_kind: "device_claim", device_claim_id: claims?.[0]?.claim_id, controller_attestation_id: null });
	expect(audits?.[0]).toMatchObject({ action: "link_created", device_claim_id: claims?.[0]?.claim_id, link_id: links?.[0]?.link_id });
	expect(attempts?.[0]).toMatchObject({ state: "finalized", link_id: links?.[0]?.link_id });
	expect(enrollments).toEqual(before[4]);
	expect(grants).toEqual(before[5]);
	expect(await store.getAuthLinkAttemptStatus(request.attemptId, { kind: "device", signer: input.signer }, config)).toEqual(result.kind === "applied" ? result.status : null);
	// Act: consume the committed device link through the normal browser session API.
	const credentialHash = "8".repeat(64);
	const redeem = { ...browser, binderHash: transaction.binderHash, credentialHash };
	expect(await store.redeemAuthLinkSessionWithBrowserTransaction({ ...redeem, binderHash: "9".repeat(64) }, browserConfig)).toMatchObject({ kind: "rejected" });
	const issued = await store.redeemAuthLinkSessionWithBrowserTransaction(redeem, browserConfig);
	expect(issued).toMatchObject({ kind: "issued", session: { identityId: input.identityId, linkId: links?.[0]?.link_id, account: { issuer: config.issuer, subject: "trusted-test-google-subject" } } });
	if (issued.kind !== "issued") throw new Error("device link session not issued");
	await consumeSigninProof({ store, cfg: config }, "7".repeat(64), browserConfig);
	const signedIn = await store.signInWithConsumedBrowserTransaction({ browserTransactionHash: "7".repeat(64), credentialHash: "6".repeat(64), account: issued.session.account }, browserConfig);
	expect(signedIn).toMatchObject({ kind: "issued", session: { identityId: issued.session.identityId, linkId: issued.session.linkId, account: issued.session.account } });
	if (signedIn.kind !== "issued") throw new Error("device account signin not issued");
	const profile = { displayName: "Example Person", email: "person@example.test", emailVerified: true };
	expect(await store.recordAuthAccountProfile({ credentialHash: "6".repeat(64), profile }, config)).toEqual({ kind: "recorded" });
	expect(await store.readAuthSession(credentialHash, config)).toEqual(issued.session);
	expect(await store.readAuthSessionAccount(credentialHash, config)).toEqual({ session: issued.session, profile });
	await env.COORDINATOR_DB.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'").run();
	expect(await store.readAuthSession(credentialHash, config)).toEqual(issued.session);
	// Assert: operator revocation removes access, not the immutable proof or link tombstone.
	expect(await store.revokeAuthAccountLink({ linkId: issued.session.linkId }, config)).toEqual({ kind: "revoked" });
	expect(await store.readAuthSessionAccount(credentialHash, config)).toBeNull();
	const revoked = await snapshot();
	expect(revoked[1]).toEqual(claims);
	expect(revoked[2]).toEqual([expect.objectContaining({ link_id: issued.session.linkId, revoked_at_ms: NOW })]);
	expect(revoked[3]).toEqual([audits?.[0], expect.objectContaining({ action: "link_revoked", link_id: issued.session.linkId, device_claim_id: claims?.[0]?.claim_id })]);
	expect(revoked[5]).toEqual(grants);
});
