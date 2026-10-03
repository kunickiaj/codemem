import { describe, expect } from "vitest";
import * as browser from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { expectRejected, snapshot } from "./coordinator-auth-link-test-fixtures.js";
import * as sessions from "./coordinator-auth-session-test-fixtures.js";

// Trusted store metadata only: no JWS or cookie verification.
for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} consumed signin smoke`, () => {
		const test = sessions.backendTest(backend);
		test("issues once without changing authority", async ({ fixture: f }) => {
			// Arrange: reviewed active link and server-owned canonical HTTPS callback material.
			await sessions.linked(f);
			const cfg = { ...f.cfg, redirectUri: "https://coordinator.example.test/auth/callback" };
			const material = browser.materials();
			const authority = [sessions.grants(f), snapshot(f)];
			expect(await f.store.startAuthBrowserTransaction(material, cfg)).toMatchObject({
				kind: "started",
			});
			const consumed = await f.store.consumeAuthBrowserTransaction(material, cfg);
			if (consumed.kind !== "consumed") throw new Error("Expected consumed fixture transaction");
			const input = {
				...sessions.signInInput(f),
				browserTransactionHash: consumed.browserTransactionHash,
			};
			// Act
			const issued = await f.store.signInWithConsumedBrowserTransaction(input, cfg);
			const live = await f.store.readAuthSession(input.credentialHash, cfg);
			const rows = sessions.sessionRows(f);
			const replay = await f.store.signInWithConsumedBrowserTransaction(input, cfg);
			// Assert: receipt, stored credential, and read API refer to the same live session.
			sessions.expectIssued(issued, f);
			if (issued.kind !== "issued") throw new Error("Expected issued fixture session");
			expect(live).toEqual(issued.session);
			expect(rows[0]).toHaveLength(1);
			expect(rows[1]).toHaveLength(1);
			expect(rows[0][0]).toMatchObject({
				source: "signin",
				session_id: issued.session.sessionId,
				browser_transaction_hash: input.browserTransactionHash,
				link_id: issued.session.linkId,
				auth_config_revision: cfg.revision,
				created_at_ms: f.now,
			});
			expectRejected(replay, "browser_transaction_used");
			expect(sessions.sessionRows(f)).toEqual(rows);
			expect([sessions.grants(f), snapshot(f)]).toEqual(authority);
		});
		test("denies mismatched proof; current config accepts older link", async ({ fixture: f }) => {
			// Arrange: current config has a newer revision than the existing reviewed link.
			await sessions.linked(f);
			const cfg = {
				...f.cfg,
				revision: "9".repeat(64),
				redirectUri: "https://coordinator.example.test/auth/callback",
			};
			const material = browser.materials();
			const authority = [sessions.grants(f), snapshot(f)];
			expect(await f.store.startAuthBrowserTransaction(material, cfg)).toMatchObject({
				kind: "started",
			});
			const hash = browser.transactionRows(f)[0].browser_transaction_hash;
			if (typeof hash !== "string") throw new Error("Expected generated fixture browser hash");
			const input = { ...sessions.signInInput(f), browserTransactionHash: hash };
			// Act / Assert: pending proof cannot create either session row.
			expectRejected(
				await f.store.signInWithConsumedBrowserTransaction(input, cfg),
				"transaction_unavailable",
			);
			expect(sessions.sessionRows(f)).toEqual([[], []]);
			const consumed = await f.store.consumeAuthBrowserTransaction(material, cfg);
			expect(consumed).toMatchObject({ kind: "consumed", browserTransactionHash: hash });
			// Act / Assert: redirect, config revision, and purpose must match consumed proof.
			for (const wrong of [
				{ ...cfg, redirectUri: "https://coordinator.example.test/other" },
				{ ...cfg, revision: f.cfg.revision },
			]) {
				expectRejected(
					await f.store.signInWithConsumedBrowserTransaction(input, wrong),
					"transaction_unavailable",
				);
				expect(sessions.sessionRows(f)).toEqual([[], []]);
			}
			f.db.prepare(`UPDATE ${browser.TABLE} SET purpose = 'link', attempt_id = 'attempt-a'`).run();
			expectRejected(
				await f.store.signInWithConsumedBrowserTransaction(input, cfg),
				"transaction_unavailable",
			);
			expect(sessions.sessionRows(f)).toEqual([[], []]);
			expect([sessions.grants(f), snapshot(f)]).toEqual(authority);
			// Act: restoring the correct purpose allows the same unspent proof to issue.
			f.db.prepare(`UPDATE ${browser.TABLE} SET purpose = 'signin', attempt_id = NULL`).run();
			const issued = await f.store.signInWithConsumedBrowserTransaction(input, cfg);
			// Assert: newer current config does not rewrite account, enrollment, or key metadata.
			sessions.expectIssued(issued, f);
			if (issued.kind !== "issued") throw new Error("Expected issued fixture session");
			expect(await f.store.readAuthSession(input.credentialHash, cfg)).toEqual(issued.session);
			expect([sessions.grants(f), snapshot(f)]).toEqual(authority);
		});
	});
}
