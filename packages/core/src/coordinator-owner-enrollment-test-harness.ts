import { expect, it } from "vitest";
import type { CoordinatorAuthBrowserTransactionStartInput } from "./coordinator-auth-browser-transaction-contract.js";
import { browserConfig, materials } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import type { SchemaFixture } from "./coordinator-owner-enrollment-migration-test-harness.js";

export const OWNER_TABLE = "coordinator_owner_enrollment_attempts";
export const ownerDefinitions = `SELECT type,name,sql FROM sqlite_master WHERE tbl_name = '${OWNER_TABLE}' AND sql IS NOT NULL ORDER BY type,name`;
export const pendingOwner = {
	coordinator_id: "coordinator-a",
	attempt_id: "owner-attempt-a",
	purpose: "owner_enroll",
	origin: "https://coordinator.example.test",
	device_id: "owner-device",
	public_key: CANONICAL_PUBLIC_KEY,
	key_id: EXPECTED_KEY_ID,
	fingerprint: "a".repeat(64),
	issuer: browserConfig.issuer,
	auth_config_revision: browserConfig.revision,
	loopback_redirect: "http://127.0.0.1:4567/complete",
	browser_start_hash: "b".repeat(64),
	state: "pending",
	created_at_ms: NOW,
	expires_at_ms: NOW + 600000,
};
const provenance = {
	account_subject: "dummy-subject",
	identity_id: "identity-a",
	link_id: "link-a",
	link_attempt_id: "legacy-attempt-a",
	link_controller_attestation_id: "controller-a",
	link_auth_config_revision: "c".repeat(64),
	grant_revisions_json: '[{"groupId":"group-a","revision":7}]',
};
export const finalizedOwner = {
	...pendingOwner,
	...provenance,
	state: "finalized",
	browser_transaction_hash: "d".repeat(64),
	confirmation_hash: "e".repeat(64),
	completion_secret_hash: "f".repeat(64),
	final_key_proof_hash: "1".repeat(64),
	loopback_redirect: null,
	finalized_at_ms: NOW + 1,
	binding_id: "binding-a",
	audit_event_id: "audit-a",
	final_outcome_json: '{ "kind": "finalized", "bindingId": "binding-a", "groups": ["group-a"] }',
};
type Value = string | number | null;
export function insertOwner(f: SchemaFixture, row: Record<string, Value> = pendingOwner) {
	const entries = Object.entries(row);
	return f.exec(
		`INSERT INTO ${OWNER_TABLE} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
		...entries.map(([, value]) => value),
	);
}
export function ownerRows(f: SchemaFixture) {
	return f.query(`SELECT * FROM ${OWNER_TABLE} ORDER BY attempt_id`);
}
export type OwnerFixture = SchemaFixture & { store: Store };
export function ownerHarness(fixture: (use: (f: OwnerFixture) => Promise<void>) => Promise<void>) {
	return it.extend<{ fixture: OwnerFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}

// Raw INSERT fixtures test storage shape only; they neither authorize nor create ownership bindings.
export function registerOwnerSchemaTests(test: ReturnType<typeof ownerHarness>) {
	registerOwnerStates(test);
	registerOwnerInvalid(test);
	registerOwnerRetention(test);
	registerOwnerReplacement(test);
	registerOwnerIsolation(test);
}
type OwnerTest = ReturnType<typeof ownerHarness>;
function registerOwnerStates(test: OwnerTest) {
	test.for([
		"pending",
		"browser_claimed",
		"oidc_verified",
		"confirmed",
		"finalized",
		"expired",
		"failed",
		"retired",
	])(
		"accepts state %s with the required pins and provisional nullability",
		async (state, { fixture: f }) => {
			// Arrange
			const row: Record<string, Value> = { ...pendingOwner, state };
			if (["browser_claimed", "oidc_verified", "confirmed"].includes(state))
				row.browser_transaction_hash = "d".repeat(64);
			if (["oidc_verified", "confirmed"].includes(state)) Object.assign(row, provenance);
			if (state === "confirmed")
				Object.assign(row, {
					confirmation_hash: "e".repeat(64),
					completion_secret_hash: "f".repeat(64),
				});
			if (state === "finalized") Object.assign(row, finalizedOwner);
			// Act
			await insertOwner(f, row);
			// Assert
			expect(await ownerRows(f)).toEqual([expect.objectContaining(row)]);
			expect(await f.query(`PRAGMA foreign_key_list(${OWNER_TABLE})`)).toEqual([]);
			expect(await f.query("SELECT * FROM coordinator_device_ownership_bindings")).toEqual([]);
		},
	);
}
function registerOwnerInvalid(test: OwnerTest) {
	const invalidProvisional: Record<string, Value>[] = [
		{ state: "unknown" },
		{ purpose: "signin" },
		{ key_id: "A".repeat(64) },
		{ key_id: "g".repeat(64) },
		{ key_id: `${"a".repeat(63)}\0` },
		{ device_id: " " },
		{ attempt_id: "a\0b" },
		{ public_key: null },
		{ auth_config_revision: "bad" },
		{ account_subject: "dummy-subject" },
		{ state: "browser_claimed" },
		{ state: "oidc_verified", browser_transaction_hash: "d".repeat(64) },
		{ state: "confirmed", ...provenance, browser_transaction_hash: "d".repeat(64) },
		{ final_outcome_json: "{}" },
		{ expires_at_ms: NOW + 600001 },
	];
	test.for(invalidProvisional)(
		"rejects invalid provisional combination %j",
		async (patch, { fixture: f }) => {
			// Arrange
			const row = { ...pendingOwner, ...patch };
			// Act
			const insertion = insertOwner(f, row);
			// Assert
			await expect(insertion).rejects.toThrow();
			expect(await ownerRows(f)).toEqual([]);
		},
	);
	test.for([
		{ loopback_redirect: pendingOwner.loopback_redirect },
		{ final_outcome_json: "[]" },
		{ final_outcome_json: "not-json" },
		{ grant_revisions_json: "{}" },
		{ link_id: null },
		{ account_subject: null },
		{ binding_id: null },
		{ audit_event_id: null },
		{ final_key_proof_hash: null },
		{ finalized_at_ms: NOW + 600000 },
		{ browser_transaction_hash: null },
	])("rejects malformed finalized commitment/outcome %j", async (patch, { fixture: f }) => {
		// Arrange
		const row = { ...finalizedOwner, ...patch };
		// Act
		const insertion = insertOwner(f, row);
		// Assert
		await expect(insertion).rejects.toThrow();
		expect(await ownerRows(f)).toEqual([]);
	});
}
const otherFinalized = {
	...finalizedOwner,
	attempt_id: "owner-attempt-b",
	browser_start_hash: "2".repeat(64),
	browser_transaction_hash: "3".repeat(64),
	completion_secret_hash: "4".repeat(64),
};
const otherConfirmed = {
	...otherFinalized,
	state: "confirmed",
	loopback_redirect: pendingOwner.loopback_redirect,
	finalized_at_ms: null,
	binding_id: null,
	audit_event_id: null,
	final_outcome_json: null,
	final_key_proof_hash: null,
};
function registerOwnerReplacement(test: OwnerTest) {
	for (const mode of ["UPDATE OR REPLACE", "INSERT OR REPLACE"]) {
		test.for([
			"attempt_id",
			"browser_start_hash",
			"browser_transaction_hash",
			"completion_secret_hash",
			"rowid",
		])(
			`${mode} cannot erase a different finalized receipt via %s`,
			async (column, { fixture: f }) => {
				// Arrange: both raw storage fixtures satisfy their state checks before the collision.
				await insertOwner(f, finalizedOwner);
				await insertOwner(f, otherConfirmed);
				const allRows = () => f.query(`SELECT rowid,* FROM ${OWNER_TABLE} ORDER BY rowid`);
				const before = await allRows();
				const receipt = before[0];
				if (!receipt) throw new Error("Missing finalized receipt fixture");
				const collision = receipt[column] as Value;
				const entries = Object.entries({ ...otherConfirmed, [column]: collision });
				// Act
				const replacement =
					mode === "UPDATE OR REPLACE"
						? f.exec(
								`${mode} ${OWNER_TABLE} SET ${column} = ? WHERE attempt_id = ?`,
								collision,
								otherConfirmed.attempt_id,
							)
						: f.exec(
								`${mode} INTO ${OWNER_TABLE} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
								...entries.map(([, value]) => value),
							);
				// Assert: a generic UNIQUE/CHECK failure is not receipt protection.
				await expect(replacement).rejects.toThrow(/owner_enrollment_receipt_immutable/);
				expect(await allRows()).toEqual(before);
			},
		);
	}
	test("a noncolliding confirmed row can finalize without changing an existing receipt", async ({
		fixture: f,
	}) => {
		// Arrange
		await insertOwner(f, finalizedOwner);
		await insertOwner(f, otherConfirmed);
		const before = await ownerRows(f);
		const entries = Object.entries(otherFinalized);
		// Act
		await f.exec(
			`UPDATE ${OWNER_TABLE} SET ${entries.map(([key]) => `${key} = ?`).join(",")} WHERE attempt_id = ?`,
			...entries.map(([, value]) => value),
			otherConfirmed.attempt_id,
		);
		// Assert
		expect(await ownerRows(f)).toEqual([before[0], expect.objectContaining(otherFinalized)]);
	});
}
function registerOwnerRetention(test: OwnerTest) {
	test("finalized receipts reject deletion, mutation and replacement without losing the outcome", async ({
		fixture: f,
	}) => {
		// Arrange
		await insertOwner(f, finalizedOwner);
		const before = await ownerRows(f);
		// Act/Assert
		for (const sql of [
			`DELETE FROM ${OWNER_TABLE}`,
			`UPDATE ${OWNER_TABLE} SET final_outcome_json = '{}'`,
			`INSERT OR REPLACE INTO ${OWNER_TABLE} SELECT * FROM ${OWNER_TABLE}`,
		]) {
			await expect(f.exec(sql)).rejects.toThrow(/owner_enrollment_receipt_immutable/);
			expect(await ownerRows(f)).toEqual(before);
		}
	});
	test("retains the exact finalized outcome and pins through unrelated cleanup", async ({
		fixture: f,
	}) => {
		// Arrange: no ownership record is created by this fixture.
		await f.store.createGroup("group-a");
		await insertOwner(f, finalizedOwner);
		const before = await ownerRows(f);
		// Act
		for (const table of [
			"groups",
			"coordinator_auth_link_attempts",
			"coordinator_auth_sessions",
			"coordinator_auth_link_audit_log",
		])
			await f.exec(`DELETE FROM ${table}`);
		// Assert
		expect(await ownerRows(f)).toEqual(before);
		expect(before[0]).toMatchObject(finalizedOwner);
		expect(before[0]).not.toHaveProperty("completion_secret");
	});
}
function registerOwnerIsolation(test: OwnerTest) {
	test("legacy browser start rejects owner purpose and consume/resolve do not burn inert owner rows", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = materials();
		await f.exec(
			`INSERT INTO coordinator_auth_browser_transactions
 (coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
 VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
			browserConfig.coordinatorId,
			"9".repeat(64),
			"owner_enroll",
			pendingOwner.attempt_id,
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
		// Act
		const start = await f.store.startAuthBrowserTransaction(
			{
				...input,
				purpose: "owner_enroll",
			} as unknown as CoordinatorAuthBrowserTransactionStartInput,
			browserConfig,
		);
		const consume = await f.store.consumeAuthBrowserTransaction(input, browserConfig);
		const resolve = await f.store.resolveAuthLinkBrowserTransaction(
			{ attemptId: pendingOwner.attempt_id, binderHash: input.binderHash },
			browserConfig,
		);
		// Assert
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
	});
}
