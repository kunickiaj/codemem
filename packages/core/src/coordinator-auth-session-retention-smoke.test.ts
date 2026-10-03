import { describe, expect } from "vitest";
import * as browser from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { expectRejected, type LinkFixture } from "./coordinator-auth-link-test-fixtures.js";
import * as sessions from "./coordinator-auth-session-test-fixtures.js";

const RETENTION = 32 * 60 * 60 * 1000;
const purged = (processedCount: number) => ({ kind: "purged", processedCount, more: false });
// Fixed 32-byte hash fixtures, not claims about authenticated requests or CSPRNG quality.
const credentialHash = "a317956f42e8d0bc6195ea724df830c9e2637ab40fd168925c7e304b89d65fa1";
const legacyHash = "b624e8a1930fc75d4926abef813d057c69ea248f301bd5768c92af04e1d7356b";

function authority(f: LinkFixture) {
	const excluded = [
		...sessions.SESSION_TABLES,
		browser.TABLE,
		"coordinator_auth_signin_purge_floors",
	];
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all() as { name: string }[];
	return tables
		.filter(({ name }) => !excluded.includes(name))
		.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
async function guarded(f: LinkFixture) {
	await sessions.linked(f);
	const cfg = { ...f.cfg, redirectUri: "https://coordinator.example.test/auth/callback" };
	const material = browser.materials(71);
	expect(await f.store.startAuthBrowserTransaction(material, cfg)).toMatchObject({
		kind: "started",
	});
	const consumed = await f.store.consumeAuthBrowserTransaction(material, cfg);
	if (consumed.kind !== "consumed") throw new Error("Expected consumed fixture transaction");
	const input = {
		...sessions.signInInput(f),
		credentialHash,
		browserTransactionHash: consumed.browserTransactionHash,
	};
	const before = authority(f);
	sessions.expectIssued(await f.store.signInWithConsumedBrowserTransaction(input, cfg), f);
	expect(authority(f)).toEqual(before);
	expect(sessions.sessionRows(f)[0][0]).toMatchObject({ source: "signin", purge_eligible: 1 });
	return { cfg, input, before, createdAt: f.now };
}
async function purge(f: LinkFixture) {
	return [
		await f.store.purgeAuthGuardedSigninSessions(f.cfg),
		await f.store.purgeAuthGuardedSigninReceipts(f.cfg),
	];
}

// Public store wrappers on both backends; trusted metadata only, no JWS/HTTP cookie claims.
for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} session retention smoke`, () => {
		const test = sessions.backendTest(backend);
		test("guarded cleanup waits 32h and removes sessions before receipts", async ({
			fixture: f,
		}) => {
			// Arrange: reviewed existing link, consumed signin proof, explicit guarded origin.
			const { cfg, input, before, createdAt } = await guarded(f);
			const rows = sessions.sessionRows(f);
			f.now = createdAt + RETENTION - 1;
			// Act / Assert: S3 removes proof first; S4 keeps both rows until the boundary.
			expect(await f.store.purgeAuthSigninBrowserTransactions(f.cfg)).toEqual(purged(1));
			expect(browser.transactionRows(f)).toEqual([]);
			expect(await purge(f)).toEqual([purged(0), purged(0)]);
			expect(sessions.sessionRows(f)).toEqual(rows);
			f.now = createdAt + RETENTION;
			expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg)).toEqual(purged(0));
			expect(sessions.sessionRows(f)).toEqual(rows);
			expect(await purge(f)).toEqual([purged(1), purged(1)]);
			expect(sessions.sessionRows(f)).toEqual([[], []]);
			// Act: rolling time back cannot revive credentials or replace missing proof.
			f.now = createdAt;
			const live = await f.store.readAuthSession(input.credentialHash, cfg);
			const retry = await f.store.signInWithConsumedBrowserTransaction(input, cfg);
			// Assert: cleanup changes metadata only, not account/device/controller authority.
			expect(live).toBeNull();
			expectRejected(retry, "transaction_unavailable");
			expect(sessions.sessionRows(f)).toEqual([[], []]);
			expect(authority(f)).toEqual(before);
		});
		test("legacy signin receipts stay spent after 64h", async ({ fixture: f }) => {
			// Arrange: historical trusted setup is allowed, but never opts into retention.
			await sessions.linked(f);
			const before = authority(f);
			const input = {
				...sessions.signInInput(f),
				browserTransactionHash: legacyHash,
				credentialHash,
			};
			sessions.expectIssued(await f.store.signInWithAuthAccount(input, f.cfg), f);
			const rows = sessions.sessionRows(f);
			expect(rows[0][0]).toMatchObject({ source: "signin", purge_eligible: 0 });
			f.now += RETENTION * 2;
			// Act
			const cleanup = await purge(f);
			const replay = await f.store.signInWithAuthAccount(input, f.cfg);
			// Assert: old trusted replay remains denied and neither row is rewritten.
			expect(cleanup).toEqual([purged(0), purged(0)]);
			expectRejected(replay, "browser_transaction_used");
			expect(sessions.sessionRows(f)).toEqual(rows);
			expect(authority(f)).toEqual(before);
		});
	});
}
