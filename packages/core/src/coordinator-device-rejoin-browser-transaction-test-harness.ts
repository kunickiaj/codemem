import { expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import {
	claimDeviceRejoinBrowser,
	consumeDeviceRejoinCallback,
} from "./coordinator-device-rejoin-browser-transaction.js";
import { readDeviceRejoinConfirmation } from "./coordinator-device-rejoin-confirmation.js";
import {
	confirmationScope,
	prepareConfirmation,
	type RejoinConfirmationFixture,
} from "./coordinator-device-rejoin-confirmation-test-harness.js";
import { pinVerifiedDeviceRejoinAccount } from "./coordinator-device-rejoin-oidc-pins.js";

type Fixture = RejoinConfirmationFixture & { batch: AuthLinkBackend["batch"] };
const code = new Uint8Array(32).fill(6);
const claimInput = {
	...confirmationScope,
	startCode: encodeCoordinatorAuthProof32(code),
	stateHash: "1".repeat(64),
	nonce: "n".repeat(43),
	pkceVerifier: "v".repeat(43),
};
const callbackInput = { ...claimInput, now: claimInput.now + 1 };

function backend(db: Fixture): AuthLinkBackend {
	return { first: db.first, run: db.changed, batch: db.batch };
}

async function prepare(db: Fixture) {
	await prepareConfirmation(db, { browserStartHash: await hashCoordinatorAuthProofBytes32(code) });
}

function snap(db: Fixture) {
	return db.first({
		sql: `SELECT
 (SELECT state FROM coordinator_device_rejoin_attempts) AS state,
 (SELECT last_order FROM coordinator_auth_account_connection_orders) AS last_order,
 (SELECT json_group_array(json_array(attempt_id, browser_transaction_hash, state, nonce, pkce_verifier, start_order))
 FROM coordinator_auth_browser_transactions WHERE purpose = 'owner_enroll') AS txns`,
		values: [],
	});
}

export function registerRejoinBrowserTransactionTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it("claims one exact transaction and consumes its nonce and PKCE before pinning the account", () =>
		withFixture(async (db) => {
			await prepare(db);
			const b = backend(db);
			const before = await snap(db);
			expect(
				await claimDeviceRejoinBrowser(b, {
					...claimInput,
					startCode: encodeCoordinatorAuthProof32(new Uint8Array(32)),
				}),
			).toBe(false);
			expect(await snap(db)).toEqual(before);
			expect(await claimDeviceRejoinBrowser(b, claimInput)).toBe(true);
			expect(await claimDeviceRejoinBrowser(b, claimInput)).toBe(false);
			for (const drift of [
				{ binderHash: "7".repeat(64) },
				{ stateHash: "7".repeat(64) },
				{ authConfigRevision: "7".repeat(64) },
				{ now: claimInput.now + 600_000 },
			])
				expect(await consumeDeviceRejoinCallback(b, { ...callbackInput, ...drift })).toBeNull();
			const consumed = await consumeDeviceRejoinCallback(b, callbackInput);
			if (consumed?.kind !== "consumed")
				throw new Error("Callback did not consume its transaction");
			expect(consumed).toMatchObject({
				attemptId: claimInput.attemptId,
				transactionHash: claimInput.transactionHash,
				nonce: claimInput.nonce,
				pkceVerifier: claimInput.pkceVerifier,
			});
			expect(await snap(db)).toEqual({
				state: "browser_claimed",
				last_order: 2,
				txns: JSON.stringify([
					[claimInput.attemptId, claimInput.transactionHash, "consumed", null, null, 2],
				]),
			});
			expect(await consumeDeviceRejoinCallback(b, callbackInput)).toBeNull();
			expect(
				await pinVerifiedDeviceRejoinAccount(b, {
					...callbackInput,
					claimToken: consumed.claimToken,
					account: { issuer: claimInput.issuer, subject: "private-subject" },
				}),
			).toBe(true);
			expect(await readDeviceRejoinConfirmation(b, callbackInput)).toMatchObject({
				destinationsJson: '[["group-a",null]]',
			});
		}));

	registerBrowserClaimRefusalTests(withFixture);
}

function registerBrowserClaimRefusalTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it("never adopts a transaction from another ceremony with the same attempt ID", () =>
		withFixture(async (db) => {
			await prepare(db);
			await db.run(
				`INSERT INTO coordinator_auth_browser_transactions
 (coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,
 auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms,start_order)
 VALUES (?,?,'owner_enroll',?,?,?,?,?,?,'pending',?,?,?,?,1)`,
				claimInput.coordinatorId,
				claimInput.transactionHash,
				claimInput.attemptId,
				claimInput.stateHash,
				claimInput.binderHash,
				claimInput.issuer,
				claimInput.authConfigRevision,
				claimInput.redirectUri,
				claimInput.nonce,
				claimInput.pkceVerifier,
				claimInput.now,
				claimInput.now + 599_000,
			);
			const b = backend(db);
			const before = await snap(db);
			expect(await claimDeviceRejoinBrowser(b, claimInput)).toBe(false);
			expect(await consumeDeviceRejoinCallback(b, callbackInput)).toBeNull();
			expect(await snap(db)).toEqual(before);
		}));

	it("rolls back the transaction and order when the attempt claim changes no row", () =>
		withFixture(async (db) => {
			await prepare(db);
			await db.run(`CREATE TRIGGER fixture_skip_browser_claim
 BEFORE UPDATE ON coordinator_device_rejoin_attempts
 WHEN NEW.state = 'browser_claimed' BEGIN SELECT RAISE(IGNORE); END`);
			const before = await snap(db);
			expect(await claimDeviceRejoinBrowser(backend(db), claimInput)).toBe(false);
			expect(await snap(db)).toEqual(before);
		}));
}
