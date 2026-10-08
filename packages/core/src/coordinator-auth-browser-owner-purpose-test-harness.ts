import { expect } from "vitest";
import type { SchemaFixture } from "./coordinator-auth-browser-migration-test-harness.js";
import type { CoordinatorAuthBrowserTransactionStartInput } from "./coordinator-auth-browser-transaction-contract.js";
import { browserConfig, materials } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";

export async function assertReservedOwnerPurposeIsolation(f: SchemaFixture & { store: Store }) {
	const input = materials();
	await f.exec(
		`INSERT INTO coordinator_auth_browser_transactions
 (coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
 VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
		browserConfig.coordinatorId,
		"9".repeat(64),
		"owner_enroll",
		"owner-attempt-a",
		input.stateHash,
		input.binderHash,
		browserConfig.issuer,
		browserConfig.revision,
		browserConfig.redirectUri,
		input.nonce,
		input.pkceVerifier,
		NOW,
		NOW + 600000,
	);
	const before = await f.query("SELECT * FROM coordinator_auth_browser_transactions");
	const start = await f.store.startAuthBrowserTransaction(
		{ ...input, purpose: "owner_enroll" } as unknown as CoordinatorAuthBrowserTransactionStartInput,
		browserConfig,
	);
	const consume = await f.store.consumeAuthBrowserTransaction(input, browserConfig);
	const resolve = await f.store.resolveAuthLinkBrowserTransaction(
		{ attemptId: "owner-attempt-a", binderHash: input.binderHash },
		browserConfig,
	);
	expect(start).toEqual({ kind: "rejected", error: "invalid_input" });
	expect(consume).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(resolve).toBeNull();
	expect(await f.query("SELECT * FROM coordinator_auth_browser_transactions")).toEqual(before);
	for (const table of [
		"coordinator_auth_sessions",
		"coordinator_auth_account_links",
		"coordinator_device_ownership_bindings",
	])
		expect(await f.query(`SELECT * FROM ${table}`)).toEqual([]);
}
