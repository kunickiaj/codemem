import { env } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";
import { config, input, NOW, seedEnrollmentSql } from "./device-claim-eligibility-fixture.js";

it("native D1 device claim advances, rejects a changed key, and cancels/recreates without authority writes", async () => {
	// Arrange: existing worker-pool setup applies TEST_MIGRATIONS.
	await env.COORDINATOR_DB.batch(seedEnrollmentSql.split(";").map((part) => part.trim()).filter(Boolean).map((part) => env.COORDINATOR_DB.prepare(part)));
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	const request = { authority: { kind: "device_claim" as const, identityId: input.identityId }, signer: input.signer, attemptId: "attempt-a", runtimeVerifierHash: "b".repeat(64), browserStartHash: "e".repeat(64), loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete" };
	const browserConfig = { ...config, redirectUri: "https://coordinator.example.test/auth/callback" };
	const transaction = { purpose: "link" as const, attemptId: request.attemptId, browserStartHash: request.browserStartHash, stateHash: "3".repeat(64), binderHash: "4".repeat(64), nonce: "n".repeat(43), pkceVerifier: "p".repeat(43) };
	const tables = (await env.COORDINATOR_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('_cf_METADATA','coordinator_auth_link_attempts','coordinator_auth_browser_transactions') ORDER BY name").all<{ name: string }>()).results;
	const snapshot = async () => Promise.all(tables.map(async ({ name }) => (await env.COORDINATOR_DB.prepare(`SELECT * FROM "${name}"`).all()).results));
	const before = await snapshot();
	// Act / Assert: trusted metadata, no Google network verification or finalization.
	expect(await store.createAuthLinkAttempt(request, config)).toMatchObject({ kind: "created" });
	expect(await store.startAuthBrowserTransaction(transaction, browserConfig)).toMatchObject({ kind: "started" });
	const bound = await store.resolveAuthLinkBrowserTransaction({ attemptId: request.attemptId, binderHash: transaction.binderHash }, browserConfig);
	if (!bound) throw new Error("device claim browser was not bound");
	const browser = { attemptId: request.attemptId, ...bound };
	expect(await store.recordAuthLinkOidcVerified({ ...browser, account: { issuer: config.issuer, subject: "trusted-test-google-subject" } }, config)).toMatchObject({ kind: "applied", status: { state: "oidc_verified" } });
	expect(await snapshot()).toEqual(before);
	await env.COORDINATOR_DB.prepare("UPDATE enrolled_devices SET public_key=public_key || ' changed' WHERE device_id='device-a'").run();
	expect(await store.confirmAuthLinkAttempt({ ...browser, completionSecretHash: "d".repeat(64) }, config)).toMatchObject({ kind: "rejected" });
	expect(await store.readAuthLinkCompletionDestination(browser, config)).toBeNull();
	await env.COORDINATOR_DB.prepare("UPDATE enrolled_devices SET public_key=? WHERE device_id='device-a'").bind(input.signer.publicKey).run();
	expect(await store.failAuthLinkAttempt({ attemptId: request.attemptId, requester: { kind: "device", signer: input.signer }, reason: "cancelled" }, config)).toMatchObject({ kind: "applied", status: { state: "failed" } });
	expect(await store.createAuthLinkAttempt({ ...request, attemptId: "fresh-attempt", runtimeVerifierHash: "1".repeat(64), browserStartHash: "2".repeat(64) }, config)).toMatchObject({ kind: "created", status: { state: "pending" } });
	expect(await snapshot()).toEqual(before);
	expect((await env.COORDINATOR_DB.prepare("SELECT authority_kind,controller_attestation_id,account_subject FROM coordinator_auth_link_attempts WHERE attempt_id='attempt-a'").all()).results).toEqual([{ authority_kind: "device_claim", controller_attestation_id: null, account_subject: null }]);
});
