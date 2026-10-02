import { describe, expect } from "vitest";
import * as fixtures from "./coordinator-auth-link-test-fixtures.js";

const { attempt, authorize, backendTest, NOW, TTL } = fixtures;
const secrets = { nonce: "n".repeat(43), pkceVerifier: "p".repeat(43) };
const material = {
	...secrets,
	purpose: "signin" as const,
	stateHash: "1".repeat(64),
	binderHash: "2".repeat(64),
};
const config = (f: fixtures.LinkFixture) => ({
	...f.cfg,
	redirectUri: "https://coordinator.example.test/auth/callback",
});
const row = (f: fixtures.LinkFixture, table = "coordinator_auth_browser_transactions") =>
	f.db.prepare<[], Record<string, unknown>>(`SELECT * FROM ${table}`).get();
const grants = (f: fixtures.LinkFixture) =>
	[
		"coordinator_auth_account_links",
		"coordinator_auth_session_receipts",
		"coordinator_auth_sessions",
	].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
function registerSmoke(test: fixtures.Test) {
	test("signin has TTL and one secret-bearing callback", async ({ fixture: f }) => {
		// Arrange: fresh backend schema and server-owned material.
		const cfg = config(f);
		// Act
		const start = await f.store.startAuthBrowserTransaction(material, cfg);
		const consume = () => f.store.consumeAuthBrowserTransaction(material, cfg);
		const results = await Promise.all([consume(), consume()]);
		const replay = await f.store.consumeAuthBrowserTransaction(material, cfg);
		// Assert: one winner receives secrets; persisted hashes survive secret clearing.
		expect(start).toEqual({ kind: "started", expiresAtMs: NOW + TTL });
		const winners = results.filter((r) => r.kind === "consumed");
		expect(winners).toHaveLength(1);
		expect(winners[0]).toMatchObject(secrets);
		expect(results.filter((r) => r.kind === "rejected")).toEqual([replay]);
		expect(replay).toEqual({ kind: "rejected", error: "transaction_unavailable" });
		expect(row(f)).toMatchObject({
			state: "consumed",
			nonce: null,
			pkce_verifier: null,
			state_hash: material.stateHash,
			binder_hash: material.binderHash,
		});
	});
	test("link keeps deadline, checks binder and grants no access", async ({ fixture: f }) => {
		// Arrange: a pending link already used one minute of its deadline.
		await authorize(f);
		const input = attempt();
		await f.store.createAuthLinkAttempt(input, f.cfg);
		const before = grants(f);
		f.now += 60_000;
		const cfg = config(f);
		const link = { ...material, purpose: "link" as const, attemptId: input.attemptId };
		const resolve = { attemptId: input.attemptId, binderHash: material.binderHash };
		const wrongBinder = { ...resolve, binderHash: "3".repeat(64) };
		// Act
		const start = await f.store.startAuthBrowserTransaction(link, cfg);
		const resolved = await f.store.resolveAuthLinkBrowserTransaction(resolve, cfg);
		const wrong = await f.store.resolveAuthLinkBrowserTransaction(wrongBinder, cfg);
		const consumed = await f.store.consumeAuthBrowserTransaction(material, cfg);
		// Assert: transaction and claim share a generated capability, not an account grant.
		const hash = row(f)?.browser_transaction_hash;
		expect(typeof hash).toBe("string");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(start).toEqual({ kind: "started", expiresAtMs: NOW + TTL });
		expect(row(f)).toMatchObject({ attempt_id: input.attemptId, expires_at_ms: NOW + TTL });
		expect(row(f, "coordinator_auth_link_attempts")).toMatchObject({
			state: "browser_claimed",
			browser_transaction_hash: hash,
			expires_at_ms: NOW + TTL,
		});
		expect(resolved).toEqual({ browserTransactionHash: hash });
		expect(wrong).toBeNull();
		expect(consumed).toEqual({
			...secrets,
			kind: "consumed",
			purpose: "link",
			attemptId: input.attemptId,
			browserTransactionHash: hash,
		});
		expect(grants(f)).toEqual(before);
	});
}

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} browser transaction smoke`, () => registerSmoke(backendTest(backend)));
}
